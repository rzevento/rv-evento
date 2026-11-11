-- El proyecto no otorga permisos por defecto a las tablas nuevas: sin este grant
-- la app recibe "permission denied for table seat_assignments" al leer el croquis.
-- La escritura sigue siendo solo por public.assign_guest_tables (security definer).
grant select on table public.seat_assignments to authenticated;
