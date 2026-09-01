-- Phase 1H: business-scoped, race-safe invoice-number counter.
--
-- Identical shape and reasoning to private.business_sale_sequences
-- (20260826090300_create_business_sale_sequences.sql) — a plain
-- transactional counter table, incremented via ordinary row-level
-- locking on its own UPDATE path (never MAX()+1), never independently
-- guaranteed gapless (a rolled-back create_invoice attempt never commits
-- its increment, so gaps only ever arise from a later administrative
-- action on a committed invoice, never from this table's own design).
-- Lazily created on first use per business — no backfill needed.

create table private.business_invoice_sequences (
  business_id uuid primary key references public.businesses (id) on delete cascade,
  next_number bigint not null default 1
);

alter table private.business_invoice_sequences enable row level security;
alter table private.business_invoice_sequences force row level security;

revoke all on private.business_invoice_sequences from public, anon, authenticated, service_role;
