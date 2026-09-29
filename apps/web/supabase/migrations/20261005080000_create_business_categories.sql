-- Phase 1Q-A: business category / industry foundation, part 1 — the
-- platform-global category registry.
--
-- Unlike expense_categories (20260827080000_create_expense_categories.sql,
-- one set of rows PER business, tenant-writable), business_categories is a
-- single, PLATFORM-GLOBAL catalog with NO business_id column — every
-- tenant reads the same shared rows. This mirrors the
-- country/currency/timezone precedent's own core principle ("the stable
-- code, not the label, is the stored identity" —
-- 20260909080000_business_country_currency.sql), but as a real table
-- rather than a hardcoded TS catalog, because platform staff must be able
-- to add or deactivate a category later without a code deploy.
--
-- Category is descriptive metadata for future defaults/hints only — it
-- must NEVER be read as authorization, a subscription entitlement, or a
-- tenant role. No policy or grant in this migration (or anywhere else)
-- makes it one.

create table public.business_categories (
  id          uuid primary key default gen_random_uuid(),
  -- Stable, machine-readable identifier — immutable in practice (nothing
  -- in this schema ever updates `code`), unlike `name`/`description`
  -- which platform staff may revise for copy reasons without breaking any
  -- business's stored reference (businesses.primary_category_id points at
  -- `id`, never at `code` or `name`).
  code        text not null unique
                check (code = upper(code) and code ~ '^[A-Z][A-Z_]{1,39}$'),
  name        text not null
                check (length(name) <= 100 and length(btrim(name)) >= 2),
  description text
                check (description is null or length(description) <= 200),
  is_active   boolean not null default true,
  sort_order  integer not null default 0,
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now(),

  -- Same technique as products'/customers'/expense_categories' own
  -- unique(id, business_id) — here a plain unique(id) so
  -- businesses.primary_category_id can FK against it structurally.
  unique (id)
);

create index business_categories_active_sort_idx
  on public.business_categories (is_active, sort_order);

create trigger business_categories_set_updated_at
  before update on public.business_categories
  for each row
  execute function private.set_updated_at();

-- Row Level Security -----------------------------------------------------

alter table public.business_categories enable row level security;
alter table public.business_categories force row level security;

-- Read-only reference data, not tenant-scoped and not sensitive: every
-- authenticated user may list the full registry, INCLUDING inactive rows
-- — a business that already holds a since-deactivated category must still
-- be able to resolve and render that category's label (checklist item
-- 31/32, "existing business assigned to an inactive category should
-- retain its value" / "fail gracefully, never crash"). Pickers filter to
-- is_active client- and server-side for SELECTABLE options only (see
-- lib/business/categories-dal.ts) — this policy governs visibility, not
-- selectability, exactly like expense_categories' own status-spanning
-- select policy.
--
-- Per phase instruction §20 ("prefer authenticated-only unless existing
-- onboarding architecture requires otherwise"): this repo's onboarding
-- already requires a signed-in user before reaching the create-business
-- form (app/onboarding/page.tsx sits behind the authenticated app shell),
-- so anon access is not needed and is not granted.
create policy business_categories_select on public.business_categories
  for select
  to authenticated
  using (true);

-- No INSERT/UPDATE/DELETE policy for `authenticated` at all — the
-- registry is platform-defined only (phase instruction §18: "no tenant
-- category CRUD in this phase"). service_role (used only by trusted
-- platform tooling, never the browser) bypasses RLS entirely via its own
-- standing role membership, matching this schema's universal convention.

revoke all on public.business_categories from public, anon, authenticated, service_role;

grant select (
  id, code, name, description, is_active, sort_order, created_at, updated_at
) on public.business_categories to authenticated, service_role;

-- service_role additionally gets full DML for future platform admin
-- tooling (adding/deactivating categories) — still RLS-bypassing, still
-- never reachable from the browser (no anon/authenticated grant exists
-- for insert/update/delete on this table at all).
grant insert, update, delete on public.business_categories to service_role;

revoke references, trigger, truncate on public.business_categories from anon, authenticated;

-- Seed ---------------------------------------------------------------
--
-- 13 categories + OTHER = 14 total, directly mirroring the phase
-- instructions' own "Examples" list (Retail, Wholesale, Restaurant/Food
-- Service, Fashion/Boutique, Pharmacy, Electronics/Phones,
-- Supermarket/Grocery, Beauty/Salon, Professional Services,
-- Logistics/Delivery, Auto/Spare Parts, General Trading, Manufacturing,
-- Other) and its own "Stable Identifiers" example list — within the
-- recommended 10-20 range, international (no single-country label used
-- as a canonical name), and deliberately excludes legal-entity-type
-- concepts (Ltd/LLC/Partnership) per phase instruction §12.
insert into public.business_categories (code, name, description, sort_order) values
  ('RETAIL',          'Retail',                   'Sell products directly to customers', 10),
  ('WHOLESALE',       'Wholesale',                'Sell products in bulk to other businesses', 20),
  ('RESTAURANT',      'Restaurant / Food Service', 'Prepare and serve food or drinks', 30),
  ('FASHION',         'Fashion / Boutique',        'Sell clothing, shoes, or accessories', 40),
  ('PHARMACY',        'Pharmacy',                  'Sell medicines and health products', 50),
  ('ELECTRONICS',     'Electronics / Phones',      'Sell phones, computers, and electronic devices', 60),
  ('GROCERY',         'Supermarket / Grocery',     'Sell everyday food and household items', 70),
  ('BEAUTY',          'Beauty / Salon',            'Offer beauty, grooming, or salon services', 80),
  ('SERVICES',        'Professional Services',     'Offer expertise or professional services', 90),
  ('LOGISTICS',       'Logistics / Delivery',      'Move or deliver goods for others', 100),
  ('AUTO_PARTS',      'Auto / Spare Parts',        'Sell vehicle parts and accessories', 110),
  ('GENERAL_TRADING', 'General Trading',           'A broad mix of general merchandise trading', 120),
  ('MANUFACTURING',   'Manufacturing',             'Produce or assemble goods', 130),
  ('OTHER',           'Other',                     'Something not listed above', 999)
on conflict (code) do nothing;
