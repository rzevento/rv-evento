-- Bitácora de invitados eliminados.
--
-- «Eliminar» borraba al invitado y con él su invitación, su respuesta y su llegada, sin dejar rastro.
-- Ahora, antes de borrarlo, se guarda una copia en public.deleted_guests: cuándo se dio de alta, cuándo
-- y quién lo eliminó, el motivo y cómo estaba (invitación enviada, respuesta, llegada).
--
-- Se sigue borrando de public.guests para que no cuente en Pendientes / Confirmados / Cancelaron, que
-- su enlace personal deje de funcionar y que su correo o celular se pueda volver a dar de alta.
--
-- 1. El trigger guests_archive_before_delete guarda la copia en cualquier borrado (panel o SQL).
-- 2. public.delete_guest(target_guest_id, reason) es lo que usa el panel: sólo administradores; deja el
--    motivo en la sesión para que el trigger lo guarde.
begin;

create table if not exists public.deleted_guests (
  id bigint generated always as identity primary key,
  event_id uuid not null references public.events(id) on delete cascade,
  guest_id uuid not null,
  full_name text,
  email text,
  phone text,
  company text,
  created_at timestamptz,
  deleted_at timestamptz not null default now(),
  deleted_by uuid,
  deleted_by_name text,
  reason text,
  invitation_sent_at timestamptz,
  whatsapp_sent_at timestamptz,
  rsvp_status text,
  confirmed_at timestamptz,
  checked_in_at timestamptz,
  snapshot jsonb not null
);

create index if not exists deleted_guests_event_idx on public.deleted_guests(event_id, deleted_at desc);

comment on table public.deleted_guests is
  'Invitados eliminados desde el panel o con SQL. created_at es el alta original; snapshot guarda el invitado, su invitación, su respuesta y su llegada tal como estaban.';

alter table public.deleted_guests enable row level security;
drop policy if exists "members can view deleted guests" on public.deleted_guests;
create policy "members can view deleted guests" on public.deleted_guests
  for select to authenticated using (public.is_event_member(event_id));
revoke all on public.deleted_guests from anon, authenticated;
grant select on public.deleted_guests to authenticated;

-- Corre antes del borrado en cascada, así que todavía ve la invitación, la respuesta y la llegada.
create or replace function private.archive_deleted_guest() returns trigger
language plpgsql security definer set search_path = '' as $$
declare
  inv public.invitations;
  rsvp public.rsvps;
  arrival public.check_ins;
  actor uuid := auth.uid();
  actor_name text;
begin
  select * into inv from public.invitations i where i.guest_id = old.id limit 1;
  select * into rsvp from public.rsvps r where r.guest_id = old.id limit 1;
  select * into arrival from public.check_ins c where c.guest_id = old.id limit 1;
  if actor is not null then
    select coalesce(nullif(m.display_name, ''), m.email) into actor_name
    from public.event_members m where m.event_id = old.event_id and m.user_id = actor;
    if actor_name is null then select u.email into actor_name from auth.users u where u.id = actor; end if;
  end if;
  insert into public.deleted_guests(
    event_id, guest_id, full_name, email, phone, company, created_at, deleted_by, deleted_by_name, reason,
    invitation_sent_at, whatsapp_sent_at, rsvp_status, confirmed_at, checked_in_at, snapshot
  ) values (
    old.event_id, old.id, old.full_name, old.email, old.phone, old.company, old.created_at, actor, actor_name,
    nullif(btrim(current_setting('rv.delete_reason', true)), ''),
    inv.sent_at, inv.whatsapp_sent_at, rsvp.status::text, rsvp.submitted_at, arrival.checked_in_at,
    jsonb_build_object('guest', to_jsonb(old), 'invitation', to_jsonb(inv), 'rsvp', to_jsonb(rsvp), 'check_in', to_jsonb(arrival))
  );
  return old;
end;
$$;

drop trigger if exists guests_archive_before_delete on public.guests;
create trigger guests_archive_before_delete before delete on public.guests
  for each row execute function private.archive_deleted_guest();

create or replace function public.delete_guest(target_guest_id uuid, reason text default null) returns json
language plpgsql security definer set search_path = '' as $$
declare
  v_event uuid;
  v_role text;
begin
  select g.event_id into v_event from public.guests g where g.id = target_guest_id;
  if v_event is null then return json_build_object('status', 'not_found'); end if;
  select m.role into v_role from public.event_members m
  where m.event_id = v_event and m.user_id = private.organizer_effective_uid(v_event);
  if v_role is distinct from 'admin' then
    raise exception 'Solo un administrador puede eliminar invitados' using errcode = '42501';
  end if;
  perform set_config('rv.delete_reason', coalesce(left(btrim(reason), 500), ''), true);
  delete from public.guests g where g.id = target_guest_id;
  perform set_config('rv.delete_reason', '', true);
  return json_build_object('status', 'ok');
end;
$$;

revoke all on function private.archive_deleted_guest() from public, anon, authenticated;
revoke all on function public.delete_guest(uuid, text) from public, anon;
grant execute on function public.delete_guest(uuid, text) to authenticated;

commit;
