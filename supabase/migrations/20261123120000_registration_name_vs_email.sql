-- Invitaciones sin nombre: el nombre escrito debe parecerse al correo de la invitación.
--
-- Problema: casi todos los invitados se cargaron sólo con su correo. Con el invitado sin nombre,
-- private.names_match acepta cualquier nombre, así que quien conociera el correo se quedaba con la
-- invitación. Caso real (2026-11-20): la invitación de sofia.chavez@galex.com.mx la confirmó
-- «Laura Margarita Vázquez León» y quedó a su nombre.
--
-- Cambio: si el invitado no tiene nombre pero sí correo, el nombre escrito tiene que parecerse al
-- correo (ver private.name_fits_email: «Juan Salcedo» → jsalcedo@ sí; «Laura Vázquez» →
-- sofia.chavez@ no). Si no se parece, no se confirma ni se entrega entrada: queda en la bitácora como
-- «contacto_de_otro» para que el equipo la revise («Pasarle la invitación» o «Agregar como invitado»)
-- y la página responde status = 'name_review'. Los invitados con nombre siguen con names_match y los
-- que sólo tienen teléfono se aceptan como antes.
begin;

-- ¿El nombre escrito se parece al correo (parte antes de la @)? Se acepta si:
--   · el correo es de un área y no de una persona (contabilidad@, contralor@, fiscal@, auxiliar.d@…);
--   · una palabra del nombre (3+ letras) aparece en el correo («Juan Salcedo» → jsalcedo@);
--   · una palabra del correo es el inicio de una palabra del nombre («Adriana» → adri_ss@) o difiere
--     en una letra («Sevin» → d_servin@);
--   · el correo empieza con las iniciales de las dos primeras palabras («Javier Ortega» → joh@) o trae
--     tres iniciales seguidas («Norma Alicia Guerrero Núñez» → laluna_nagn@);
--   · el correo no tiene letras suficientes para comparar.
-- Medido el 2026-11-23 con las 149 confirmaciones de invitaciones sin nombre: deja ~10 para revisión,
-- entre ellas las 3 en que alguien usó la invitación de otra persona.
create or replace function private.name_fits_email(email text, submitted text)
returns boolean language plpgsql immutable set search_path = '' as $$
declare
  local_part text := translate(lower(split_part(coalesce(email, ''), '@', 1)), 'áàäâãéèëêíìïîóòöôõúùüûñç', 'aaaaaeeeeiiiiooooouuuunc');
  letters text := regexp_replace(local_part, '[^a-z]+', '', 'g');
  words text[] := array(select w from unnest(regexp_split_to_array(regexp_replace(local_part, '[^a-z]+', ' ', 'g'), ' ')) w where length(w) >= 3);
  tokens text[] := private.name_tokens(submitted);
  initials text := array_to_string(array(select left(t, 1) from unnest(private.name_tokens(submitted)) with ordinality as x(t, n) order by n), '');
  t text;
  w text;
  i int;
begin
  if length(letters) < 3 then return true; end if;
  if letters ~ '(conta|contralor|finanz|fiscal|admin|auxiliar|gerenc|direcc|logistic|compras|cxp|cxc|impuest|factur|nomina|recepc|ventas|tesor|asesor|junior|juridic|despacho|cobranza|pagos|oficina|corporativo)' then
    return true;
  end if;
  foreach t in array tokens loop
    continue when length(t) < 3;
    if position(t in letters) > 0 then return true; end if;
    foreach w in array words loop
      if t like w || '%' or (least(length(t), length(w)) >= 4 and private.within_one_edit(t, w)) then return true; end if;
    end loop;
  end loop;
  if length(initials) >= 2 and letters like left(initials, 2) || '%' then return true; end if;
  for i in 1 .. length(initials) - 2 loop
    if position(substr(initials, i, 3) in letters) > 0 then return true; end if;
  end loop;
  return false;
end;
$$;

-- 'ok' si el nombre escrito puede confirmar la invitación de este invitado; 'mismatch' si el
-- invitado tiene otro nombre; 'review' si el invitado no tiene nombre y el nombre no se parece a su correo.
create or replace function private.registrant_check(guest public.guests, submitted text)
returns text language plpgsql immutable set search_path = '' as $$
begin
  if cardinality(private.name_tokens(guest.full_name)) > 0 then
    return case when private.names_match(guest.full_name, submitted) then 'ok' else 'mismatch' end;
  end if;
  if nullif(trim(guest.email), '') is not null and not private.name_fits_email(guest.email, submitted) then
    return 'review';
  end if;
  return 'ok';
end;
$$;
revoke all on function private.name_fits_email(text, text) from public, anon;
revoke all on function private.registrant_check(public.guests, text) from public, anon;

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
  name_check text;
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
  if has_name then
    name_check := private.registrant_check(guest_row, guest_name);
    if name_check <> 'ok' then
      perform private.log_registration(inv.event_id, inv.guest_id, 'contacto_de_otro', guest_name, guest_email, guest_phone, guest_company, guest_row);
      return json_build_object('status', case when name_check = 'review' then 'name_review' else 'name_mismatch' end);
    end if;
  end if;
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
  name_check text;
begin
  select * into invitation_row from public.invitations where token = invitation_token;
  if invitation_row.id is null then raise exception 'Invitation not found'; end if;
  select * into guest_row from public.guests where id = invitation_row.guest_id;

  -- La invitación es personal: si el invitado tiene correo, sólo se confirma con ese mismo correo.
  if nullif(trim(guest_row.email), '') is not null and nullif(trim(guest_email), '') is not null
     and lower(trim(guest_row.email)) <> lower(trim(guest_email)) then
    perform private.log_registration(invitation_row.event_id, null, 'no_encontrado', guest_name, guest_email, guest_phone, guest_origin);
    return json_build_object('event_id', invitation_row.event_id, 'guest_id', guest_row.id, 'status', 'email_mismatch');
  end if;

  name_check := private.registrant_check(guest_row, guest_name);
  if name_check <> 'ok' then
    perform private.log_registration(invitation_row.event_id, guest_row.id, 'contacto_de_otro', guest_name, guest_email, guest_phone, guest_origin, guest_row);
    return json_build_object('event_id', invitation_row.event_id, 'guest_id', guest_row.id,
      'status', case when name_check = 'review' then 'name_review' else 'name_mismatch' end);
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
