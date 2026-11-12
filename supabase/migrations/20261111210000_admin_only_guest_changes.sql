-- Solo el rol admin puede editar o eliminar invitados e invitaciones.
-- Antes cualquier miembro que no fuera líder (equipo y consulta incluidos) podía hacerlo
-- desde la API aunque el panel no le mostrara los botones.
-- El envío de invitaciones no se ve afectado: usa funciones security definer y la Edge Function con service_role.
begin;

drop policy if exists "non-leaders can update guests" on public.guests;
drop policy if exists "non-leaders can delete guests" on public.guests;
drop policy if exists "non-leaders can update invitations" on public.invitations;
drop policy if exists "non-leaders can delete invitations" on public.invitations;

create policy "admins can update guests" on public.guests for update to authenticated
  using (public.is_event_member(event_id) and private.event_member_role(event_id) = 'admin')
  with check (public.is_event_member(event_id) and private.event_member_role(event_id) = 'admin');
create policy "admins can delete guests" on public.guests for delete to authenticated
  using (public.is_event_member(event_id) and private.event_member_role(event_id) = 'admin');

create policy "admins can update invitations" on public.invitations for update to authenticated
  using (public.is_event_member(event_id) and private.event_member_role(event_id) = 'admin')
  with check (public.is_event_member(event_id) and private.event_member_role(event_id) = 'admin');
create policy "admins can delete invitations" on public.invitations for delete to authenticated
  using (public.is_event_member(event_id) and private.event_member_role(event_id) = 'admin');

commit;
