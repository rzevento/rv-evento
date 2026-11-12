-- El encabezado de "Ver como usuario" pasa a llamarse x-rv-impersonation.
create or replace function private.request_impersonation_id() returns uuid
language sql stable set search_path = '' as $$
  select nullif(coalesce(nullif(current_setting('request.headers', true), ''), '{}')::jsonb ->> 'x-rv-impersonation', '')::uuid;
$$;
