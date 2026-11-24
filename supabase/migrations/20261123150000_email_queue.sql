-- Envíos masivos desde el servidor (cola de correos).
--
-- Problema: «Enviar todas las invitaciones», «Enviar todos los recordatorios» y «Enviar entradas
-- pendientes» los hacía la pestaña del panel, uno cada 15 s. Si la persona cambiaba de página, de
-- pestaña o se bloqueaba la computadora, el envío se frenaba o se cortaba (2026-11-18 21:15).
--
-- Cambios:
-- 1. El panel ya no manda los correos: public.enqueue_bulk_email deja en public.email_queue a los
--    invitados que aplican (un lote en public.email_batches) y regresa en seguida.
-- 2. pg_cron llama cada 15 s a private.kick_email_queue, que (sólo si hay correos en fila) llama por
--    pg_net a la Edge Function process-email-queue.
-- 3. process-email-queue aparta UN correo con public.claim_email_queue_item (que vuelve a revisar que
--    aún aplique y respeta 14 s entre correos para que Outlook no bloquee la cuenta), lo manda a Make
--    (las entradas, por send-ticket) y guarda el resultado con public.finish_email_queue_item.
-- 4. Si Make no confirma un correo, el lote se detiene (como antes en el panel) para no duplicar.
-- 5. public.stop_email_batch detiene un lote y public.email_batch_status da el avance al panel.
begin;

create table if not exists public.email_batches (
  id uuid primary key default gen_random_uuid(),
  event_id uuid not null references public.events(id) on delete cascade,
  kind text not null check (kind in ('invitacion', 'recordatorio', 'entrada')),
  created_by uuid references auth.users(id) on delete set null,
  created_by_name text,
  created_at timestamptz not null default now(),
  stopped_at timestamptz,
  stop_reason text
);

create table if not exists public.email_queue (
  id bigint generated always as identity primary key,
  batch_id uuid not null references public.email_batches(id) on delete cascade,
  event_id uuid not null references public.events(id) on delete cascade,
  guest_id uuid references public.guests(id) on delete set null,
  email text not null,
  position integer not null,
  status text not null default 'queued'
    check (status in ('queued', 'sending', 'sent', 'omitted', 'rejected', 'failed', 'cancelled')),
  detail text,
  started_at timestamptz,
  finished_at timestamptz
);

comment on table public.email_queue is
  'Correos de un envío masivo. status: queued (en fila) | sending (se está mandando) | sent | omitted (ya no aplicaba: ya enviado, ya respondió…) | rejected (problema del invitado: correo mal escrito, sin invitación…) | failed (Make no confirmó; detiene el lote) | cancelled (lote detenido).';

create index if not exists email_queue_active_idx on public.email_queue(event_id, status) where status in ('queued', 'sending');
create index if not exists email_queue_batch_idx on public.email_queue(batch_id, position);
create index if not exists email_queue_started_idx on public.email_queue(started_at desc) where started_at is not null;
create index if not exists email_batches_event_idx on public.email_batches(event_id, created_at desc);

alter table public.email_batches enable row level security;
alter table public.email_queue enable row level security;
drop policy if exists "members can view email batches" on public.email_batches;
create policy "members can view email batches" on public.email_batches
  for select to authenticated using (public.is_event_member(event_id));
drop policy if exists "members can view email queue" on public.email_queue;
create policy "members can view email queue" on public.email_queue
  for select to authenticated using (public.is_event_member(event_id));
revoke all on public.email_batches, public.email_queue from anon, authenticated;
grant select on public.email_batches, public.email_queue to authenticated;

-- Mismo criterio que isValidEmail (src/lib/invitations.ts).
create or replace function private.is_valid_email(value text) returns boolean
language sql immutable set search_path = '' as $$
  select coalesce(btrim(value) ~ '^[^\s@]+@[^\s@]+\.[^\s@]+$'
    and position('..' in btrim(value)) = 0
    and btrim(value) !~ '(^\.|\.@|@\.|\.$)', false);
$$;

-- Clave que comparten el cron y la Edge Function, y la dirección de la función.
create table if not exists private.email_queue_config (
  id boolean primary key default true check (id),
  function_url text,
  secret text not null check (length(secret) >= 32)
);
alter table private.email_queue_config enable row level security;
revoke all on private.email_queue_config from public, anon, authenticated;
insert into private.email_queue_config(function_url, secret)
values ('https://mezagevywxydmjcucxej.supabase.co/functions/v1/process-email-queue',
        replace(gen_random_uuid()::text || gen_random_uuid()::text, '-', ''))
on conflict (id) do nothing;

create or replace function private.check_email_queue_secret(p_secret text) returns void
language plpgsql stable security definer set search_path = '' as $$
begin
  if p_secret is null or not exists (select 1 from private.email_queue_config c where c.secret = p_secret) then
    raise exception 'Clave de la cola de correos no válida' using errcode = '42501';
  end if;
end;
$$;

-- Rol de quien opera el panel (respeta «Ver como usuario»): invitaciones y recordatorios admin/líder,
-- entradas sólo admin, igual que los botones.
create or replace function private.require_bulk_email_role(target_event_id uuid, p_kind text) returns uuid
language plpgsql stable security definer set search_path = '' as $$
declare v_user uuid := private.organizer_effective_uid(target_event_id); v_role text;
begin
  select m.role into v_role from public.event_members m where m.event_id = target_event_id and m.user_id = v_user;
  if v_role is null or v_role not in ('admin', 'leader') or (p_kind = 'entrada' and v_role <> 'admin') then
    raise exception 'No tienes permiso para enviar estos correos' using errcode = '42501';
  end if;
  return v_user;
end;
$$;

-- Deja en fila a todos los que aplican (mismos criterios que los botones del panel).
create or replace function public.enqueue_bulk_email(target_event_id uuid, p_kind text) returns json
language plpgsql security definer set search_path = '' as $$
declare
  v_user uuid;
  v_name text;
  v_batch uuid;
  v_total integer;
  v_queued integer;
begin
  if p_kind is null or p_kind not in ('invitacion', 'recordatorio', 'entrada') then
    raise exception 'Tipo de envío no válido' using errcode = '22023';
  end if;
  v_user := private.require_bulk_email_role(target_event_id, p_kind);
  perform pg_advisory_xact_lock(hashtext('rv_email_queue'));
  if exists (select 1 from public.email_queue q where q.event_id = target_event_id and q.status in ('queued', 'sending')) then
    return json_build_object('status', 'busy');
  end if;

  select coalesce(nullif(btrim(m.display_name), ''), m.email) into v_name
  from public.event_members m where m.event_id = target_event_id and m.user_id = v_user;
  insert into public.email_batches(event_id, kind, created_by, created_by_name)
  values (target_event_id, p_kind, auth.uid(), v_name) returning id into v_batch;

  insert into public.email_queue(batch_id, event_id, guest_id, email, position, status, detail, finished_at)
  select v_batch, target_event_id, g.id, btrim(g.email),
    row_number() over (order by g.created_at desc, g.id),
    case when private.is_valid_email(g.email) then 'queued' else 'rejected' end,
    case when private.is_valid_email(g.email) then null else 'correo mal escrito; corrígelo con «Editar» y vuelve a enviar' end,
    case when private.is_valid_email(g.email) then null else now() end
  from public.guests g
  left join public.invitations i on i.event_id = g.event_id and i.guest_id = g.id
  left join public.rsvps r on r.event_id = g.event_id and r.guest_id = g.id
  where g.event_id = target_event_id
    and coalesce(btrim(g.email), '') <> ''
    and case p_kind
      when 'invitacion' then i.sent_at is null and i.status is distinct from 'sent' and i.whatsapp_sent_at is null
      when 'recordatorio' then (i.sent_at is not null or i.status = 'sent')
        and coalesce(r.status::text, 'pending') = 'pending' and i.reminder_sent_at is null
      else i.id is not null and r.status = 'confirmed' and i.ticket_sent_at is null
    end;
  get diagnostics v_total = row_count;

  if v_total = 0 then
    delete from public.email_batches b where b.id = v_batch;
    return json_build_object('status', 'empty');
  end if;
  select count(*) into v_queued from public.email_queue q where q.batch_id = v_batch and q.status = 'queued';
  insert into public.activity_log(event_id, action, actor_id, metadata)
  values (target_event_id, 'bulk_email_queued', auth.uid(), jsonb_build_object(
    'batch_id', v_batch, 'kind', p_kind, 'subject_id', v_user, 'session_id', private.request_impersonation_id(),
    'total', v_total, 'queued', v_queued));
  return json_build_object('status', 'ok', 'batch_id', v_batch, 'total', v_total, 'queued', v_queued, 'rejected', v_total - v_queued);
end;
$$;

-- Detiene un lote: lo que esté en fila se cancela; el correo que se esté mandando termina.
create or replace function public.stop_email_batch(target_batch_id uuid) returns json
language plpgsql security definer set search_path = '' as $$
declare b public.email_batches; v_cancelled integer;
begin
  select * into b from public.email_batches where id = target_batch_id;
  if b.id is null then raise exception 'Envío no encontrado' using errcode = 'P0002'; end if;
  perform private.require_bulk_email_role(b.event_id, b.kind);
  perform pg_advisory_xact_lock(hashtext('rv_email_queue'));
  update public.email_queue q set status = 'cancelled', detail = 'envío detenido', finished_at = now()
  where q.batch_id = b.id and q.status = 'queued';
  get diagnostics v_cancelled = row_count;
  update public.email_batches set stopped_at = coalesce(stopped_at, now()), stop_reason = coalesce(stop_reason, 'Envío detenido desde el panel.')
  where id = b.id;
  insert into public.activity_log(event_id, action, actor_id, metadata)
  values (b.event_id, 'bulk_email_stopped', auth.uid(), jsonb_build_object('batch_id', b.id, 'cancelled', v_cancelled));
  return json_build_object('status', 'ok', 'cancelled', v_cancelled);
end;
$$;

-- Avance del último lote del evento, para el aviso del panel.
create or replace function public.email_batch_status(target_event_id uuid) returns json
language plpgsql stable security definer set search_path = '' as $$
declare b public.email_batches; counts json; problems json; last_activity timestamptz;
begin
  if not public.is_event_member(target_event_id) then
    raise exception 'No tienes acceso a este evento' using errcode = '42501';
  end if;
  select * into b from public.email_batches where event_id = target_event_id order by created_at desc limit 1;
  if b.id is null then return null; end if;
  select json_build_object(
      'total', count(*),
      'queued', count(*) filter (where status = 'queued'),
      'sending', count(*) filter (where status = 'sending'),
      'sent', count(*) filter (where status = 'sent'),
      'omitted', count(*) filter (where status = 'omitted'),
      'rejected', count(*) filter (where status = 'rejected'),
      'failed', count(*) filter (where status = 'failed'),
      'cancelled', count(*) filter (where status = 'cancelled')),
    max(greatest(started_at, finished_at))
  into counts, last_activity
  from public.email_queue where batch_id = b.id;
  select coalesce(json_agg(json_build_object('email', q.email, 'status', q.status, 'detail', q.detail) order by q.position), '[]'::json)
  into problems from public.email_queue q where q.batch_id = b.id and q.status in ('rejected', 'failed');
  return json_build_object(
    'id', b.id, 'kind', b.kind, 'created_at', b.created_at, 'created_by_name', b.created_by_name,
    'stopped_at', b.stopped_at, 'stop_reason', b.stop_reason, 'last_activity', last_activity,
    'counts', counts, 'problems', problems);
end;
$$;

-- Un correo que se quedó «mandándose» o que Make no confirmó: se marca y se detiene su lote.
create or replace function private.fail_email_queue_item(p_item bigint, p_detail text) returns void
language plpgsql security definer set search_path = '' as $$
declare v_batch uuid;
begin
  update public.email_queue set status = 'failed', detail = p_detail, finished_at = now()
  where id = p_item returning batch_id into v_batch;
  update public.email_queue set status = 'cancelled', detail = 'envío detenido por el error anterior', finished_at = now()
  where batch_id = v_batch and status = 'queued';
  update public.email_batches set stopped_at = coalesce(stopped_at, now()), stop_reason = coalesce(stop_reason, p_detail)
  where id = v_batch;
end;
$$;

-- La Edge Function aparta el siguiente correo. Vuelve a revisar que aún aplique (pudo responder,
-- corregirse el correo o mandarse a mano mientras esperaba) y deja 14 s desde el último correo.
create or replace function public.claim_email_queue_item(p_secret text) returns json
language plpgsql security definer set search_path = '' as $$
declare
  item public.email_queue;
  v_kind text;
  guest_row public.guests;
  inv public.invitations;
  rsvp_status text;
  v_outcome text;
  v_reason text;
begin
  perform private.check_email_queue_secret(p_secret);
  perform pg_advisory_xact_lock(hashtext('rv_email_queue'));

  -- La función se cayó a medio envío: no se sabe si salió, así que se detiene el lote.
  for item in select * from public.email_queue where status = 'sending' and started_at < now() - interval '3 minutes' loop
    perform private.fail_email_queue_item(item.id, item.email || ': no se confirmó el envío (la función no respondió). Revisa el historial de Make antes de volver a enviar.');
  end loop;
  if exists (select 1 from public.email_queue where status = 'sending') then
    return json_build_object('result', 'busy');
  end if;
  if exists (select 1 from public.email_queue where started_at > now() - interval '14 seconds') then
    return json_build_object('result', 'wait');
  end if;

  loop
    select q.* into item from public.email_queue q join public.email_batches b on b.id = q.batch_id
    where q.status = 'queued' order by b.created_at, q.position limit 1 for update of q skip locked;
    if item.id is null then return json_build_object('result', 'idle'); end if;
    select b.kind into v_kind from public.email_batches b where b.id = item.batch_id;
    guest_row := null; inv := null; rsvp_status := null;
    select * into guest_row from public.guests g where g.id = item.guest_id;
    select * into inv from public.invitations i where i.event_id = item.event_id and i.guest_id = item.guest_id;
    select r.status::text into rsvp_status from public.rsvps r where r.event_id = item.event_id and r.guest_id = item.guest_id;

    v_outcome := 'rejected';
    v_reason := case
      when guest_row.id is null then 'el invitado se eliminó'
      when coalesce(btrim(guest_row.email), '') = '' then 'Este invitado no tiene correo electrónico'
      when not private.is_valid_email(guest_row.email) then 'correo mal escrito; corrígelo con «Editar» y vuelve a enviar'
      when inv.id is null then 'Este invitado no tiene una invitación asociada al evento'
    end;
    if v_reason is null then
      v_outcome := 'omitted';
      v_reason := case v_kind
        when 'invitacion' then case
          when inv.sent_at is not null or inv.status = 'sent' then 'ya se había enviado'
          when inv.whatsapp_sent_at is not null then 'ya se envió por WhatsApp' end
        when 'recordatorio' then case
          when inv.sent_at is null and inv.status is distinct from 'sent' then 'la invitación ya no está enviada'
          when coalesce(rsvp_status, 'pending') <> 'pending' then 'ya respondió'
          when inv.reminder_sent_at is not null then 'ya tenía recordatorio' end
        else case
          when rsvp_status is distinct from 'confirmed' then 'ya no está confirmado'
          when inv.ticket_sent_at is not null then 'ya tenía su entrada' end
      end;
    end if;
    if v_reason is not null then
      update public.email_queue set status = v_outcome, detail = v_reason, finished_at = now() where id = item.id;
      continue;
    end if;

    update public.email_queue set status = 'sending', started_at = now(), email = btrim(guest_row.email) where id = item.id;
    return json_build_object('result', 'claimed', 'id', item.id, 'kind', v_kind, 'email', btrim(guest_row.email),
      'full_name', guest_row.full_name, 'invitation_id', inv.id, 'token', inv.token);
  end loop;
end;
$$;

-- Resultado del correo apartado. Al enviarse, marca la invitación o el recordatorio como enviados
-- (la entrada la marca send-ticket).
create or replace function public.finish_email_queue_item(p_secret text, p_item bigint, p_outcome text, p_detail text default null) returns json
language plpgsql security definer set search_path = '' as $$
declare item public.email_queue; b public.email_batches;
begin
  perform private.check_email_queue_secret(p_secret);
  if p_outcome is null or p_outcome not in ('sent', 'omitted', 'rejected', 'failed') then
    raise exception 'Resultado no válido' using errcode = '22023';
  end if;
  select * into item from public.email_queue where id = p_item for update;
  if item.id is null or item.status <> 'sending' then return json_build_object('result', 'not_sending'); end if;
  select * into b from public.email_batches where id = item.batch_id;

  if p_outcome = 'failed' then
    perform private.fail_email_queue_item(item.id, coalesce(p_detail, item.email || ': no se confirmó el envío. Revisa el historial de Make antes de volver a enviar.'));
    return json_build_object('result', 'ok');
  end if;
  update public.email_queue set status = p_outcome, detail = p_detail, finished_at = now() where id = item.id;
  if p_outcome = 'sent' then
    if b.kind = 'invitacion' then
      update public.invitations set status = 'sent', sent_at = now() where event_id = item.event_id and guest_id = item.guest_id;
    elsif b.kind = 'recordatorio' then
      update public.invitations set reminder_sent_at = now() where event_id = item.event_id and guest_id = item.guest_id;
    end if;
    insert into public.activity_log(event_id, guest_id, action, actor_id, metadata)
    values (item.event_id, item.guest_id, 'bulk_email_sent', b.created_by, jsonb_build_object('batch_id', b.id, 'kind', b.kind, 'email', item.email));
  end if;
  return json_build_object('result', 'ok');
end;
$$;

revoke all on function private.is_valid_email(text), private.check_email_queue_secret(text),
  private.require_bulk_email_role(uuid, text), private.fail_email_queue_item(bigint, text) from public, anon, authenticated;
revoke all on function public.enqueue_bulk_email(uuid, text), public.stop_email_batch(uuid), public.email_batch_status(uuid),
  public.claim_email_queue_item(text), public.finish_email_queue_item(text, bigint, text, text) from public, anon, authenticated;
grant execute on function public.enqueue_bulk_email(uuid, text), public.stop_email_batch(uuid), public.email_batch_status(uuid) to authenticated;
grant execute on function public.claim_email_queue_item(text), public.finish_email_queue_item(text, bigint, text, text) to service_role;

-- Cron: cada 15 s, sólo si hay correos en fila, despierta a la Edge Function.
create extension if not exists pg_net with schema extensions;
create extension if not exists pg_cron;

create or replace function private.kick_email_queue() returns void
language plpgsql security definer set search_path = '' as $$
declare cfg private.email_queue_config;
begin
  if not exists (select 1 from public.email_queue where status in ('queued', 'sending')) then return; end if;
  select * into cfg from private.email_queue_config limit 1;
  if cfg.function_url is null then return; end if;
  perform net.http_post(
    url := cfg.function_url,
    body := jsonb_build_object('secret', cfg.secret),
    headers := jsonb_build_object('Content-Type', 'application/json'),
    timeout_milliseconds := 90000);
end;
$$;
revoke all on function private.kick_email_queue() from public, anon, authenticated;

select cron.unschedule(jobid) from cron.job where jobname = 'rv-email-queue';
select cron.schedule('rv-email-queue', '15 seconds', 'select private.kick_email_queue()');

commit;
