-- Phase 1I: sale_returns (return/refund transaction headers) and
-- sale_return_items (immutable historical lines) — RETURNS + REFUNDS for
-- completed sales.
--
-- CORE DESIGN PRINCIPLE (per this phase's own product brief): a return is
-- a NEW, immutable business transaction, never a mutation of the original
-- sale. This migration never touches public.sales/public.sale_items'
-- existing columns, CHECK constraints, or write grants except to add the
-- ONE missing structural prerequisite sale_return_items needs — see the
-- ALTER below — mirrors 20260829080100_branch_aware_sales.sql's own
-- precedent of additively widening a frozen Phase 1D table via a NEW
-- migration, never editing the original migration file.
--
-- STATUS MODEL: deliberately ONE value, 'COMPLETED' — there is no draft/
-- edit/cancel/void workflow in Phase 1I (per the product brief: "If one
-- immutable completed-state representation is sufficient, do NOT add
-- unnecessary statuses"). This mirrors sales.status's own original
-- Phase 1D shape (a CHECK enumerating values no code path yet produces)
-- only in spirit, not literally — here there is no unused value at all,
-- since Phase 1I has no such future workflow planned; widening this CHECK
-- later is a normal additive migration if one is ever needed.
--
-- MONEY MODEL: refund_amount is the only money column on the header — no
-- subtotal/discount, mirroring invoices' own "no invoice-level discount
-- exists yet" scope cut. line_total on each item is server-computed from
-- the ORIGINAL sale_item's own locked unit_price snapshot — never
-- caller-supplied, never re-derived from a live (and by definition,
-- unrelated) products row.

-- Structural prerequisite: sale_return_items needs a composite FK
-- (sale_item_id, business_id) -> sale_items(id, business_id), exactly
-- like every other Phase 1C-1H child-table's tenant-consistent FK — but
-- public.sale_items (frozen at 20260826090400_create_sales_and_sale_items.sql)
-- was never given a unique(id, business_id) constraint of its own (unlike
-- public.sales, which was). Added here, additively, via ALTER — this
-- table's own migration file is never touched. Zero risk of constraint
-- violation on existing data: sale_items.id is already a PRIMARY KEY
-- (globally unique on its own), so (id, business_id) is trivially unique
-- too; this is a structural addition, not a data correction.
alter table public.sale_items
  add constraint sale_items_id_business_id_key unique (id, business_id);

create table public.sale_returns (
  id                    uuid primary key default gen_random_uuid(),
  business_id           uuid not null references public.businesses (id) on delete cascade,
  return_number         text not null,
  sale_id               uuid not null,
  -- Branch authority (Codex security audit, SEC-01 lesson applied
  -- proactively): ALWAYS derived from the referenced sale's own stored
  -- branch_id — create_sale_return (next-but-one migration) has no
  -- p_branch_id parameter at all, so there is nothing for a caller to
  -- forge. branch_name_snapshot is copied from the sale's own
  -- branch_name_snapshot (itself already an immutable historical
  -- snapshot, never re-derived from the live business_branches row) —
  -- never re-resolved from the CURRENT branch name, for the identical
  -- "a later rename must not alter how history renders" reason every
  -- other snapshot column in this schema exists for.
  branch_id             uuid not null,
  branch_name_snapshot  text not null,
  -- Single fixed value — see this file's own header comment on why no
  -- other status exists yet.
  status                text not null default 'COMPLETED' check (status = 'COMPLETED'),
  refund_amount         numeric(14,2) not null default 0 check (refund_amount >= 0),
  refund_method         text
                          check (refund_method is null or refund_method in (
                            'CASH', 'BANK_TRANSFER', 'POS_CARD', 'OTHER'
                          )),
  -- Optional controlled reason — an enum, not free text, matching this
  -- schema's own established preference for a bounded vocabulary wherever
  -- one is meaningful (mirrors payment_method's own treatment) over an
  -- uncontrolled giant text field.
  reason                text
                          check (reason is null or reason in (
                            'CUSTOMER_RETURN', 'DAMAGED', 'WRONG_ITEM', 'DEFECTIVE', 'OTHER'
                          )),
  notes                 text check (notes is null or length(notes) <= 2000),
  -- Traceability only — NOT the idempotency arbiter
  -- (private.sale_return_creation_requests is, next-but-one migration).
  creation_key          uuid not null,
  created_by            uuid not null references auth.users (id),
  created_at            timestamptz not null default now(),

  -- Real biconditional, not a one-directional OR: refund_method is
  -- required exactly when there is money to refund, and structurally
  -- absent otherwise — "refund_method should be nullable when
  -- refund_amount = 0... If refund_amount > 0: refund_method required.
  -- Enforce structurally" (this phase's own product brief).
  check ((refund_amount = 0) = (refund_method is null)),

  unique (id, business_id),
  unique (business_id, return_number),

  -- Tenant-consistent composite FKs, matching every other Phase 1C-1H
  -- child-table's own treatment exactly: NO ACTION + DEFERRABLE INITIALLY
  -- DEFERRED, so a whole-business DELETE cascades sales/business_branches/
  -- sale_returns together in one transaction without tripping a false
  -- cascade-ordering violation, while a standalone sale/branch row
  -- remains protected.
  foreign key (sale_id, business_id)
    references public.sales (id, business_id)
    on delete no action deferrable initially deferred,
  foreign key (branch_id, business_id)
    references public.business_branches (id, business_id)
    on delete no action deferrable initially deferred
);

create index sale_returns_business_created_idx on public.sale_returns (business_id, created_at desc);
create index sale_returns_business_sale_idx on public.sale_returns (business_id, sale_id);
create index sale_returns_business_branch_idx on public.sale_returns (business_id, branch_id);

-- No updated_at, no immutable-fields trigger, no UPDATE grant anywhere in
-- this migration at all — a return is written exactly once, at INSERT, by
-- create_sale_return, and never touched again by any writer. There is no
-- update path even conceptually, exactly matching sale_items'/
-- invoice_items' own "fully append-only" treatment.

create table public.sale_return_items (
  id                     uuid primary key default gen_random_uuid(),
  business_id            uuid not null references public.businesses (id) on delete cascade,
  sale_return_id         uuid not null,
  sale_item_id           uuid not null,
  -- NOT NULL: sale_items.product_id is itself NOT NULL for every sale
  -- line in this schema (Phase 1D has no custom, non-product-linked sale
  -- line the way Phase 1H invoices do) — there is no existing sale
  -- history this column would ever need to represent as null for.
  product_id             uuid not null,
  -- Historical product identity/price, loaded from the ORIGINAL,
  -- LOCKED sale_item row by create_sale_return — never caller-supplied,
  -- so there is nothing for a forged product name/SKU/price to even
  -- populate. A later product rename, reprice, or archive — and even a
  -- hypothetical future correction to the ORIGINAL sale_item's own
  -- snapshot, were one ever possible — must never alter how an
  -- already-recorded return renders.
  product_name_snapshot  text not null,
  sku_snapshot           text,
  quantity               numeric(14,3) not null check (quantity > 0),
  unit_price_snapshot    numeric(14,2) not null check (unit_price_snapshot >= 0),
  line_total             numeric(14,2) not null check (line_total >= 0),
  -- Per-line restock decision: true routes this quantity back into
  -- sellable inventory (a new SALE_RETURN ledger movement — next-but-one
  -- migration); false records the return historically with NO inventory
  -- effect at all (damaged/defective/unsellable merchandise).
  restock                boolean not null,
  -- Deterministic line order, assigned by create_sale_return from the
  -- caller's OWN submitted item order — Codex adversarial review lesson
  -- from Phase 1H (invoice_items.position) applied from day one here,
  -- never retrofitted. Never client-supplied directly: a forged position
  -- value has nothing to write to.
  position               integer not null check (position >= 0),
  created_at             timestamptz not null default now(),

  check (line_total = round(unit_price_snapshot * quantity, 2)),

  -- Enforces "unique within return" structurally, not merely by
  -- create_sale_return's own assignment discipline — mirrors
  -- invoice_items_invoice_position_idx exactly.
  unique (sale_return_id, position),

  -- sale_return_items are genuinely OWNED by their return (no independent
  -- existence) — a direct CASCADE has no fan-out ordering hazard, matching
  -- sale_items'/invoice_items' own identical treatment.
  foreign key (sale_return_id, business_id)
    references public.sale_returns (id, business_id)
    on delete cascade,
  -- Tenant-consistent composite FK to the ORIGINAL sale item — a
  -- cross-tenant or cross-sale reference is structurally unrepresentable,
  -- not merely RPC-checked. NO ACTION (sale_items are never deleted by
  -- any existing write path) so no DEFERRABLE ordering concern arises in
  -- practice, but DEFERRABLE INITIALLY DEFERRED anyway for consistency
  -- with every other child-table FK in this schema.
  foreign key (sale_item_id, business_id)
    references public.sale_items (id, business_id)
    on delete no action deferrable initially deferred,
  foreign key (product_id, business_id)
    references public.products (id, business_id)
    on delete no action deferrable initially deferred
);

create index sale_return_items_business_return_idx on public.sale_return_items (business_id, sale_return_id);
-- Critical for the return-quantity invariant: create_sale_return computes
-- "total quantity already returned for this sale_item" by summing over
-- exactly this index's leading columns.
create index sale_return_items_business_sale_item_idx on public.sale_return_items (business_id, sale_item_id);
create index sale_return_items_business_product_idx on public.sale_return_items (business_id, product_id);

-- Row Level Security ---------------------------------------------------

alter table public.sale_returns enable row level security;
alter table public.sale_returns force row level security;
alter table public.sale_return_items enable row level security;
alter table public.sale_return_items force row level security;

create policy sale_returns_select on public.sale_returns
  for select
  to authenticated
  using (private.has_permission(business_id, 'returns.view'));

create policy sale_return_items_select on public.sale_return_items
  for select
  to authenticated
  using (private.has_permission(business_id, 'returns.view'));

-- No INSERT/UPDATE/DELETE policy for `authenticated` on either table, at
-- all, ever — fully RPC-only (create_sale_return, next-but-one migration).
-- sale_return_items in particular has no update path even conceptually:
-- an already-recorded return line's quantity/restock/refund basis is
-- permanent history, exactly like sale_items'/invoice_items' own absolute
-- immutability.

revoke all on public.sale_returns from public, anon, authenticated, service_role;
grant select (
  id, business_id, return_number, sale_id, branch_id, branch_name_snapshot,
  status, refund_amount, refund_method, reason, notes,
  created_by, created_at
) on public.sale_returns to authenticated, service_role;

revoke all on public.sale_return_items from public, anon, authenticated, service_role;
grant select (
  id, business_id, sale_return_id, sale_item_id, product_id, product_name_snapshot, sku_snapshot,
  quantity, unit_price_snapshot, line_total, restock, position, created_at
) on public.sale_return_items to authenticated, service_role;

revoke references, trigger, truncate on public.sale_returns, public.sale_return_items from anon, authenticated;
