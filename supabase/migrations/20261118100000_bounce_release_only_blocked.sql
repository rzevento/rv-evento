-- Sólo se libera para reenviar lo que rebotó por el bloqueo de la cuenta remitente.
-- Un rechazo del servidor del destinatario («rechazado») casi siempre se repite si se reenvía, y cada
-- rebote nuevo empeora la reputación de la cuenta; esos quedan en la bitácora para revisarlos a mano,
-- igual que las direcciones inexistentes. La carga inicial del 2026-11-17 liberó 5 invitaciones
-- «rechazado»: vuelven a quedar como enviadas (con la hora del rebote).
begin;

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

  if guest_row.id is not null and p_reason = 'cuenta_bloqueada' then
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

update public.invitations i set status = 'sent', sent_at = b.bounced_at
from public.email_bounces b
where b.reason = 'rechazado' and b.released and b.kind = 'invitacion'
  and b.guest_id = i.guest_id and b.event_id = i.event_id and i.sent_at is null;
update public.email_bounces set released = false where reason = 'rechazado' and released;

commit;
