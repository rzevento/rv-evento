-- Al cancelar una asistencia confirmada se libera el envío de la entrada, para que si el
-- invitado vuelve a confirmar le llegue una entrada nueva (send-ticket la manda una sola vez
-- mientras ticket_sent_at no sea nulo). Cubre la cancelación del invitado (cancel_rsvp) y la
-- del panel, porque ambas cambian rsvps.status.
create or replace function public.release_ticket_on_cancel()
returns trigger language plpgsql security definer set search_path = public as $$
begin
  if old.status = 'confirmed' and new.status is distinct from 'confirmed' then
    update public.invitations set ticket_sent_at = null
    where event_id = new.event_id and guest_id = new.guest_id and ticket_sent_at is not null;
  end if;
  return new;
end;
$$;

revoke all on function public.release_ticket_on_cancel() from public, anon, authenticated;

drop trigger if exists release_ticket_on_cancel on public.rsvps;
create trigger release_ticket_on_cancel
  after update of status on public.rsvps
  for each row execute function public.release_ticket_on_cancel();

-- "Reenviar entrada" del panel: sólo un administrador del evento libera el envío para que
-- send-ticket vuelva a mandar la entrada (al correo registrado y sólo si sigue confirmado).
create or replace function public.release_guest_ticket_email(target_guest_id uuid)
returns void language plpgsql security definer set search_path = public as $$
declare
  guest_row public.guests;
begin
  select * into guest_row from public.guests where id = target_guest_id;
  if guest_row.id is null or not public.is_event_member(guest_row.event_id)
     or private.event_member_role(guest_row.event_id) is distinct from 'admin' then
    raise exception 'No tienes permiso para reenviar entradas' using errcode = '42501';
  end if;
  update public.invitations set ticket_sent_at = null
  where event_id = guest_row.event_id and guest_id = guest_row.id;
end;
$$;

revoke all on function public.release_guest_ticket_email(uuid) from public, anon;
grant execute on function public.release_guest_ticket_email(uuid) to authenticated;
