-- Registro con el correo de la invitación.
--
-- Problema: desde el enlace personal se podía cambiar el correo por cualquiera (aunque no estuviera
-- en la lista ni existiera); submit_rsvp lo guardaba, confirmaba la asistencia y la entrada se
-- mandaba a esa dirección, que rebotaba.
--
-- Cambio: si el invitado tiene correo registrado, submit_rsvp sólo confirma cuando el correo escrito
-- es el mismo (sin distinguir mayúsculas). Si no, no confirma ni cambia nada, responde
-- status = 'email_mismatch' y deja el intento en la bitácora como «no_encontrado».
-- Si se registra sin escribir correo (sólo teléfono), se conserva el correo de la invitación en vez
-- de borrarlo. Los invitados sólo con teléfono pueden seguir agregando su correo al registrarse.
begin;

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

  -- La invitación es personal: si el invitado tiene correo, sólo se confirma con ese mismo correo.
  -- Antes, desde el enlace personal se podía escribir cualquier correo, se confirmaba y la entrada
  -- se mandaba a esa dirección (que podía ni existir).
  if nullif(trim(guest_row.email), '') is not null and nullif(trim(guest_email), '') is not null
     and lower(trim(guest_row.email)) <> lower(trim(guest_email)) then
    perform private.log_registration(invitation_row.event_id, null, 'no_encontrado', guest_name, guest_email, guest_phone, guest_origin);
    return json_build_object('event_id', invitation_row.event_id, 'guest_id', guest_row.id, 'status', 'email_mismatch');
  end if;

  if not private.names_match(guest_row.full_name, guest_name) then
    perform private.log_registration(invitation_row.event_id, guest_row.id, 'contacto_de_otro', guest_name, guest_email, guest_phone, guest_origin, guest_row);
    return json_build_object('event_id', invitation_row.event_id, 'guest_id', guest_row.id, 'status', 'name_mismatch');
  end if;

  begin
    update public.guests set full_name = guest_name, email = coalesce(nullif(trim(guest_email), ''), guest_row.email), phone = guest_phone, company = guest_origin
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

commit;
