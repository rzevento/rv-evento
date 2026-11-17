-- Bitácora de correos rebotados.
--
-- Problema (2026-11-17): Outlook acepta el correo y lo rechaza segundos después con un aviso
-- («Undeliverable…») que llega a la bandeja del remitente. Make responde ok antes del rechazo, así que
-- la base dejaba como enviadas invitaciones y entradas que nunca llegaron (165 por el bloqueo de la
-- cuenta, «550 5.1.8 bad outbound sender», y 19 direcciones que no existen).
--
-- Cambios:
-- 1. public.email_bounces guarda cada aviso de rebote: a quién, de qué correo (invitación, entrada,
--    recordatorio), por qué y si se liberó el envío para reintentarlo.
-- 2. public.record_email_bounce la llama un escenario de Make que vigila la bandeja del remitente.
--    Recibe el asunto y el cuerpo del aviso, reconoce al invitado y el motivo y, si el rebote no es por
--    una dirección inexistente, libera el envío (sent_at / ticket_sent_at / reminder_sent_at en nulo)
--    para que «Enviar todas las invitaciones» / «Enviar entradas pendientes» lo vuelvan a mandar.
--    Pide una clave guardada en private.bounce_webhook_secret (se carga aparte, no va en el repo).
begin;

create table if not exists public.email_bounces (
  id bigint generated always as identity primary key,
  event_id uuid not null references public.events(id) on delete cascade,
  guest_id uuid references public.guests(id) on delete set null,
  message_id text unique,
  bounced_at timestamptz not null,
  created_at timestamptz not null default now(),
  email text not null,
  kind text not null check (kind in ('invitacion', 'entrada', 'recordatorio', 'otro')),
  reason text not null check (reason in ('cuenta_bloqueada', 'direccion_invalida', 'rechazado')),
  detail text,
  released boolean not null default false
);

create index if not exists email_bounces_event_idx on public.email_bounces(event_id, bounced_at desc);
create index if not exists email_bounces_guest_idx on public.email_bounces(guest_id);

comment on table public.email_bounces is
  'Avisos de correo rebotado. kind: invitacion | entrada | recordatorio | otro. reason: cuenta_bloqueada (Microsoft restringió la cuenta remitente; el destinatario está bien) | direccion_invalida (la dirección no existe: hay que corregirla) | rechazado (el servidor del destinatario lo rechazó). released: se liberó el envío para volver a mandarlo.';

alter table public.email_bounces enable row level security;
drop policy if exists "members can view email bounces" on public.email_bounces;
create policy "members can view email bounces" on public.email_bounces
  for select to authenticated using (public.is_event_member(event_id));
revoke all on public.email_bounces from anon;
grant select on public.email_bounces to authenticated;

create table if not exists private.bounce_webhook_secret (secret text not null check (length(secret) >= 32));
alter table private.bounce_webhook_secret enable row level security;
revoke all on private.bounce_webhook_secret from public, anon, authenticated;

-- Registra un rebote ya interpretado y libera el envío. Un aviso viejo no libera un reenvío posterior:
-- sólo se libera si el envío registrado es anterior al rebote (con 2 minutos de margen, porque sent_at
-- se guarda cuando Make responde y el aviso puede llegar antes).
create or replace function private.apply_email_bounce(
  p_email text, p_kind text, p_reason text, p_bounced_at timestamptz, p_message_id text, p_detail text
) returns json language plpgsql security definer set search_path = '' as $$
declare
  target_event uuid;
  guest_row public.guests;
  was_released boolean := false;
  limit_time timestamptz := coalesce(p_bounced_at, now()) + interval '2 minutes';
begin
  if p_message_id is not null and exists (select 1 from public.email_bounces b where b.message_id = p_message_id) then
    return json_build_object('status', 'duplicate');
  end if;
  select e.id into target_event from public.events e order by e.created_at desc limit 1;
  if target_event is null then return json_build_object('status', 'no_event'); end if;
  select g.* into guest_row from public.guests g
  where g.event_id = target_event and lower(btrim(g.email)) = lower(btrim(p_email)) limit 1;

  if guest_row.id is not null and p_reason <> 'direccion_invalida' then
    if p_kind = 'entrada' then
      update public.invitations i set ticket_sent_at = null
      where i.event_id = target_event and i.guest_id = guest_row.id
        and i.ticket_sent_at is not null and i.ticket_sent_at <= limit_time;
      was_released := found;
    elsif p_kind = 'invitacion' then
      update public.invitations i set status = 'bounced', sent_at = null
      where i.event_id = target_event and i.guest_id = guest_row.id
        and i.sent_at is not null and i.sent_at <= limit_time
        and not exists (select 1 from public.rsvps r where r.event_id = i.event_id and r.guest_id = i.guest_id and r.status <> 'pending');
      was_released := found;
    elsif p_kind = 'recordatorio' then
      update public.invitations i set reminder_sent_at = null
      where i.event_id = target_event and i.guest_id = guest_row.id
        and i.reminder_sent_at is not null and i.reminder_sent_at <= limit_time;
      was_released := found;
    end if;
  end if;

  insert into public.email_bounces(event_id, guest_id, message_id, bounced_at, email, kind, reason, detail, released)
  values (target_event, guest_row.id, p_message_id, coalesce(p_bounced_at, now()), lower(btrim(p_email)), p_kind, p_reason, left(p_detail, 500), was_released);
  return json_build_object('status', 'ok', 'email', lower(btrim(p_email)), 'kind', p_kind, 'reason', p_reason,
    'guest_id', guest_row.id, 'released', was_released);
end;
$$;
revoke all on function private.apply_email_bounce(text, text, text, timestamptz, text, text) from public, anon, authenticated;

-- La llama Make con el asunto y el cuerpo (HTML o texto) de cada aviso de rebote.
create or replace function public.record_email_bounce(
  secret text, subject text, body text, received_at timestamptz default null, message_id text default null
) returns json language plpgsql security definer set search_path = '' as $$
declare
  clean text;
  kind text;
  reason text;
  recipient text;
  target_event uuid;
  server_line text;
begin
  if secret is null or not exists (select 1 from private.bounce_webhook_secret s where s.secret = record_email_bounce.secret) then
    return json_build_object('status', 'forbidden');
  end if;
  clean := left(regexp_replace(replace(replace(coalesce(body, ''), '&nbsp;', ' '), '&#64;', '@'), '<[^>]*>', ' ', 'g'), 60000);

  -- Por el asunto del aviso («Undeliverable: <asunto original>»); si no lo trae (Gmail), por el asunto
  -- original citado en el cuerpo.
  kind := case
    when coalesce(subject, '') ~* 'su entrada' then 'entrada'
    when coalesce(subject, '') ~* 'invitaci' then 'invitacion'
    when coalesce(subject, '') ~* 'recordatorio|nos dar. gusto' then 'recordatorio'
    when clean ~* 'su entrada . reformas fiscales' then 'entrada'
    when clean ~* 'RV Invitaci.n Reformas Fiscales' then 'invitacion'
    when clean ~* 'nos dar. gusto contar con su presencia' then 'recordatorio'
    else 'otro' end;
  reason := case
    when clean ~* '5\.1\.8|bad outbound sender|not recognized as a valid sender|suspected of sending spam' then 'cuenta_bloqueada'
    when clean ~* '5\.1\.1\M|5\.1\.10|5\.4\.1\M|no se encontr|not found|does not exist|doesn''t exist|no existe|user unknown|unknown user|recipient address rejected|mailbox unavailable|address couldn''t be found' then 'direccion_invalida'
    else 'rechazado' end;

  select e.id into target_event from public.events e order by e.created_at desc limit 1;
  -- El destinatario es la primera dirección del aviso que esté en la lista de invitados; si ninguna lo
  -- está, la primera que no sea del sistema de correo ni el propio remitente.
  select m.addr into recipient
  from (select lower(x[1]) as addr, n from regexp_matches(clean, '([A-Za-z0-9._%+''-]+@[A-Za-z0-9-]+(\.[A-Za-z0-9-]+)*\.[A-Za-z]{2,})', 'g') with ordinality as t(x, n)) m
  where m.addr !~ '^(microsoftexchange|postmaster|mailer-daemon|no-?reply|rv_reformasfiscales)'
    and m.addr !~ '\.(prod|outlook)\.'
  order by exists (select 1 from public.guests g where g.event_id = target_event and lower(btrim(g.email)) = m.addr) desc, m.n
  limit 1;
  if recipient is null then return json_build_object('status', 'no_recipient'); end if;

  server_line := coalesce(
    substring(clean from '(?i)(remote server returned[^\n]{0,200})'),
    substring(clean from '(?i)(\m[45]\d\d[ -][45]\.\d{1,3}\.\d{1,3}[^\n]{0,200})'));
  return private.apply_email_bounce(recipient, kind, reason, received_at, nullif(btrim(message_id), ''),
    coalesce(btrim(server_line), left(btrim(regexp_replace(clean, '\s+', ' ', 'g')), 300)));
end;
$$;
revoke all on function public.record_email_bounce(text, text, text, timestamptz, text) from public;
grant execute on function public.record_email_bounce(text, text, text, timestamptz, text) to anon, authenticated;

commit;
