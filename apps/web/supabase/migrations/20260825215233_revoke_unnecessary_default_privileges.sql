-- Least-privilege pass over `anon`/`authenticated`'s table grants.
--
-- Postgres/Supabase grant every role a baseline of REFERENCES, TRIGGER,
-- and TRUNCATE on newly created tables by default (independent of the
-- explicit SELECT/INSERT/UPDATE/DELETE grants each migration in this
-- project has added deliberately). Under the Data API, none of these
-- three are reachable at all — PostgREST only ever issues SELECT/INSERT/
-- UPDATE/DELETE on behalf of a client, never DDL (CREATE TRIGGER,
-- TRUNCATE) or FK-authoring privileges (REFERENCES) — so this migration
-- doesn't change what a client can do through the API today. It matters
-- as defense in depth regardless: least privilege means a role holds only
-- what its actual access path requires, not "whatever's harmless under
-- today's specific client," and TRUNCATE in particular — an instant,
-- unfiltered, trigger-bypassing wipe of an entire table — is not a
-- privilege either role has any reason to carry even latently.
--
-- Scoped to `anon`/`authenticated` only, exactly as requested: `service_role`
-- is a trusted server-side credential with intentionally broad access
-- already (see create_businesses.sql), and this pass isn't about it.
--
-- Nothing here touches the deliberate SELECT grants (all five tables) or
-- the DELETE/UPDATE(name,slug,status) grants on `businesses` for
-- `authenticated` from earlier migrations — only REFERENCES/TRIGGER/
-- TRUNCATE are revoked, and only those three were ever present beyond the
-- deliberate grants (confirmed via information_schema.role_table_grants
-- before writing this migration: neither role held any INSERT grant on
-- any of these five tables prior to this point, so there is nothing else
-- to revoke here).
revoke references, trigger, truncate
  on public.roles, public.permissions, public.role_permissions,
     public.businesses, public.business_members
  from anon, authenticated;
