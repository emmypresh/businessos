-- Phase 1E: business-scoped, race-safe expense-number counter.
--
-- Exact structural mirror of private.business_sale_sequences
-- (create_business_sale_sequences.sql) — see that migration's own comment
-- for the full reasoning, repeated only in summary here: an ordinary
-- transactional table, claimed via INSERT ... ON CONFLICT DO UPDATE
-- (never MAX(expense_number) + 1), whose only schema-level guarantees are
-- uniqueness within a business and monotonically increasing allocation
-- under committed transactions — NOT permanent gaplessness, which is an
-- emergent effect of one-transaction-per-call, not a guarantee callers may
-- rely on.

create table private.business_expense_sequences (
  business_id uuid primary key references public.businesses (id) on delete cascade,
  next_number bigint not null default 1
);

alter table private.business_expense_sequences enable row level security;
alter table private.business_expense_sequences force row level security;

revoke all on private.business_expense_sequences from public, anon, authenticated, service_role;

-- Lazily created on first use by whichever business creates the first
-- expense (via INSERT ... ON CONFLICT DO UPDATE inside create_expense,
-- added in a later migration) — no backfill needed for existing
-- businesses, since the row is claimed exactly when first needed
-- regardless of when the business itself was created.
