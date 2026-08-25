-- Phase 1 database foundation: shared infrastructure.
--
-- `private` holds everything that must never be reachable through the Data
-- API: authorization helper functions, trigger functions, and anything else
-- that only ever runs as a side effect of a statement against `public`.
-- config.toml only exposes the `public` and `graphql_public` schemas
-- (`api.schemas`), so nothing in `private` is ever callable as a PostgREST
-- RPC regardless of the GRANTs placed on it — the GRANTs in later
-- migrations are defense in depth, not the only thing stopping client
-- access.
create schema if not exists private;

-- Shared BEFORE UPDATE trigger: keeps `updated_at` current on every row
-- change, for every table that has the column. Lives in `private` per the
-- rule above.
create or replace function private.set_updated_at()
returns trigger
language plpgsql
set search_path = pg_catalog, public
as $$
begin
  new.updated_at = now();
  return new;
end;
$$;

-- Postgres refuses to invoke any trigger function outside trigger context
-- ("trigger functions can only be called as triggers") regardless of
-- EXECUTE grants, so this revoke changes nothing functionally — it's here
-- so a grants audit doesn't need to know that fact to see this function
-- isn't meant to be called directly.
revoke all on function private.set_updated_at() from public;
