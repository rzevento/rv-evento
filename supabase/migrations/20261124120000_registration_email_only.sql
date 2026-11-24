-- Registro: la única llave es el correo.
--
-- Decisión del equipo organizador (2026-11-24): si el correo está en la lista de invitados, la persona
-- se registra con el nombre, teléfono y empresa que escriba y la entrada sale a ese nombre. Ya no se
-- compara el nombre escrito con el nombre guardado ni con el correo (private.registrant_check): esa
-- comparación rechazó a invitados legítimos (p. ej. «Diana Maribel Aceves Martin» con
-- info@syon-capital.com). El único rechazo es «el correo no está en la lista».
--
-- Consecuencias que se aceptan:
--   · Quien conozca el correo de un invitado puede registrarse con él; el último registro es el que vale
--     (una invitación = una entrada). Cada registro queda en la bitácora con los datos anteriores.
--   · Si el teléfono escrito ya es de otro invitado, no se rechaza: se confirma y el teléfono del
--     invitado se queda como estaba (el escrito queda en la confirmación y en la bitácora).
begin;

create or replace function public.begin_rsvp(
  guest_contact text,
  guest_name text default null,
  guest_email text default null,
  guest_phone text default null,
  guest_company text default null
) returns json language plpgsql security definer set search_path = '' as $$
declare
  contact text := lower(nullif(trim(guest_contact), ''));
  inv public.invitations;
  current_status public.rsvp_status;
  active_event uuid;
begin
  if contact is null then raise exception 'Guest not found'; end if;
  if position('@' in contact) > 0 then
    select i.* into inv
    from public.invitations i join public.guests g on g.id = i.guest_id and g.event_id = i.event_id
    where lower(trim(g.email)) = contact
    order by i.created_at desc, i.id desc limit 1;
  end if;

  if inv.id is null then
    select e.id into active_event from public.events e order by e.created_at desc limit 1;
    perform private.log_registration(active_event, null, 'no_encontrado', guest_name,
      coalesce(nullif(trim(guest_email), ''), case when position('@' in contact) > 0 then contact end),
      coalesce(nullif(trim(guest_phone), ''), case when position('@' in contact) = 0 then contact end),
      guest_company);
    return json_build_object('status', 'not_found');
  end if;

  select status into current_status from public.rsvps where event_id = inv.event_id and guest_id = inv.guest_id;
  return json_build_object('token', inv.token, 'status', case when current_status = 'confirmed' then 'already_registered' else 'pending' end);
end;
$$;
revoke all on function public.begin_rsvp(text, text, text, text, text) from public;
grant execute on function public.begin_rsvp(text, text, text, text, text) to anon, authenticated;

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

  -- La llave es el correo: la invitación sólo se confirma con el correo con que está en la lista.
  if nullif(trim(guest_row.email), '') is not null and nullif(trim(guest_email), '') is not null
     and lower(trim(guest_row.email)) <> lower(trim(guest_email)) then
    perform private.log_registration(invitation_row.event_id, null, 'no_encontrado', guest_name, guest_email, guest_phone, guest_origin);
    return json_build_object('event_id', invitation_row.event_id, 'guest_id', guest_row.id, 'status', 'email_mismatch');
  end if;

  -- El invitado queda con los datos que escribió quien se registra.
  begin
    update public.guests set full_name = guest_name, email = coalesce(nullif(trim(guest_row.email), ''), nullif(trim(guest_email), '')), phone = guest_phone, company = guest_origin
    where id = invitation_row.guest_id;
  exception when unique_violation then
    -- El teléfono (o el correo, si el invitado no tenía) ya es de otro invitado: no se rechaza,
    -- se conserva el contacto que tenía.
    update public.guests set full_name = guest_name, company = guest_origin where id = invitation_row.guest_id;
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

commit;
