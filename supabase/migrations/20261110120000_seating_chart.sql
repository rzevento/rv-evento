-- Croquis del evento: cada invitado puede tener una mesa asignada (mesas de 8 personas).
begin;

create table if not exists public.seat_assignments (
  guest_id uuid primary key references public.guests(id) on delete cascade,
  event_id uuid not null references public.events(id) on delete cascade,
  table_number integer not null check (table_number between 1 and 200),
  assigned_at timestamptz not null default now(),
  assigned_by uuid
);
create index if not exists seat_assignments_event_table_idx on public.seat_assignments (event_id, table_number);

alter table public.seat_assignments enable row level security;
drop policy if exists "members can read seat assignments" on public.seat_assignments;
create policy "members can read seat assignments" on public.seat_assignments for select to authenticated
  using (public.is_event_member(event_id));
-- Sin políticas de escritura: los cambios pasan por assign_guest_tables, que valida rol y cupo.

-- assignments: [{"guest_id": "...", "table_number": 3}, {"guest_id": "...", "table_number": null}]
-- table_number null quita al invitado de su mesa. Todo el lote se aplica o se rechaza completo.
create or replace function public.assign_guest_tables(target_event_id uuid, assignments jsonb)
returns integer language plpgsql security definer set search_path = '' as $$
declare
  item jsonb;
  v_guest uuid;
  v_table integer;
  v_actor uuid;
  full_table integer;
begin
  if not public.is_event_member(target_event_id) or private.event_member_role(target_event_id) is distinct from 'admin' then
    raise exception 'Solo los administradores pueden asignar mesas' using errcode = '42501';
  end if;
  if assignments is null or jsonb_typeof(assignments) <> 'array' then
    raise exception 'Lista de asignaciones inválida' using errcode = '22023';
  end if;
  v_actor := private.organizer_effective_uid(target_event_id);
  -- Serializa los cambios del croquis por evento para que el cupo no se rebase con dos usuarios a la vez.
  perform pg_advisory_xact_lock(hashtext('seating:' || target_event_id::text));
  for item in select value from jsonb_array_elements(assignments) loop
    v_guest := (item->>'guest_id')::uuid;
    v_table := nullif(item->>'table_number', '')::integer;
    if not exists (select 1 from public.guests where id = v_guest and event_id = target_event_id) then
      raise exception 'Invitado no encontrado' using errcode = 'P0002';
    end if;
    if v_table is null then
      delete from public.seat_assignments where guest_id = v_guest and event_id = target_event_id;
    else
      insert into public.seat_assignments (guest_id, event_id, table_number, assigned_by)
      values (v_guest, target_event_id, v_table, v_actor)
      on conflict (guest_id) do update set table_number = excluded.table_number, assigned_at = now(), assigned_by = excluded.assigned_by;
    end if;
  end loop;
  select table_number into full_table from public.seat_assignments
  where event_id = target_event_id group by table_number having count(*) > 8 order by table_number limit 1;
  if full_table is not null then
    raise exception 'La mesa % ya tiene 8 personas', full_table using errcode = 'P0001';
  end if;
  insert into public.activity_log(event_id, action, actor_id, metadata)
  values (target_event_id, 'seating_updated', auth.uid(), jsonb_build_object('changes', jsonb_array_length(assignments), 'effective_user_id', v_actor));
  return jsonb_array_length(assignments);
end;
$$;
revoke all on function public.assign_guest_tables(uuid, jsonb) from public, anon;
grant execute on function public.assign_guest_tables(uuid, jsonb) to authenticated;

commit;
