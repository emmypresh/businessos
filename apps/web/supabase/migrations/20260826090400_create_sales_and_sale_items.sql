-- Phase 1D: sales (order headers) and sale_items (immutable historical
-- lines).
--
-- Creation is fully RPC-only — no INSERT/UPDATE/DELETE policy exists for
-- `authenticated` on either table, ever. public.create_sale (next
-- migration) atomically produces a COMPLETED sale in one transaction;
-- there is no committed DRAFT/CANCELLED state in Phase 1D, no
-- complete_sale, no cancel_sale. The status/payment_status domains stay
-- structurally open (DRAFT and CANCELLED remain valid CHECK values) for a
-- future phase, but no Phase 1D code path ever produces either as a
-- committed row.

create table public.sales (
  id                         uuid primary key default gen_random_uuid(),
  business_id                uuid not null references public.businesses (id) on delete cascade,
  customer_id                uuid,
  -- Historical customer identity, captured once at creation — never
  -- re-derived from the live customers row. A later customer edit must
  -- not alter how this sale renders; an anonymous/walk-in sale leaves
  -- customer_id AND every snapshot null together.
  customer_name_snapshot     text,
  customer_phone_snapshot    text,
  customer_email_snapshot    text,
  customer_address_snapshot  text,
  -- Historical location identity, captured once at creation for the same
  -- reason — a location rename later must not alter how this sale
  -- renders, and Phase 1D's single-default-location model is what this
  -- column ties the sale to permanently, in preparation for a future
  -- multi-location phase without requiring a redesign.
  inventory_location_id      uuid not null,
  inventory_location_name_snapshot text not null,
  sale_number                 text not null,
  status                       text not null default 'DRAFT'
                                  check (status in ('DRAFT', 'COMPLETED', 'CANCELLED')),
  payment_status               text not null default 'UNPAID'
                                  check (payment_status in ('UNPAID', 'PARTIALLY_PAID', 'PAID')),
  payment_method                text
                                  check (payment_method is null
                                    or payment_method in ('CASH', 'BANK_TRANSFER', 'CARD', 'OTHER')),
  subtotal                      numeric(14,2) not null default 0 check (subtotal >= 0),
  discount                      numeric(14,2) not null default 0 check (discount >= 0),
  total                         numeric(14,2) not null default 0 check (total >= 0),
  amount_paid                   numeric(14,2) not null default 0 check (amount_paid >= 0),
  currency_code                 text not null default 'NGN' check (currency_code ~ '^[A-Z]{3}$'),
  notes                         text check (notes is null or length(notes) <= 2000),
  -- Traceability only — NOT the idempotency arbiter (private.sale_creation_requests is).
  creation_key                  uuid not null,
  created_by                     uuid not null references auth.users (id),
  created_at                     timestamptz not null default now(),
  updated_at                     timestamptz not null default now(),
  completed_at                   timestamptz,
  cancelled_at                   timestamptz,

  check (discount <= subtotal),
  check (total = subtotal - discount),

  -- Real biconditionals, not a one-directional OR: a COMPLETED row without
  -- completed_at (or vice versa) is structurally unrepresentable.
  check ((status = 'COMPLETED') = (completed_at is not null)),
  check ((status = 'CANCELLED') = (cancelled_at is not null)),

  -- Full row-local payment consistency — every payment_status value fully
  -- enumerated, no state left unchecked. amount_paid is meaningful only
  -- for PARTIALLY_PAID; UNPAID and PAID both force it to a single
  -- deterministic value tied to payment_status/total.
  check (
    (payment_status = 'UNPAID'
      and amount_paid = 0
      and payment_method is null)
    or (payment_status = 'PARTIALLY_PAID'
      and total > 0 and amount_paid > 0 and amount_paid < total
      and payment_method is not null)
    or (payment_status = 'PAID'
      and amount_paid = total
      and (total = 0 or payment_method is not null))
  ),

  -- Customer-snapshot structural invariants (correction 5): an anonymous
  -- sale has customer_id AND every snapshot null together; a customer sale
  -- always has at least its name snapshot populated (phone/email/address
  -- remain independently optional, matching the customer's own optional
  -- fields).
  check (customer_id is not null or (
    customer_name_snapshot is null and customer_phone_snapshot is null
    and customer_email_snapshot is null and customer_address_snapshot is null
  )),
  check (customer_id is null or customer_name_snapshot is not null),

  unique (id, business_id),
  unique (business_id, sale_number),

  -- Tenant-consistent composite FKs, matching inventory_ledger's own
  -- product_id/inventory_location_id treatment exactly: NO ACTION (not
  -- RESTRICT — RESTRICT cannot be deferred in Postgres) + DEFERRABLE
  -- INITIALLY DEFERRED, so a whole-business DELETE cascades
  -- customers/inventory_locations/sales together in one transaction
  -- without tripping a false violation on cascade-ordering, while a
  -- standalone customer/location row is still protected (customers/
  -- locations are never hard-deleted by application code, but the FK
  -- itself does not depend on that being true).
  foreign key (customer_id, business_id)
    references public.customers (id, business_id)
    on delete no action deferrable initially deferred,
  foreign key (inventory_location_id, business_id)
    references public.inventory_locations (id, business_id)
    on delete no action deferrable initially deferred
);

create index sales_business_status_idx on public.sales (business_id, status);
create index sales_business_created_idx on public.sales (business_id, created_at desc);
create index sales_business_customer_idx on public.sales (business_id, customer_id);
create index sales_business_payment_status_idx on public.sales (business_id, payment_status);

create table public.sale_items (
  id                    uuid primary key default gen_random_uuid(),
  business_id           uuid not null references public.businesses (id) on delete cascade,
  sale_id               uuid not null,
  product_id            uuid not null,
  -- Historical product identity/price, captured once at creation from the
  -- FOR SHARE-locked products row — never re-derived. A later product
  -- rename/reprice/archive must not alter how this line renders.
  product_name_snapshot text not null,
  sku_snapshot          text,
  unit_price            numeric(14,2) not null check (unit_price >= 0),
  quantity              numeric(14,3) not null check (quantity > 0),
  line_total            numeric(14,2) not null check (line_total >= 0),
  -- The configured product-cost snapshot at sale time (products.cost_price
  -- as read from the same locked row). This is NOT formal accounting
  -- COGS — no landed cost, no weighted-average/FIFO, no returns
  -- adjustment; a future accounting phase may compute COGS differently.
  -- Captured now (free — the row is already locked and read for the
  -- price snapshot) so no historical gap exists once a profitability
  -- report is eventually built; never exposed via the ordinary SELECT
  -- grant below, and no accessor function exists in Phase 1D.
  unit_cost_snapshot    numeric(14,2) check (unit_cost_snapshot is null or unit_cost_snapshot >= 0),
  created_at            timestamptz not null default now(),

  check (line_total = round(unit_price * quantity, 2)),

  -- sale_items are genuinely OWNED by their sale (no independent
  -- existence, unlike a ledger row referencing a product) — a direct
  -- CASCADE has no fan-out ordering hazard, so unlike the FKs below it
  -- needs no DEFERRABLE.
  foreign key (sale_id, business_id)
    references public.sales (id, business_id)
    on delete cascade,
  -- product_id mirrors inventory_ledger's own product FK treatment
  -- exactly, for the exact same whole-business-cascade-ordering reason.
  foreign key (product_id, business_id)
    references public.products (id, business_id)
    on delete no action deferrable initially deferred
);

create index sale_items_business_sale_idx on public.sale_items (business_id, sale_id);
create index sale_items_business_product_idx on public.sale_items (business_id, product_id);

create trigger sales_set_updated_at
  before update on public.sales
  for each row
  execute function private.set_updated_at();

-- Row Level Security ---------------------------------------------------

alter table public.sales enable row level security;
alter table public.sales force row level security;
alter table public.sale_items enable row level security;
alter table public.sale_items force row level security;

create policy sales_select on public.sales
  for select
  to authenticated
  using (private.has_permission(business_id, 'sales.view'));

create policy sale_items_select on public.sale_items
  for select
  to authenticated
  using (private.has_permission(business_id, 'sales.view'));

-- No INSERT/UPDATE/DELETE policy for `authenticated` on either table, at
-- all, ever — fully RPC-only (next migration). sale_items in particular
-- has no update path even conceptually: "preserve immutable historical
-- sale-line pricing" is absolute, not merely excluded from a grant list.

revoke all on public.sales from public, anon, authenticated, service_role;
grant select (
  id, business_id, customer_id,
  customer_name_snapshot, customer_phone_snapshot, customer_email_snapshot, customer_address_snapshot,
  inventory_location_id, inventory_location_name_snapshot,
  sale_number, status, payment_status, payment_method,
  subtotal, discount, total, amount_paid, currency_code, notes,
  created_by, created_at, updated_at, completed_at, cancelled_at
) on public.sales to authenticated, service_role;

revoke all on public.sale_items from public, anon, authenticated, service_role;
grant select (
  id, business_id, sale_id, product_id, product_name_snapshot, sku_snapshot,
  unit_price, quantity, line_total, created_at
) on public.sale_items to authenticated, service_role;
-- unit_cost_snapshot deliberately excluded from the SELECT column list
-- above for BOTH roles — no client-role SELECT, filtered or otherwise,
-- can ever read it (Postgres denies the whole query, not just the
-- column, when a role lacks privilege on any column referenced,
-- select("*") included).

revoke references, trigger, truncate on public.sales, public.sale_items from anon, authenticated;
