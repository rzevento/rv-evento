-- Bitácora de registros y protección de la entrada.
--
-- Problema: el registro identifica al invitado sólo por su correo o teléfono. Quien no tiene
-- correo o celular propio (o usa el de su asistente, su jefe o la empresa) caía en la invitación
-- de otra persona: submit_rsvp sobrescribía el nombre de ese invitado y le entregaba su QR, y no
-- quedaba ningún rastro de los datos anteriores ni de quienes no estaban en la lista.
--
-- Cambios:
-- 1. public.registration_log guarda cada intento de registro con los datos que se escribieron y,
--    cuando se confirma, los datos que tenía el invitado antes del cambio.
-- 2. begin_rsvp y submit_rsvp sólo entregan/confirman la invitación si el nombre escrito coincide
--    con el del invitado (tolerando acentos, títulos, nombres incompletos y una letra distinta).
--    Si no coincide, o si el correo/teléfono no está en la lista, no se entrega ningún QR y la
--    persona queda en la bitácora como «fuera de la lista» para que el equipo la revise.
-- 3. resolve_registration permite a un administrador resolver desde la bitácora a quien quedó
--    fuera: agregarlo como invitado nuevo o pasarle la invitación con la que intentó registrarse.
begin;

create table if not exists public.registration_log (
  id bigint generated always as identity primary key,
  event_id uuid not null references public.events(id) on delete cascade,
  guest_id uuid references public.guests(id) on delete set null,
  created_at timestamptz not null default now(),
  result text not null check (result in ('confirmado', 'no_encontrado', 'contacto_de_otro', 'contacto_en_uso')),
  submitted_name text,
  submitted_email text,
  submitted_phone text,
  submitted_company text,
  previous_name text,
  previous_email text,
  previous_phone text,
  previous_company text,
  historical boolean not null default false,
  reviewed_at timestamptz,
  reviewed_by uuid references auth.users(id) on delete set null,
  resolution text check (resolution in ('agregado', 'transferido')),
  resolved_guest_id uuid references public.guests(id) on delete set null
);

create index if not exists registration_log_event_idx on public.registration_log(event_id, created_at desc);
create index if not exists registration_log_guest_idx on public.registration_log(guest_id);

comment on table public.registration_log is
  'Bitácora de cada intento de registro público. result: confirmado | no_encontrado (el contacto no está en la lista) | contacto_de_otro (el contacto pertenece a otro invitado y el nombre no coincide) | contacto_en_uso (el correo/teléfono nuevo ya es de otro invitado). resolution: cómo lo resolvió un administrador (agregado como invitado nuevo o transferido: se le pasó la invitación de guest_id).';

alter table public.registration_log enable row level security;

drop policy if exists "members can view registration log" on public.registration_log;
create policy "members can view registration log" on public.registration_log
  for select to authenticated using (public.is_event_member(event_id));

revoke all on public.registration_log from anon;
grant select on public.registration_log to authenticated;

-- Palabras de un nombre sin acentos, signos ni títulos («C.P.», «Lic.», «de», «la»…).
create or replace function private.name_tokens(value text)
returns text[] language sql immutable set search_path = '' as $$
  select coalesce(array_agg(t), '{}'::text[]) from unnest(regexp_split_to_array(
    regexp_replace(
      translate(lower(coalesce(value, '')), 'áàäâãéèëêíìïîóòöôõúùüûñç', 'aaaaaeeeeiiiiooooouuuunc'),
      '[^a-z]+', ' ', 'g'),
    ' ')) as t
  where length(t) >= 2
    and t not in ('lic', 'ing', 'cp', 'dr', 'dra', 'mtro', 'mtra', 'sr', 'sra', 'srta', 'arq', 'act', 'de', 'del', 'la', 'las', 'los', 'y');
$$;

-- Verdadero si a y b difieren a lo más en una letra (cambiada, sobrante o faltante).
create or replace function private.within_one_edit(a text, b text)
returns boolean language plpgsql immutable set search_path = '' as $$
declare
  i int := 1;
  la int := length(a);
  lb int := length(b);
begin
  if a = b then return true; end if;
  if abs(la - lb) > 1 then return false; end if;
  while i <= least(la, lb) and substr(a, i, 1) = substr(b, i, 1) loop i := i + 1; end loop;
  return substr(a, i + 1) = substr(b, i + 1)
      or substr(a, i + 1) = substr(b, i)
      or substr(a, i) = substr(b, i + 1);
end;
$$;

-- ¿El nombre escrito corresponde al invitado registrado? Si el invitado no tiene nombre cargado,
-- cualquiera coincide (su único dato es el contacto). Si no, deben coincidir al menos dos palabras
-- (o todas, si el nombre más corto sólo tiene una), tolerando una letra distinta en palabras de 4+.
create or replace function private.names_match(registered text, submitted text)
returns boolean language plpgsql immutable set search_path = '' as $$
declare
  a text[] := private.name_tokens(registered);
  b text[] := private.name_tokens(submitted);
  shorter text[];
  longer text[];
  matched int := 0;
  t text;
  u text;
begin
  if cardinality(a) = 0 then return true; end if;
  if cardinality(b) = 0 then return false; end if;
  if cardinality(a) <= cardinality(b) then shorter := a; longer := b; else shorter := b; longer := a; end if;
  foreach t in array shorter loop
    foreach u in array longer loop
      if t = u or (least(length(t), length(u)) >= 4 and private.within_one_edit(t, u)) then
        matched := matched + 1;
        exit;
      end if;
    end loop;
  end loop;
  return matched >= least(2, cardinality(shorter));
end;
$$;

-- Inserta en la bitácora. Los intentos fallidos idénticos de los últimos 30 minutos no se repiten
-- (la gente vuelve a intentar varias veces seguidas).
create or replace function private.log_registration(
  target_event_id uuid, target_guest_id uuid, log_result text,
  in_name text, in_email text, in_phone text, in_company text,
  previous public.guests default null
) returns void language plpgsql security definer set search_path = '' as $$
declare
  v_name text := left(nullif(trim(in_name), ''), 200);
  v_email text := left(nullif(trim(in_email), ''), 200);
  v_phone text := left(nullif(trim(in_phone), ''), 60);
  v_company text := left(nullif(trim(in_company), ''), 200);
begin
  if target_event_id is null then return; end if;
  if log_result <> 'confirmado' and exists (
    select 1 from public.registration_log l
    where l.event_id = target_event_id and l.result = log_result
      and l.guest_id is not distinct from target_guest_id
      and lower(coalesce(l.submitted_name, '')) = lower(coalesce(v_name, ''))
      and lower(coalesce(l.submitted_email, '')) = lower(coalesce(v_email, ''))
      and coalesce(l.submitted_phone, '') = coalesce(v_phone, '')
      and l.created_at > now() - interval '30 minutes'
  ) then return; end if;
  insert into public.registration_log(event_id, guest_id, result, submitted_name, submitted_email, submitted_phone, submitted_company,
    previous_name, previous_email, previous_phone, previous_company)
  values (target_event_id, target_guest_id, log_result, v_name, v_email, v_phone, v_company,
    previous.full_name, previous.email, previous.phone, previous.company);
end;
$$;

revoke all on function private.name_tokens(text) from public, anon;
revoke all on function private.within_one_edit(text, text) from public, anon;
revoke all on function private.names_match(text, text) from public, anon;
revoke all on function private.log_registration(uuid, uuid, text, text, text, text, text, public.guests) from public, anon, authenticated;

-- Registro desde la página principal (sin enlace personal). Recibe además el nombre y los datos
-- escritos para comprobar que la invitación es de esa persona y para dejarlo en la bitácora.
drop function if exists public.begin_rsvp(text);
create or replace function public.begin_rsvp(
  guest_contact text,
  guest_name text default null,
  guest_email text default null,
  guest_phone text default null,
  guest_company text default null
) returns json language plpgsql security definer set search_path = '' as $$
declare
  contact text := nullif(trim(guest_contact), '');
  contact_phone text;
  inv public.invitations;
  guest_row public.guests;
  current_status public.rsvp_status;
  active_event uuid;
  has_name boolean := nullif(trim(coalesce(guest_name, '')), '') is not null;
begin
  if contact is null then raise exception 'Guest not found'; end if;
  -- Email addresses must never match guests through empty phone numbers.
  if position('@' in contact) = 0 then
    contact_phone := nullif(regexp_replace(contact, '[^0-9]', '', 'g'), '');
  end if;
  select i.* into inv
  from public.invitations i join public.guests g on g.id = i.guest_id and g.event_id = i.event_id
  where (position('@' in contact) > 0 and lower(trim(g.email)) = lower(contact))
     or (contact_phone is not null and nullif(regexp_replace(g.phone, '[^0-9]', '', 'g'), '') = contact_phone)
  order by i.created_at desc, i.id desc limit 1;

  if inv.id is null then
    select e.id into active_event from public.events e order by e.created_at desc limit 1;
    perform private.log_registration(active_event, null, 'no_encontrado', guest_name,
      coalesce(nullif(trim(guest_email), ''), case when position('@' in contact) > 0 then contact end),
      coalesce(nullif(trim(guest_phone), ''), case when position('@' in contact) = 0 then contact end),
      guest_company);
    return json_build_object('status', 'not_found');
  end if;

  select * into guest_row from public.guests where id = inv.guest_id;
  select status into current_status from public.rsvps where event_id = inv.event_id and guest_id = inv.guest_id;

  -- Sin nombre no se entrega la entrada de alguien ya confirmado.
  if current_status = 'confirmed' and not has_name then
    return json_build_object('status', 'name_required');
  end if;
  if has_name and not private.names_match(guest_row.full_name, guest_name) then
    perform private.log_registration(inv.event_id, inv.guest_id, 'contacto_de_otro', guest_name, guest_email, guest_phone, guest_company, guest_row);
    return json_build_object('status', 'name_mismatch');
  end if;
  return json_build_object('token', inv.token, 'status', case when current_status = 'confirmed' then 'already_registered' else 'pending' end);
end;
$$;
revoke all on function public.begin_rsvp(text, text, text, text, text) from public;
grant execute on function public.begin_rsvp(text, text, text, text, text) to anon, authenticated;

-- Confirmación (enlace personal o página principal). Si el nombre no corresponde al invitado no
-- confirma ni cambia sus datos; si confirma, guarda en la bitácora los datos anteriores.
create or replace function public.submit_rsvp(invitation_token text, guest_name text, guest_email text, guest_phone text, guest_origin text)
returns json language plpgsql security definer set search_path = public as $$
declare
  invitation_row public.invitations;
  guest_row public.guests;
  rsvp_row public.rsvps;
begin
  select * into invitation_row from public.invitations where token = invitation_token;
  if invitation_row.id is null then raise exception 'Invitation not found'; end if;
  select * into guest_row from public.guests where id = invitation_row.guest_id;

  if not private.names_match(guest_row.full_name, guest_name) then
    perform private.log_registration(invitation_row.event_id, guest_row.id, 'contacto_de_otro', guest_name, guest_email, guest_phone, guest_origin, guest_row);
    return json_build_object('event_id', invitation_row.event_id, 'guest_id', guest_row.id, 'status', 'name_mismatch');
  end if;

  begin
    update public.guests set full_name = guest_name, email = guest_email, phone = guest_phone, company = guest_origin
    where id = invitation_row.guest_id;
  exception when unique_violation then
    perform private.log_registration(invitation_row.event_id, guest_row.id, 'contacto_en_uso', guest_name, guest_email, guest_phone, guest_origin, guest_row);
    return json_build_object('event_id', invitation_row.event_id, 'guest_id', guest_row.id, 'status', 'contact_in_use',
      'field', case when sqlerrm like '%guests_event_phone_key%' then 'phone' else 'email' end);
  end;

  insert into public.rsvps (event_id, guest_id, status, submitted_name, submitted_email, submitted_phone, submitted_origin, submitted_at)
  values (invitation_row.event_id, invitation_row.guest_id, 'confirmed', guest_name, guest_email, guest_phone, guest_origin, now())
  on conflict (event_id, guest_id) do update set status = 'confirmed', submitted_name = excluded.submitted_name, submitted_email = excluded.submitted_email, submitted_phone = excluded.submitted_phone, submitted_origin = excluded.submitted_origin, submitted_at = now(), updated_at = now()
  returning * into rsvp_row;

  update public.invitations set opened_at = coalesce(opened_at, now()) where id = invitation_row.id;
  insert into public.activity_log(event_id, guest_id, action, metadata) values (invitation_row.event_id, invitation_row.guest_id, 'rsvp_confirmed', jsonb_build_object('source', 'public_form'));
  perform private.log_registration(invitation_row.event_id, guest_row.id, 'confirmado', guest_name, guest_email, guest_phone, guest_origin, guest_row);
  return json_build_object('event_id', rsvp_row.event_id, 'guest_id', rsvp_row.guest_id, 'status', rsvp_row.status);
end;
$$;
revoke all on function public.submit_rsvp(text, text, text, text, text) from public;
grant execute on function public.submit_rsvp(text, text, text, text, text) to anon, authenticated;

-- Marcar como revisada (o no) una persona de la lista aparte. Sólo administradores.
create or replace function public.mark_registration_reviewed(log_id bigint, reviewed boolean default true)
returns void language plpgsql security definer set search_path = '' as $$
declare
  target_event uuid;
begin
  select event_id into target_event from public.registration_log where id = log_id;
  if target_event is null or not public.is_event_member(target_event)
     or private.event_member_role(target_event) is distinct from 'admin' then
    raise exception 'No tienes permiso para revisar la bitácora' using errcode = '42501';
  end if;
  update public.registration_log
  set reviewed_at = case when reviewed then now() end,
      reviewed_by = case when reviewed then private.organizer_effective_uid(target_event) end
  where id = log_id;
end;
$$;
revoke all on function public.mark_registration_reviewed(bigint, boolean) from public, anon;
grant execute on function public.mark_registration_reviewed(bigint, boolean) to authenticated;

-- Resolver desde la bitácora a alguien que quedó fuera de la lista. Sólo administradores.
-- resolve_mode 'agregar': crea un invitado nuevo con los datos (corregidos por el administrador).
-- resolve_mode 'transferir': la invitación con la que intentó registrarse (guest_id) pasa a ser
-- suya: se cambian nombre y datos del invitado original y su entrada vuelve a enviarse.
-- En ambos casos queda confirmado y en la bitácora como confirmado por el equipo.
create or replace function public.resolve_registration(
  log_id bigint, resolve_mode text,
  guest_name text, guest_email text, guest_phone text, guest_company text
) returns json language plpgsql security definer set search_path = '' as $$
declare
  entry public.registration_log;
  v_name text := left(nullif(trim(guest_name), ''), 200);
  v_email text := left(nullif(trim(guest_email), ''), 200);
  v_phone text := left(nullif(trim(guest_phone), ''), 60);
  v_company text := left(nullif(trim(guest_company), ''), 200);
  v_resolution text;
  previous public.guests;
  target public.guests;
  inv public.invitations;
  actor uuid;
begin
  select * into entry from public.registration_log where id = log_id for update;
  if entry.id is null or not public.is_event_member(entry.event_id)
     or private.event_member_role(entry.event_id) is distinct from 'admin' then
    raise exception 'No tienes permiso para resolver registros' using errcode = '42501';
  end if;
  if resolve_mode not in ('agregar', 'transferir') then
    raise exception 'Modo no válido: %', resolve_mode using errcode = '22023';
  end if;
  if entry.result = 'confirmado' then return json_build_object('status', 'already_confirmed'); end if;
  if entry.resolution is not null then return json_build_object('status', 'already_resolved'); end if;
  if v_name is null then return json_build_object('status', 'name_required'); end if;
  if v_email is null and v_phone is null then return json_build_object('status', 'contact_required'); end if;
  v_resolution := case resolve_mode when 'agregar' then 'agregado' else 'transferido' end;
  actor := private.organizer_effective_uid(entry.event_id);

  if resolve_mode = 'transferir' then
    if entry.guest_id is null then return json_build_object('status', 'no_invitation'); end if;
    select * into previous from public.guests where id = entry.guest_id for update;
    if previous.id is null then return json_build_object('status', 'no_invitation'); end if;
    if exists (select 1 from public.check_ins c where c.guest_id = previous.id) then
      return json_build_object('status', 'already_checked_in');
    end if;
  end if;

  begin
    if resolve_mode = 'agregar' then
      insert into public.guests(event_id, full_name, email, phone, company)
      values (entry.event_id, v_name, v_email, v_phone, v_company) returning * into target;
      insert into public.invitations(event_id, guest_id) values (entry.event_id, target.id) returning * into inv;
    else
      update public.guests set full_name = v_name, email = v_email, phone = v_phone, company = v_company
      where id = previous.id returning * into target;
      -- La entrada se manda de nuevo, ahora a nombre (y correo) de quien la recibe.
      update public.invitations set ticket_sent_at = null where guest_id = target.id returning * into inv;
    end if;
  exception when unique_violation then
    return json_build_object('status', 'contact_in_use',
      'field', case when sqlerrm like '%guests_event_phone_key%' then 'phone' else 'email' end);
  end;

  insert into public.rsvps (event_id, guest_id, status, submitted_name, submitted_email, submitted_phone, submitted_origin, submitted_at)
  values (entry.event_id, target.id, 'confirmed', target.full_name, target.email, target.phone, target.company, now())
  on conflict (event_id, guest_id) do update set status = 'confirmed', submitted_name = excluded.submitted_name, submitted_email = excluded.submitted_email, submitted_phone = excluded.submitted_phone, submitted_origin = excluded.submitted_origin, submitted_at = now(), updated_at = now();
  insert into public.activity_log(event_id, guest_id, action, metadata)
  values (entry.event_id, target.id, 'rsvp_confirmed', jsonb_build_object('source', 'bitacora', 'resolution', v_resolution, 'registration_log_id', entry.id));

  insert into public.registration_log(event_id, guest_id, result, submitted_name, submitted_email, submitted_phone, submitted_company,
    previous_name, previous_email, previous_phone, previous_company, resolution, reviewed_at, reviewed_by)
  values (entry.event_id, target.id, 'confirmado', target.full_name, target.email, target.phone, target.company,
    previous.full_name, previous.email, previous.phone, previous.company, v_resolution, now(), actor);

  -- El registro resuelto y los intentos repetidos de la misma persona quedan resueltos.
  update public.registration_log l
  set resolution = v_resolution, resolved_guest_id = target.id,
      reviewed_at = coalesce(l.reviewed_at, now()), reviewed_by = coalesce(l.reviewed_by, actor)
  where l.event_id = entry.event_id and l.result <> 'confirmado' and l.resolution is null
    and (l.id = entry.id or (
      lower(coalesce(l.submitted_name, '')) = lower(coalesce(entry.submitted_name, ''))
      and lower(coalesce(l.submitted_email, '')) = lower(coalesce(entry.submitted_email, ''))
      and coalesce(l.submitted_phone, '') = coalesce(entry.submitted_phone, '')));

  return json_build_object('status', 'ok', 'guest_id', target.id, 'token', inv.token, 'email', target.email);
end;
$$;
revoke all on function public.resolve_registration(bigint, text, text, text, text, text) from public, anon;
grant execute on function public.resolve_registration(bigint, text, text, text, text, text) to authenticated;

-- Confirmaciones anteriores a la bitácora (sin datos previos, que no se guardaban).
insert into public.registration_log(event_id, guest_id, created_at, result, submitted_name, submitted_email, submitted_phone, submitted_company, historical)
select r.event_id, r.guest_id, r.submitted_at, 'confirmado', r.submitted_name, r.submitted_email, r.submitted_phone, r.submitted_origin, true
from public.rsvps r
where r.submitted_at is not null
  and not exists (select 1 from public.registration_log l where l.guest_id = r.guest_id and l.result = 'confirmado');

commit;
