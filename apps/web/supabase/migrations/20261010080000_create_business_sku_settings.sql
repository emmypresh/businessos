-- Phase 1Q-B: product identifier + auto-SKU foundation, part 1 — the
-- per-business SKU generation preference and the internal, non-exposed
-- counter store used to allocate SKU suffixes concurrency-safely.
--
-- SKU MODE is a business-level UX preference, NOT authorization, NOT a
-- subscription entitlement, and NOT a security boundary — mirrors
-- business_categories' own "descriptive metadata only" posture exactly.
-- It controls how create_product resolves a missing p_sku (see
-- 20261010080100_product_sku_generation.sql), nothing else.
--
-- One row per business, created lazily on first write (no row means
-- SMART_AUTO — the recommended default — per phase instruction §5). This
-- avoids requiring a settings UI or a create_business RPC change (that
-- migration is frozen and out of scope for this phase) just to seed a
-- default preference row for every existing and future business.
create table public.business_sku_settings (
  business_id uuid primary key references public.businesses (id) on delete cascade,
  sku_mode    text not null default 'SMART_AUTO'
                check (sku_mode in ('SMART_AUTO', 'SIMPLE_SEQUENTIAL', 'MANUAL')),
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now()
);

create trigger business_sku_settings_set_updated_at
  before update on public.business_sku_settings
  for each row
  execute function private.set_updated_at();

-- Row Level Security -----------------------------------------------------
--
-- A plain RLS-governed table, not RPC-only: unlike products/customers/
-- sales, there is no cross-table invariant or idempotency concern here —
-- a single scalar preference, gated by the same products.manage
-- permission that already governs every other product-configuration
-- surface (create_product, product UPDATE). business_id is the PRIMARY
-- KEY, so a caller can never target any business_id other than the one
-- the RLS predicate itself authorizes for.
alter table public.business_sku_settings enable row level security;
alter table public.business_sku_settings force row level security;

create policy business_sku_settings_select on public.business_sku_settings
  for select
  to authenticated
  using (private.has_permission(business_id, 'products.view'));

create policy business_sku_settings_insert on public.business_sku_settings
  for insert
  to authenticated
  with check (private.has_permission(business_id, 'products.manage'));

create policy business_sku_settings_update on public.business_sku_settings
  for update
  to authenticated
  using (private.has_permission(business_id, 'products.manage'))
  with check (private.has_permission(business_id, 'products.manage'));

revoke all on public.business_sku_settings from public, anon, authenticated, service_role;

grant select (business_id, sku_mode, created_at, updated_at)
  on public.business_sku_settings to authenticated, service_role;
grant insert (business_id, sku_mode) on public.business_sku_settings to authenticated;
-- business_id is included even though it never actually changes value
-- (RLS/PK make that a no-op) — an `INSERT ... ON CONFLICT (business_id)
-- DO UPDATE` upsert (the only realistic client write path for a PK-keyed
-- single-row-per-business settings table) needs UPDATE privilege
-- covering every column its generated SET clause touches, which includes
-- the conflict-target column itself; column-restricted UPDATE grants that
-- omitted it failed with a bare "permission denied for table" at the
-- GRANT layer (caught by the Phase 1Q-B integration suite run against a
-- real database — see the build brief's own validation section).
-- Mirrors notification_preferences' own identical, already-established
-- grant shape (20260903080200_create_notification_preferences.sql).
grant update (business_id, sku_mode) on public.business_sku_settings to authenticated;

revoke references, trigger, truncate on public.business_sku_settings from anon, authenticated;

-- SKU sequence counters ---------------------------------------------------
--
-- Internal only — never exposed via PostgREST (not in config.toml's
-- api.schemas), matching private.product_creation_requests' own identical
-- treatment. counter_key is either the literal 'SIMPLE' (one counter per
-- business for SIMPLE_SEQUENTIAL mode) or a generated SMART_AUTO prefix
-- (e.g. 'ELE-SAM-A15') — one independent counter per distinct prefix, so
-- "ELE-SAM-A15-001" and "GRO-COC-50CL-001" allocate from separate
-- sequences and neither can starve or skip the other.
--
-- CONCURRENCY: allocation (private.next_sku_sequence, next migration) uses
-- a row-locked UPDATE ... RETURNING, never `select max(...) + 1` — two
-- concurrent callers requesting the same counter_key serialize on
-- Postgres's own row lock and always receive distinct values. This table
-- is the mechanism; the next migration is the arbiter.
create table private.business_sku_counters (
  business_id  uuid not null references public.businesses (id) on delete cascade,
  counter_key  text not null check (length(counter_key) between 1 and 80),
  next_value   bigint not null default 1 check (next_value > 0),
  updated_at   timestamptz not null default now(),

  primary key (business_id, counter_key)
);

alter table private.business_sku_counters enable row level security;
alter table private.business_sku_counters force row level security;

revoke all on private.business_sku_counters from public, anon, authenticated, service_role;
