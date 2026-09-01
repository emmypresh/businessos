-- Phase 1H: invoice_payments — an append-only payment ledger. Payment
-- history is NEVER edited or deleted; a correction, if ever needed, is a
-- future phase's own explicit reversal/credit-note mechanism, not an
-- UPDATE/DELETE path added here.
--
-- PAYMENT BRANCH SEMANTICS (deliberate, Phase 1H product decision): a
-- payment's branch_id is ALWAYS the invoice's own branch_id — never an
-- independent caller choice. This is enforced structurally below (the
-- composite FK ties branch_id to the SAME (invoice_id, business_id) row,
-- and record_invoice_payment, the only writer, always derives it from the
-- locked invoice row, never from a parameter) — never merely a UI
-- convention a caller could bypass by calling the RPC directly. Storing
-- it as its own column (rather than requiring every reader to join
-- invoices for it) keeps branch-scoped payment reporting a plain
-- single-table filter, and keeps the historical record self-contained
-- even if a future phase ever allows an invoice's own branch to be
-- corrected.

-- Composite unique target for the branch-consistency FK below — must
-- exist BEFORE invoice_payments references it.
alter table public.invoices
  add constraint invoices_id_business_branch_unique unique (id, business_id, branch_id);

create table public.invoice_payments (
  id              uuid primary key default gen_random_uuid(),
  business_id     uuid not null references public.businesses (id) on delete cascade,
  invoice_id      uuid not null,
  branch_id       uuid not null,
  amount          numeric(14,2) not null check (amount > 0),
  payment_method  text not null check (payment_method in ('CASH', 'BANK_TRANSFER', 'POS_CARD', 'OTHER')),
  reference       text check (reference is null or length(reference) <= 200),
  note            text check (note is null or length(note) <= 500),
  paid_at         timestamptz not null default now(),
  -- Traceability only — NOT the idempotency arbiter
  -- (private.invoice_payment_requests is, next-but-one migration).
  creation_key    uuid not null,
  recorded_by     uuid not null references auth.users (id),
  created_at      timestamptz not null default now(),

  unique (id, business_id),

  -- Tenant-consistent composite FK to the invoice — a cross-tenant
  -- payment is structurally unrepresentable, matching every other
  -- Phase 1D-1G child-table treatment. Payments are genuinely OWNED by
  -- their invoice (no independent existence) — a direct CASCADE has no
  -- fan-out ordering hazard.
  foreign key (invoice_id, business_id)
    references public.invoices (id, business_id)
    on delete cascade,
  -- branch_id is tied to the SAME invoice row via this composite FK
  -- (invoice_id, business_id, branch_id) against invoices' own
  -- (id, business_id, branch_id) — a payment whose branch_id differs from
  -- its own invoice's branch_id is structurally unrepresentable, not
  -- merely RPC-checked. This is the schema-level backstop for "payment
  -- belongs to the invoice's branch" described above.
  foreign key (invoice_id, business_id, branch_id)
    references public.invoices (id, business_id, branch_id)
    on delete cascade
);

create index invoice_payments_business_invoice_idx on public.invoice_payments (business_id, invoice_id);
create index invoice_payments_business_branch_idx on public.invoice_payments (business_id, branch_id);
create index invoice_payments_business_paid_at_idx on public.invoice_payments (business_id, paid_at desc);

-- No update-timestamp trigger, no immutable-fields trigger needed beyond
-- RLS/grants themselves — every column here is written exactly once, at
-- INSERT, by record_invoice_payment (next-but-one migration), and never
-- touched again by any writer; there is no UPDATE grant on this table at
-- all (see below), so a separate enforcement trigger would be redundant
-- defense against a write path that is already structurally absent.

alter table public.invoice_payments enable row level security;
alter table public.invoice_payments force row level security;

create policy invoice_payments_select on public.invoice_payments
  for select
  to authenticated
  using (private.has_permission(business_id, 'payments.view'));

-- No INSERT/UPDATE/DELETE policy for `authenticated`, ever — fully
-- RPC-only (record_invoice_payment_rpc.sql). There is no update or delete
-- path at all, through RPC or otherwise — append-only, permanently.

revoke all on public.invoice_payments from public, anon, authenticated, service_role;
grant select (
  id, business_id, invoice_id, branch_id, amount, payment_method,
  reference, note, paid_at, recorded_by, created_at
) on public.invoice_payments to authenticated, service_role;

revoke references, trigger, truncate on public.invoice_payments from anon, authenticated;
