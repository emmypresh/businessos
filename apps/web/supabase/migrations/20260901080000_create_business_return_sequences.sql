-- Phase 1I: business-scoped, race-safe return-number counter.
--
-- Mirrors private.business_sale_sequences/private.business_invoice_sequences
-- exactly — an ordinary transactional table, no independent locking
-- mechanism of its own: the schema-level guarantees are exactly two,
-- uniqueness within a business and monotonically increasing allocation
-- under committed transactions, both provided by ordinary row-level
-- locking on this table's UPDATE path (INSERT ... ON CONFLICT DO UPDATE
-- inside create_sale_return, next-but-two migration), never MAX()+1.

create table private.business_return_sequences (
  business_id uuid primary key references public.businesses (id) on delete cascade,
  next_number bigint not null default 1
);

alter table private.business_return_sequences enable row level security;
alter table private.business_return_sequences force row level security;

revoke all on private.business_return_sequences from public, anon, authenticated, service_role;

-- Lazily created on first use by whichever business creates the first
-- return (via INSERT ... ON CONFLICT DO UPDATE inside create_sale_return)
-- — no backfill needed, exactly like its sale/invoice counterparts.
