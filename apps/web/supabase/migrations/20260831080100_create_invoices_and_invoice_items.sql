-- Phase 1H: invoices (receivable documents) and invoice_items (immutable
-- historical lines) — mirrors public.sales/public.sale_items' own table
-- shape and RPC-only-mutation design exactly
-- (20260826090400_create_sales_and_sale_items.sql).
--
-- INVOICE vs SALE (deliberate, permanent distinction — never merged):
-- a sale is an immediately-completed transaction (Phase 1D); an invoice
-- is a receivable that may sit unpaid or partially paid for a period of
-- time. Nothing in this phase converts one into the other, and no shared
-- table backs both — invoices.customer_id/branch_id/snapshot columns
-- happen to look similar to sales' own because they solve the identical
-- "preserve historical identity" problem, not because the two concepts
-- are secretly one.
--
-- STATUS MODEL — four states, no DRAFT: ISSUED, PARTIALLY_PAID, PAID,
-- VOID. An invoice is created directly as ISSUED (create_invoice, next
-- migration) — Phase 1H has no edit-after-create workflow, so a DRAFT
-- state with nothing that can transition it would only add complexity
-- (an extra status to check everywhere, an extra "how does a DRAFT
-- become ISSUED" RPC to design) without a single real workflow needing
-- it. OVERDUE is deliberately NEVER a stored status — it is a derived
-- read-time fact (status not in (PAID, VOID) and due_date is in the past
-- and balance > 0), computed identically wherever it's shown, never
-- written to a column that could drift from the truth it's supposed to
-- reflect.
--
-- MONEY MODEL — total_amount + amount_paid only, no subtotal/discount
-- columns. Phase 1H has no invoice-level discount at all (a deliberate
-- scope cut — see this phase's own product brief), so subtotal would
-- always equal total_amount; storing both would only add an invariant
-- (subtotal = total_amount, forever) with no information the second
-- column ever actually carries. balance_due is never stored — it is
-- total_amount - amount_paid, computed identically by every reader
-- (application code and the RPCs below), never persisted where it could
-- drift out of sync with the two source columns.

create table public.invoices (
  id                      uuid primary key default gen_random_uuid(),
  business_id             uuid not null references public.businesses (id) on delete cascade,
  invoice_number          text not null,
  customer_id             uuid not null,
  -- Historical customer identity, captured once at creation — never
  -- re-derived from the live customers row, exactly matching sales' own
  -- snapshot treatment. Unlike sales, customer_id is NOT NULL here: an
  -- invoice is always billed to a specific customer (there is no
  -- "walk-in invoice" concept the way there is a walk-in sale).
  customer_name_snapshot  text not null,
  customer_phone_snapshot text,
  customer_email_snapshot text,
  branch_id               uuid not null,
  branch_name_snapshot    text not null,
  status                  text not null default 'ISSUED'
                            check (status in ('ISSUED', 'PARTIALLY_PAID', 'PAID', 'VOID')),
  issued_at               timestamptz not null default now(),
  due_date                date,
  total_amount            numeric(14,2) not null check (total_amount > 0),
  amount_paid             numeric(14,2) not null default 0 check (amount_paid >= 0),
  notes                   text check (notes is null or length(notes) <= 2000),
  -- Traceability only — NOT the idempotency arbiter
  -- (private.invoice_creation_requests is, next-but-one migration).
  creation_key            uuid not null,
  created_by              uuid not null references auth.users (id),
  created_at              timestamptz not null default now(),
  updated_at              timestamptz not null default now(),
  voided_at               timestamptz,
  voided_by               uuid references auth.users (id),

  check (amount_paid <= total_amount),

  -- Full row-local status/payment consistency — every status value fully
  -- enumerated, no state left unchecked. Mirrors sales' own
  -- payment_status CHECK exactly, adapted to invoices' own four-state
  -- model.
  check (
    (status = 'ISSUED' and amount_paid = 0)
    or (status = 'PARTIALLY_PAID' and amount_paid > 0 and amount_paid < total_amount)
    or (status = 'PAID' and amount_paid = total_amount)
    -- A VOID invoice can never carry a payment (record_invoice_payment,
    -- Migration 5, refuses to pay a VOID invoice, and void_invoice,
    -- Migration 6, refuses to void an invoice with any payment) — this
    -- CHECK is the schema-level backstop for that same rule, independent
    -- of either RPC.
    or (status = 'VOID' and amount_paid = 0)
  ),

  -- Real biconditional, not a one-directional OR: a VOID row without
  -- voided_at (or vice versa) is structurally unrepresentable. Mirrors
  -- sales' own completed_at/cancelled_at biconditional treatment.
  check ((status = 'VOID') = (voided_at is not null)),
  check ((status = 'VOID') = (voided_by is not null)),

  unique (id, business_id),
  unique (business_id, invoice_number),

  -- Tenant-consistent composite FKs — a cross-tenant customer/branch
  -- reference is structurally unrepresentable, matching sales'
  -- customer_id/inventory_location_id FK treatment exactly (NO ACTION +
  -- DEFERRABLE INITIALLY DEFERRED, so a whole-business DELETE cascades
  -- customers/business_branches/invoices together without tripping a
  -- false cascade-ordering violation).
  foreign key (customer_id, business_id)
    references public.customers (id, business_id)
    on delete no action deferrable initially deferred,
  foreign key (branch_id, business_id)
    references public.business_branches (id, business_id)
    on delete no action deferrable initially deferred
);

create index invoices_business_status_idx on public.invoices (business_id, status);
create index invoices_business_created_idx on public.invoices (business_id, created_at desc);
create index invoices_business_customer_idx on public.invoices (business_id, customer_id);
create index invoices_business_branch_idx on public.invoices (business_id, branch_id);
create index invoices_business_due_date_idx on public.invoices (business_id, due_date);

create table public.invoice_items (
  id                    uuid primary key default gen_random_uuid(),
  business_id           uuid not null references public.businesses (id) on delete cascade,
  invoice_id            uuid not null,
  -- Nullable: a product-linked line (the common case) vs. a custom
  -- charge line (e.g. "Delivery fee") with no catalog product behind it.
  -- At least one of product_id/description must carry real content — see
  -- the CHECK below — an invoice line is never genuinely blank.
  product_id            uuid,
  -- Historical product identity, captured once at creation from the
  -- FOR SHARE-locked products row — never re-derived, exactly matching
  -- sale_items' own product_name_snapshot/sku_snapshot treatment. Null
  -- for a custom (no product_id) line.
  product_name_snapshot text,
  sku_snapshot          text,
  -- The line's own display text. For a product-linked line this is
  -- ALWAYS the product's own name snapshot (server-set, never a
  -- caller-supplied override — see create_invoice's own comment on why);
  -- for a custom line this is the caller-supplied description, which
  -- must be present since there is no product name to fall back on.
  description           text not null check (length(btrim(description)) >= 1 and length(description) <= 500),
  quantity              numeric(14,3) not null check (quantity > 0),
  unit_price            numeric(14,2) not null check (unit_price >= 0),
  line_total            numeric(14,2) not null check (line_total >= 0),
  -- Codex adversarial review, remediation round 1, Low 5: the caller's
  -- OWN submitted item order is a deliberate, meaningful choice (a
  -- delivery fee usually belongs last, a headline product first) that
  -- must survive storage and redisplay — created_at alone cannot
  -- reliably reconstruct it (two lines inserted in the same statement/
  -- transaction can share an identical, or even out-of-order, timestamp
  -- depending on clock resolution). Assigned by create_invoice
  -- (next-but-one migration) as a 0-based index over the caller's own
  -- submitted array order — never client-supplied directly, so a forged
  -- position value has nothing to write to. Unique per invoice (see the
  -- index below) so "the order" is never ambiguous.
  position              integer not null check (position >= 0),
  created_at            timestamptz not null default now(),

  check (line_total = round(unit_price * quantity, 2)),
  -- A product-linked line always carries its own name snapshot; a
  -- custom line never does (there is no product row to have snapshotted)
  -- — the same real biconditional pattern sales_and_sale_items.sql
  -- itself uses for customer_id/customer_name_snapshot.
  check ((product_id is not null) = (product_name_snapshot is not null)),

  -- invoice_items are genuinely OWNED by their invoice (no independent
  -- existence) — a direct CASCADE has no fan-out ordering hazard, unlike
  -- the FKs below, matching sale_items' own identical treatment.
  foreign key (invoice_id, business_id)
    references public.invoices (id, business_id)
    on delete cascade,
  foreign key (product_id, business_id)
    references public.products (id, business_id)
    on delete no action deferrable initially deferred
);

create index invoice_items_business_invoice_idx on public.invoice_items (business_id, invoice_id);
create index invoice_items_business_product_idx on public.invoice_items (business_id, product_id);
-- Enforces "unique within invoice" structurally, not merely by
-- create_invoice's own assignment discipline — a second writer (there is
-- none today, but this is a real schema-level guarantee regardless)
-- could never produce two lines claiming the same position.
create unique index invoice_items_invoice_position_idx on public.invoice_items (invoice_id, position);

create trigger invoices_set_updated_at
  before update on public.invoices
  for each row
  execute function private.set_updated_at();

-- business_id/customer_id/branch_id/invoice_number/creation_key/created_by
-- are fixed at creation time — never reassignable after the fact by any
-- writer, independent of RLS. Mirrors products'/customers'/sales' own
-- immutable-field triggers exactly. status/amount_paid/voided_at/voided_by/
-- updated_at are deliberately EXCLUDED here — those are the columns
-- record_invoice_payment/void_invoice (Migrations 5/6) are specifically
-- authorized to write; this trigger only locks down the columns no RPC
-- ever touches after INSERT.
create or replace function private.enforce_invoice_immutable_fields()
returns trigger
language plpgsql
set search_path = pg_catalog, public
as $$
begin
  if new.business_id <> old.business_id then
    raise exception 'invoices.business_id cannot be changed' using errcode = '23514';
  end if;
  if new.customer_id <> old.customer_id then
    raise exception 'invoices.customer_id cannot be changed' using errcode = '23514';
  end if;
  if new.branch_id <> old.branch_id then
    raise exception 'invoices.branch_id cannot be changed' using errcode = '23514';
  end if;
  if new.invoice_number <> old.invoice_number then
    raise exception 'invoices.invoice_number cannot be changed' using errcode = '23514';
  end if;
  if new.creation_key <> old.creation_key then
    raise exception 'invoices.creation_key cannot be changed' using errcode = '23514';
  end if;
  if new.created_by <> old.created_by then
    raise exception 'invoices.created_by cannot be changed' using errcode = '23514';
  end if;
  return new;
end;
$$;

revoke all on function private.enforce_invoice_immutable_fields() from public;

create trigger invoices_enforce_immutable_fields
  before update on public.invoices
  for each row
  execute function private.enforce_invoice_immutable_fields();

-- Row Level Security ---------------------------------------------------

alter table public.invoices enable row level security;
alter table public.invoices force row level security;
alter table public.invoice_items enable row level security;
alter table public.invoice_items force row level security;

create policy invoices_select on public.invoices
  for select
  to authenticated
  using (private.has_permission(business_id, 'invoices.view'));

create policy invoice_items_select on public.invoice_items
  for select
  to authenticated
  using (private.has_permission(business_id, 'invoices.view'));

-- No INSERT/UPDATE/DELETE policy for `authenticated` on either table, at
-- all, ever — fully RPC-only (create_invoice_rpc.sql, record_invoice_payment_rpc.sql,
-- invoice_void_rpc.sql). invoice_items in particular has no update path
-- even conceptually — an invoice line's price/quantity is fixed at
-- creation time, permanently.

revoke all on public.invoices from public, anon, authenticated, service_role;
grant select (
  id, business_id, invoice_number, customer_id,
  customer_name_snapshot, customer_phone_snapshot, customer_email_snapshot,
  branch_id, branch_name_snapshot,
  status, issued_at, due_date, total_amount, amount_paid, notes,
  created_by, created_at, updated_at, voided_at, voided_by
) on public.invoices to authenticated, service_role;

revoke all on public.invoice_items from public, anon, authenticated, service_role;
grant select (
  id, business_id, invoice_id, product_id, product_name_snapshot, sku_snapshot,
  description, quantity, unit_price, line_total, position, created_at
) on public.invoice_items to authenticated, service_role;

revoke references, trigger, truncate on public.invoices, public.invoice_items from anon, authenticated;
