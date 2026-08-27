-- Phase 1E: expenses — immutable, postable financial records.
--
-- Creation is fully RPC-only (public.create_expense, added in a later
-- migration) — no INSERT/UPDATE/DELETE policy exists for `authenticated`
-- on this table, ever, mirroring public.create_sale's exact write-boundary
-- pattern. There is no DRAFT status: Phase 1E expense creation immediately
-- produces a POSTED financial record. The only mutation an already-created
-- expense ever undergoes is POSTED -> VOIDED, via public.void_expense
-- (also a later migration) — every other column is permanently immutable
-- once inserted, enforced independently of RLS by a trigger below so the
-- guarantee holds for every writer, not just `authenticated`.

create table public.expenses (
  id                      uuid primary key default gen_random_uuid(),
  business_id             uuid not null references public.businesses (id) on delete cascade,
  expense_number          text not null,
  category_id             uuid not null,
  -- Historical category identity, captured once at creation — never
  -- re-derived from the live expense_categories row. A later category
  -- rename must not alter how an already-posted expense renders, and an
  -- archived category must not retroactively alter it either.
  category_name_snapshot  text not null,
  amount                  numeric(14,2) not null check (amount > 0),
  -- Phase 1E is explicitly NGN-only (no multi-currency support) — the
  -- CHECK enforces the exact literal, not merely "some 3-letter code",
  -- so a structural INSERT (e.g. from a future/privileged writer) can
  -- never persist a different currency even though create_expense itself
  -- already hardcodes 'NGN' and has no parameter for a caller to
  -- influence this at all.
  currency_code           text not null default 'NGN' check (currency_code = 'NGN'),
  payment_method          text not null
                            check (payment_method in ('CASH', 'BANK_TRANSFER', 'CARD', 'OTHER')),
  payee                   text
                            check (payee is null or length(btrim(payee)) between 1 and 200),
  reference               text
                            check (reference is null or length(btrim(reference)) between 1 and 100),
  notes                   text
                            check (notes is null or length(notes) <= 2000),
  incurred_at             timestamptz not null,
  status                  text not null default 'POSTED'
                            check (status in ('POSTED', 'VOIDED')),
  -- Traceability only — NOT the idempotency arbiter
  -- (private.expense_creation_requests is), exactly matching sales'
  -- creation_key/sale_creation_requests split.
  creation_key            uuid not null,
  created_by              uuid not null references auth.users (id),
  created_at              timestamptz not null default now(),
  voided_at               timestamptz,
  voided_by               uuid references auth.users (id),
  void_reason             text
                            check (void_reason is null or length(btrim(void_reason)) between 1 and 500),

  -- Real biconditionals, not a one-directional OR: a VOIDED row without
  -- voided_at/voided_by/void_reason (or a POSTED row WITH any of them) is
  -- structurally unrepresentable — mirrors sales' own
  -- (status = 'COMPLETED') = (completed_at is not null) treatment.
  check ((status = 'VOIDED') = (voided_at is not null)),
  check ((status = 'VOIDED') = (voided_by is not null)),
  check ((status = 'VOIDED') = (void_reason is not null and length(btrim(void_reason)) > 0)),

  unique (id, business_id),
  unique (business_id, expense_number),

  -- Tenant-consistent composite FK, matching sales' own category-like
  -- references (customer_id, inventory_location_id) exactly: NO ACTION
  -- (not RESTRICT — RESTRICT cannot be deferred in Postgres) + DEFERRABLE
  -- INITIALLY DEFERRED, so a whole-business DELETE can cascade
  -- expense_categories/expenses together in one transaction without
  -- tripping a false violation on cascade-ordering, while a standalone
  -- category row stays protected (categories are never hard-deleted by
  -- application code, but the FK itself does not depend on that being
  -- true).
  foreign key (category_id, business_id)
    references public.expense_categories (id, business_id)
    on delete no action deferrable initially deferred
);

create index expenses_business_status_idx on public.expenses (business_id, status);
create index expenses_business_incurred_idx on public.expenses (business_id, incurred_at desc);
create index expenses_business_category_idx on public.expenses (business_id, category_id);

-- Every column except status/voided_at/voided_by/void_reason is
-- permanently immutable once inserted — enforced here, independent of
-- RLS/GRANTs, so the guarantee holds even for a future privileged writer
-- (belt and suspenders, matching businesses.created_by's own treatment).
-- The POSTED -> VOIDED transition itself (and only that direction) is
-- validated by public.void_expense, not by this trigger — this trigger's
-- job is solely "no OTHER column ever changes, by anyone."
create or replace function private.enforce_expense_immutable_fields()
returns trigger
language plpgsql
set search_path = pg_catalog, public
as $$
begin
  if new.business_id <> old.business_id then
    raise exception 'expenses.business_id cannot be changed' using errcode = '23514';
  end if;
  if new.expense_number <> old.expense_number then
    raise exception 'expenses.expense_number cannot be changed' using errcode = '23514';
  end if;
  if new.category_id <> old.category_id then
    raise exception 'expenses.category_id cannot be changed' using errcode = '23514';
  end if;
  if new.category_name_snapshot <> old.category_name_snapshot then
    raise exception 'expenses.category_name_snapshot cannot be changed' using errcode = '23514';
  end if;
  if new.amount <> old.amount then
    raise exception 'expenses.amount cannot be changed' using errcode = '23514';
  end if;
  if new.currency_code <> old.currency_code then
    raise exception 'expenses.currency_code cannot be changed' using errcode = '23514';
  end if;
  if new.payment_method <> old.payment_method then
    raise exception 'expenses.payment_method cannot be changed' using errcode = '23514';
  end if;
  if new.payee is distinct from old.payee then
    raise exception 'expenses.payee cannot be changed' using errcode = '23514';
  end if;
  if new.reference is distinct from old.reference then
    raise exception 'expenses.reference cannot be changed' using errcode = '23514';
  end if;
  if new.notes is distinct from old.notes then
    raise exception 'expenses.notes cannot be changed' using errcode = '23514';
  end if;
  if new.incurred_at <> old.incurred_at then
    raise exception 'expenses.incurred_at cannot be changed' using errcode = '23514';
  end if;
  if new.creation_key <> old.creation_key then
    raise exception 'expenses.creation_key cannot be changed' using errcode = '23514';
  end if;
  if new.created_by <> old.created_by then
    raise exception 'expenses.created_by cannot be changed' using errcode = '23514';
  end if;
  if new.created_at <> old.created_at then
    raise exception 'expenses.created_at cannot be changed' using errcode = '23514';
  end if;
  return new;
end;
$$;

revoke all on function private.enforce_expense_immutable_fields() from public;

create trigger expenses_enforce_immutable_fields
  before update on public.expenses
  for each row
  execute function private.enforce_expense_immutable_fields();

-- Row Level Security ---------------------------------------------------

alter table public.expenses enable row level security;
alter table public.expenses force row level security;

create policy expenses_select on public.expenses
  for select
  to authenticated
  using (private.has_permission(business_id, 'expenses.view'));

-- No INSERT/UPDATE/DELETE policy for `authenticated` on this table, at
-- all, ever — fully RPC-only (create_expense / void_expense, later
-- migrations). "Financial records are created/voided through RPC only" is
-- absolute, not merely excluded from a grant list.

revoke all on public.expenses from public, anon, authenticated, service_role;

-- creation_key deliberately excluded from the SELECT grant — internal
-- mutation-control metadata, not a display field, matching products'/
-- sales' own creation_key treatment exactly.
grant select (
  id, business_id, expense_number, category_id, category_name_snapshot,
  amount, currency_code, payment_method, payee, reference, notes,
  incurred_at, status, created_by, created_at,
  voided_at, voided_by, void_reason
) on public.expenses to authenticated, service_role;

revoke references, trigger, truncate on public.expenses from anon, authenticated;
