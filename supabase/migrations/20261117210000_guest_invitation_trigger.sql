-- Cada invitado recibe su invitación en la misma operación en que se guarda.
-- Antes el panel guardaba al invitado y después, en otra petición, su invitación; si la página
-- se recargaba entre las dos (pasó 3 veces en la carga masiva del 2026-11-17), el invitado quedaba
-- sin invitación y el envío masivo de correos se detenía en él.
begin;

create or replace function private.create_guest_invitation() returns trigger
language plpgsql security definer set search_path = '' as $$
begin
  insert into public.invitations(event_id, guest_id) values (new.event_id, new.id)
  on conflict (event_id, guest_id) do nothing;
  return null;
end;
$$;
revoke all on function private.create_guest_invitation() from public, anon, authenticated;

drop trigger if exists guests_create_invitation on public.guests;
create trigger guests_create_invitation after insert on public.guests
  for each row execute function private.create_guest_invitation();

-- resolve_registration («Agregar como invitado» en la bitácora) insertaba la invitación por su cuenta;
-- con el trigger ese insert chocaría y su manejador de unique_violation respondería «contact_in_use».
-- Se cambia sólo esa línea: ahora toma la invitación que ya creó el trigger.
do $$
declare
  def text := pg_get_functiondef('public.resolve_registration(bigint, text, text, text, text, text)'::regprocedure);
  old_line constant text := 'insert into public.invitations(event_id, guest_id) values (entry.event_id, target.id) returning * into inv;';
  new_line constant text := 'insert into public.invitations(event_id, guest_id) values (entry.event_id, target.id) on conflict (event_id, guest_id) do nothing;
      select * into inv from public.invitations where event_id = entry.event_id and guest_id = target.id;';
begin
  if position(old_line in def) = 0 then
    raise exception 'resolve_registration no tiene la línea esperada; revisar a mano antes de aplicar';
  end if;
  execute replace(def, old_line, new_line);
end;
$$;

-- Por si quedó algún invitado sin invitación.
insert into public.invitations(event_id, guest_id)
select g.event_id, g.id from public.guests g
where not exists (select 1 from public.invitations i where i.event_id = g.event_id and i.guest_id = g.id)
on conflict (event_id, guest_id) do nothing;

commit;
