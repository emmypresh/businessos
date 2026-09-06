-- Phase 1L: SaaS subscription/billing — DATABASE FOUNDATION ONLY.
--
-- This migration creates the INTERNAL BUSINESSOS PLAN CATALOG: the
-- stable, product-defined tiers (subscription_plans), their normalized
-- limit/feature entitlements (plan_entitlements), and their provider/
-- billing-cycle-specific prices (subscription_plan_prices). Nothing here
-- is provider-specific identity for a given BUSINESS — that is
-- business_subscriptions, in the next migration. Nothing here is
-- payment/webhook history — that is billing_transactions/
-- billing_provider_events, in the migration after that.
--
-- SCOPE: this is BOS's own SaaS billing (what a business pays BusinessOS
-- to use the product), never the business's own customer-facing sales/
-- accounting ledger — completely orthogonal to every existing Phase
-- 1C-1K table.
--
-- STABLE CODE IS IDENTITY, NEVER THE DISPLAY LABEL (per this phase's own
-- explicit instruction): `subscription_plans.code` is a small, closed,
-- product-defined enum (STARTER/GROWTH/BUSINESS/ENTERPRISE) — anything
-- that needs to know "which tier is this" compares against `code`,
-- never `name` (which may be renamed for marketing purposes without any
-- schema or authorization implication).
--
-- PRICES ARE DELIBERATELY NOT FINALIZED HERE: this phase's own
-- instructions are explicit that the NGN price bands named in the
-- product brief are PRODUCT DIRECTION, not immutable database
-- constants, and that seed pricing may be absent until the application-
-- layer pricing decision. No row is inserted into
-- subscription_plan_prices by this migration — the table exists, fully
-- functional and constrained, ready to receive real prices later via a
-- plain INSERT (never a schema migration).
--
-- ENTITLEMENT LIMITS (branches.max/staff.max) ARE SEEDED, DELIBERATELY,
-- WITH THE SPECIFIC NUMBERS THIS PHASE'S OWN PRODUCT BRIEF NAMES AS FIRM
-- (branch counts: "1 branch", "up to 3 branches", "up to 10 branches" —
-- not ranges) and the UPPER BOUND of the "approximately N-M staff"
-- ranges given for staff — this is NOT the same category of decision as
-- finalizing NGN pricing: these are ordinary DATA ROWS in a normal
-- table, trivially changed later by a plain UPDATE, never a schema
-- constraint baking a number into an irreversible CHECK. Proving the
-- entitlement model actually works end-to-end (a real plan with a real
-- limit a future query can read) is the point of a DATABASE FOUNDATION;
-- leaving the table structurally correct but entirely empty would not
-- prove that. WhatsApp usage-limit entitlements (whatsapp.messages_
-- monthly_limit and friends) are DELIBERATELY NOT SEEDED AT ALL — this
-- phase's own explicit instruction is "do not hard-code speculative
-- usage numbers yet" for WhatsApp specifically, unlike branch/staff
-- counts. WHATSAPP ITSELF IS NEVER GATED BY A FEATURE ENTITLEMENT KEY
-- AT ALL — per this phase's own explicit, non-negotiable product
-- decision, basic WhatsApp/customer-communication capability is
-- available on every normal paid tier; only ADVANCED WhatsApp
-- capabilities (automation, campaigns, advanced templates, analytics,
-- multiple numbers) and USAGE SCALE (messages_monthly_limit) are ever
-- expected to differ per plan, and none of those rows exist yet either
-- — the entitlement model is capable of expressing them the moment a
-- real product decision provides real numbers, via a plain INSERT.

create table public.subscription_plans (
  id          uuid primary key default gen_random_uuid(),
  -- Fixed, small, product-defined set — deliberately a CLOSED enum
  -- (unlike audit_events.action/notifications.notification_type's own
  -- deliberately OPEN regex convention): a new pricing TIER is a rare,
  -- deliberate, reviewed product decision (not a continuously-growing
  -- machine-generated vocabulary), so a closed CHECK is the more
  -- appropriate structural guarantee here — widening it for a genuine
  -- 5th tier later is a normal, safe, additive CHECK-constraint
  -- migration, exactly like every other closed enum in this schema
  -- (audit_events.category, notifications.severity, ...).
  code        text not null unique check (code in ('STARTER', 'GROWTH', 'BUSINESS', 'ENTERPRISE')),
  name        text not null check (length(btrim(name)) >= 2 and length(name) <= 100),
  description text check (description is null or length(description) <= 2000),
  is_active   boolean not null default true,
  -- is_public: a plan a business can self-select at checkout (STARTER/
  -- GROWTH/BUSINESS) vs. one that only exists as a row to hang a
  -- negotiated ENTERPRISE subscription off of, never self-service-
  -- selectable. No code path reads this yet (application-layer
  -- concern) — the column exists so that distinction is representable
  -- from day one.
  is_public   boolean not null default true,
  sort_order  integer not null default 0,
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now()
);

create index subscription_plans_active_idx on public.subscription_plans (is_active, sort_order);

create trigger subscription_plans_set_updated_at
  before update on public.subscription_plans
  for each row
  execute function private.set_updated_at();

insert into public.subscription_plans (code, name, description, sort_order) values
  ('STARTER',    'Starter',    'Entry tier for a single branch running core operations.', 1),
  ('GROWTH',     'Growth',     'Expanded reporting, communications, and alerts for growing businesses. Default trial tier.', 2),
  ('BUSINESS',   'Business',   'Advanced permissions, audit, automation, and integrations for multi-branch operations.', 3),
  ('ENTERPRISE', 'Enterprise', 'Custom pricing and negotiated limits/features for large organizations.', 4);

-- plan_entitlements ------------------------------------------------------
--
-- Normalized, TYPED limit/feature table — explicitly NOT an unstructured
-- JSON blob (per this phase's own explicit instruction: "Potential
-- entitlement/limit fields should NOT become an unstructured security-
-- critical JSON blob if they need database enforcement"). One row per
-- (plan, entitlement_key); EXACTLY one of the three typed value columns
-- is populated, enforced structurally, never left to convention.
--
-- entitlement_key follows notifications.notification_type's/audit_events
-- .action's own established "regex-shaped, not a closed enum" convention
-- — this vocabulary is EXPECTED to grow continuously as new limits and
-- features are defined (branches.max, staff.max, whatsapp.*, feature.*,
-- ...), exactly like those two, and for the identical reason: a closed
-- enum would need a migration for every single new entitlement key ever
-- added.
--
-- A MISSING (plan, key) row means "no product-enforced limit for this
-- plan" (unlimited/not applicable) — this is the ENTERPRISE convention
-- specifically: no branches.max/staff.max row exists for ENTERPRISE at
-- all, representing its own "custom pricing, negotiated limits" nature
-- structurally, never as a magic sentinel integer.
create table public.plan_entitlements (
  id              uuid primary key default gen_random_uuid(),
  plan_id         uuid not null references public.subscription_plans (id) on delete cascade,
  entitlement_key text not null
                    check (entitlement_key ~ '^[a-z][a-z0-9_]*(\.[a-z0-9_]+)+$' and length(entitlement_key) <= 100),
  value_integer   integer check (value_integer is null or value_integer >= 0),
  value_boolean   boolean,
  value_text      text check (value_text is null or length(value_text) <= 200),
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now(),

  unique (plan_id, entitlement_key),

  -- Exactly one representation — never zero (a meaningless key with no
  -- value at all), never more than one (which value would even be
  -- authoritative?). Counting non-null columns is the same technique
  -- notifications.notification_preferences and every other "exactly one
  -- of several optional columns" invariant in this schema could use, but
  -- is applied here for the first time because this is the first table
  -- that genuinely needs a true tagged-union-of-scalars shape.
  check (
    (case when value_integer is not null then 1 else 0 end) +
    (case when value_boolean is not null then 1 else 0 end) +
    (case when value_text    is not null then 1 else 0 end) = 1
  )
);

create index plan_entitlements_plan_idx on public.plan_entitlements (plan_id);
-- Supports "which plans grant this entitlement" lookups (e.g. a future
-- admin/support tool auditing entitlement drift across plans) — the
-- unique (plan_id, entitlement_key) index above already covers the
-- reverse direction.
create index plan_entitlements_key_idx on public.plan_entitlements (entitlement_key);

create trigger plan_entitlements_set_updated_at
  before update on public.plan_entitlements
  for each row
  execute function private.set_updated_at();

-- Seeded branch/staff limits — see this migration's own header comment
-- for why these specific numbers are seeded now and why that is NOT the
-- same category of decision as finalizing NGN pricing.
insert into public.plan_entitlements (plan_id, entitlement_key, value_integer)
select p.id, e.key, e.val
from public.subscription_plans p
join (values
  ('STARTER',  'branches.max', 1),
  ('STARTER',  'staff.max',    3),
  ('GROWTH',   'branches.max', 3),
  ('GROWTH',   'staff.max',    15),
  ('BUSINESS', 'branches.max', 10),
  ('BUSINESS', 'staff.max',    50)
) as e(code, key, val) on e.code = p.code;
-- ENTERPRISE deliberately has NO branches.max/staff.max row — see this
-- migration's own header comment.

-- subscription_plan_prices ------------------------------------------------
--
-- Provider/billing-cycle-specific pricing — DELIBERATELY separate from
-- subscription_plans itself (per this phase's own explicit "correct
-- separation" instruction: "BusinessOS plan: GROWTH. BusinessOS price:
-- GROWTH / MONTHLY / NGN / amount. Provider mapping: PAYSTACK / PLN_xxxxx").
-- A plan's own identity (`code`) never changes when its price changes,
-- when a new provider is added, or when an annual option is introduced.
--
-- PROVIDER: closed to PAYSTACK today — widening this list for a future
-- provider (per this phase's own "provider portability" requirement) is
-- a normal additive CHECK-constraint migration, never a destructive one.
--
-- PROVIDER_ENVIRONMENT: TEST vs LIVE, per this phase's own explicit
-- warning that "a Paystack test plan code must never be confused with a
-- production plan code" — kept as its own column (not folded into
-- provider) so a future provider can reuse the identical TEST/LIVE
-- concept without inventing a parallel one.
--
-- BILLING_INTERVAL: closed to MONTHLY/ANNUAL — this phase's own explicit
-- instruction: "Do not expose Paystack hourly/daily/etc merely because
-- Paystack supports them. BusinessOS product contract should define
-- allowed intervals."
--
-- AMOUNT_MINOR: bigint, integer minor units (kobo for NGN) — NEVER a
-- floating-point type, per this phase's own explicit instruction and
-- this schema's own established money-handling convention throughout
-- (every existing Phase 1D-1K money column already uses numeric/integer
-- types, never real/double precision/float).
create table public.subscription_plan_prices (
  id                   uuid primary key default gen_random_uuid(),
  plan_id              uuid not null references public.subscription_plans (id) on delete restrict,
  provider             text not null check (provider in ('PAYSTACK')),
  provider_environment text not null default 'LIVE' check (provider_environment in ('TEST', 'LIVE')),
  billing_interval     text not null check (billing_interval in ('MONTHLY', 'ANNUAL')),
  currency             text not null check (currency ~ '^[A-Z]{3}$'),
  amount_minor         bigint not null check (amount_minor >= 0),
  -- The provider's OWN plan code (e.g. Paystack's PLN_xxxxx) — bounded,
  -- never assumed to be a UUID (per this phase's own explicit warning).
  -- Nullable: a brand-new price row may be created locally before the
  -- corresponding provider-side plan object exists yet, and a MANUAL/
  -- enterprise price may never have one at all.
  provider_plan_code   text check (provider_plan_code is null or length(provider_plan_code) between 1 and 100),
  is_active            boolean not null default true,
  effective_from       timestamptz not null default now(),
  effective_to         timestamptz,
  created_at           timestamptz not null default now(),
  updated_at           timestamptz not null default now(),

  check (effective_to is null or effective_to > effective_from),

  -- A given provider_plan_code, within one provider+environment, must
  -- name exactly one price — multiple NULLs are still distinct under a
  -- plain UNIQUE constraint (standard Postgres NULL semantics), so this
  -- never blocks multiple prices that simply have no provider mapping
  -- yet.
  unique (provider, provider_environment, provider_plan_code),

  -- SEC-1L-03 remediation: a structural handle for
  -- business_subscriptions' own composite (price_id, plan_id) FK
  -- (next migration) so that a subscription referencing a given price
  -- can NEVER simultaneously claim a different plan than that price's
  -- own plan_id — defense in depth alongside
  -- activate_subscription_from_verified_payment's own explicit
  -- PRICE_PLAN_MISMATCH check, enforced even against a direct
  -- privileged INSERT that bypasses the trusted writer entirely. `id`
  -- alone is already the primary key, so this adds no new uniqueness
  -- requirement of its own — it only exposes (id, plan_id) as a valid
  -- FK target.
  unique (id, plan_id)
);

-- At most ONE active price per (plan, provider, environment, interval,
-- currency) combination at a time — prevents genuinely ambiguous
-- pricing ("which of these two active MONTHLY NGN Paystack-live prices
-- for GROWTH applies?") without preventing legitimate REPLACEMENT
-- (deactivate the old row, insert a new active one — a price migration,
-- never an UPDATE-in-place of a price that may already be referenced by
-- an existing subscription's own price_id).
create unique index subscription_plan_prices_active_unique_idx
  on public.subscription_plan_prices (plan_id, provider, provider_environment, billing_interval, currency)
  where is_active;

create index subscription_plan_prices_plan_idx on public.subscription_plan_prices (plan_id, is_active);

create trigger subscription_plan_prices_set_updated_at
  before update on public.subscription_plan_prices
  for each row
  execute function private.set_updated_at();

-- No price rows are seeded — see this migration's own header comment.

-- Row Level Security ---------------------------------------------------
--
-- READ MODEL: the plan CATALOG (name/description/entitlements/limits) is
-- product-facing information every active member of ANY business may
-- reasonably need to see (e.g. "what would Growth give us"), not a
-- billing-sensitive secret the way a specific business's own payment
-- provider identifiers are — gated on being authenticated at all,
-- mirroring how e.g. public.roles/public.permissions (the RBAC catalog)
-- are already readable business-membership-independent reference data
-- in this schema. Prices carry no payment-provider secrets either (a
-- provider_plan_code is not a credential), so the identical posture
-- applies. This is DELIBERATELY NOT gated on billing.view — billing.view
-- protects a SPECIFIC BUSINESS's own subscription/payment history
-- (business_subscriptions/billing_transactions, next migrations), not
-- the general product catalog.

alter table public.subscription_plans enable row level security;
alter table public.subscription_plans force row level security;
alter table public.plan_entitlements enable row level security;
alter table public.plan_entitlements force row level security;
alter table public.subscription_plan_prices enable row level security;
alter table public.subscription_plan_prices force row level security;

create policy subscription_plans_select on public.subscription_plans
  for select
  to authenticated
  using (true);

create policy plan_entitlements_select on public.plan_entitlements
  for select
  to authenticated
  using (true);

create policy subscription_plan_prices_select on public.subscription_plan_prices
  for select
  to authenticated
  using (true);

-- GRANTS — explicit, never relying on defaults (this project's own
-- `api.auto_expose_new_tables = false` convention, UNCHANGED by this
-- phase). SELECT only — no INSERT/UPDATE/DELETE for any role: the
-- catalog is managed exclusively by a future admin/support tool running
-- as service_role or a dedicated migration, never by any application
-- code path.
revoke all on public.subscription_plans from public, anon, authenticated, service_role;
grant select (id, code, name, description, is_active, is_public, sort_order, created_at)
  on public.subscription_plans to authenticated, service_role;
revoke references, trigger, truncate on public.subscription_plans from anon, authenticated;

revoke all on public.plan_entitlements from public, anon, authenticated, service_role;
grant select (id, plan_id, entitlement_key, value_integer, value_boolean, value_text)
  on public.plan_entitlements to authenticated, service_role;
revoke references, trigger, truncate on public.plan_entitlements from anon, authenticated;

revoke all on public.subscription_plan_prices from public, anon, authenticated, service_role;
grant select (id, plan_id, provider, provider_environment, billing_interval, currency, amount_minor, is_active)
  on public.subscription_plan_prices to authenticated, service_role;
revoke references, trigger, truncate on public.subscription_plan_prices from anon, authenticated;
