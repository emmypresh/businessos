-- Phase 1Q-A part 2: businesses.primary_category_id +
-- businesses.custom_category_label.
--
-- Nullable, no default, no backfill — existing businesses (created before
-- this phase) are never force-assigned a guessed category (phase
-- instruction §9: "Do NOT silently classify all existing businesses
-- incorrectly just to satisfy NOT NULL"). New businesses are required to
-- supply a category at creation via public.create_business's own
-- validation (next migration) — enforced at the RPC boundary, not by a
-- table-level NOT NULL, so this column can stay nullable for the
-- pre-1Q-A population forever.
--
-- No grant/policy change on public.businesses for `authenticated` here:
-- both columns are written EXCLUSIVELY by SECURITY DEFINER RPCs
-- (create_business at creation, update_business_category thereafter — see
-- the next migration), matching create_business's own "sole write path"
-- pattern for this table, not the plain-direct-update pattern
-- updateBusinessTimezone uses (see that migration's own comment for why
-- category needs the stronger boundary: validity depends on a join
-- against business_categories.is_active, not a pure per-row predicate a
-- table CHECK can express).

alter table public.businesses
  add column primary_category_id uuid references public.business_categories (id),
  add column custom_category_label text
    check (
      custom_category_label is null
      or (length(custom_category_label) <= 100 and length(btrim(custom_category_label)) >= 2)
    );

create index businesses_primary_category_id_idx
  on public.businesses (primary_category_id);
