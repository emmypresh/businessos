-- Phase 1D: business-scoped, race-safe sale-number counter.
--
-- An ordinary transactional table — it participates in whatever
-- transaction calls it exactly like any other row write. A failed
-- create_sale attempt (any exception raised anywhere in that function)
-- rolls back its counter increment together with everything else in the
-- same transaction, since the whole function body is one transaction.
-- Under normal operation this means a rolled-back attempt never
-- "consumes" a sale number — the next successful attempt allocates the
-- same value that would have been allocated regardless. This is NOT the
-- same claim as "sale numbers are permanently gapless": that property is
-- an emergent effect of the current one-transaction-per-call
-- implementation, not something the schema itself guarantees or that
-- call sites should rely on (a future administrative deletion of a
-- committed sale, for instance, correctly leaves its number permanently
-- retired — reuse would be the actual bug). The schema-level guarantees
-- are exactly two: uniqueness within a business, and monotonically
-- increasing allocation under committed transactions — both provided by
-- ordinary row-level locking on this table's UPDATE path, never MAX()+1.

create table private.business_sale_sequences (
  business_id uuid primary key references public.businesses (id) on delete cascade,
  next_number bigint not null default 1
);

alter table private.business_sale_sequences enable row level security;
alter table private.business_sale_sequences force row level security;

revoke all on private.business_sale_sequences from public, anon, authenticated, service_role;

-- Lazily created on first use by whichever business creates the first
-- sale (via INSERT ... ON CONFLICT DO UPDATE inside create_sale, next
-- migration) — no backfill needed for existing businesses, since the row
-- is claimed exactly when first needed regardless of when the business
-- itself was created.
