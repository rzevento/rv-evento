-- Correo con la entrada (PDF) al confirmar asistencia.
-- La Edge Function send-ticket aparta el envío con claim_ticket_email antes de llamar a Make
-- (así dos llamadas simultáneas no mandan dos correos) y lo libera si Make no confirma.
alter table public.invitations
  add column if not exists ticket_sent_at timestamptz;

create or replace function public.claim_ticket_email(invitation_token text)
returns json language plpgsql security definer set search_path = public as $$
declare
  invitation_row public.invitations;
  guest_row public.guests;
  rsvp_status text;
begin
  select * into invitation_row from public.invitations where token = invitation_token;
  if invitation_row.id is null then return json_build_object('result', 'not_found'); end if;

  select status into rsvp_status from public.rsvps
  where event_id = invitation_row.event_id and guest_id = invitation_row.guest_id;
  if rsvp_status is distinct from 'confirmed' then return json_build_object('result', 'not_confirmed'); end if;

  select * into guest_row from public.guests where id = invitation_row.guest_id;
  if guest_row.email is null or btrim(guest_row.email) = '' then return json_build_object('result', 'no_email'); end if;

  update public.invitations set ticket_sent_at = now()
  where id = invitation_row.id and ticket_sent_at is null;
  if not found then return json_build_object('result', 'already_sent'); end if;

  return json_build_object(
    'result', 'claimed',
    'invitation_id', invitation_row.id,
    'guest_name', guest_row.full_name,
    'email', btrim(guest_row.email)
  );
end;
$$;

create or replace function public.release_ticket_email(target_invitation_id uuid)
returns void language sql security definer set search_path = public as $$
  update public.invitations set ticket_sent_at = null where id = target_invitation_id;
$$;

revoke all on function public.claim_ticket_email(text) from public, anon, authenticated;
revoke all on function public.release_ticket_email(uuid) from public, anon, authenticated;
grant execute on function public.claim_ticket_email(text) to service_role;
grant execute on function public.release_ticket_email(uuid) to service_role;
