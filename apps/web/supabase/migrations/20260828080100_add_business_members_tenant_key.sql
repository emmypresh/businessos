-- Phase 1F: additive tenant-consistency key for business_members.
--
-- create_business_members.sql (Phase 1) only declared unique(business_id,
-- user_id) — sufficient for its own needs at the time, but Phase 1F's
-- business_member_branches table needs to FK against a specific
-- membership ROW (by id) while still structurally guaranteeing that row
-- belongs to the business the assignment claims it does, the same
-- composite-FK technique every other Phase 1C/1D/1E child table already
-- uses against its own parent. This migration ONLY adds a new constraint
-- to the existing table — it does not alter, drop, or replace anything
-- Phase 1A–1E's own migration files defined; those files remain untouched
-- on disk and this index changes nothing about their behavior.
alter table public.business_members
  add constraint business_members_id_business_id_key unique (id, business_id);
