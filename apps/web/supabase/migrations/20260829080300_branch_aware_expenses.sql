-- Phase 1G: branch-aware expenses.
--
-- expenses.branch_id is NULLABLE — NULL means "business-wide" (company
-- legal fees, a software subscription, owner-level overhead), a real value
-- means "attributed to that specific branch" (branch rent, branch
-- electricity, branch supplies). Every existing (pre-Phase-1G) expense
-- backfills to NULL — this is not an arbitrary default, it is the
-- factually correct historical statement: no Phase 1E expense was ever
-- attributed to a branch, because branches did not exist yet when it was
-- posted. No UPDATE/backfill statement is needed at all; the new column's
-- own default (implicit NULL, since none is declared) already produces
-- the correct value for every existing row.
--
-- REASONED DECISION — branch ACCESS is deliberately NOT required to post
-- or view a branch-attributed expense, unlike sales.create's own
-- has_branch_access gate (previous-but-one migration). expenses.manage is
-- held by OWNER, ADMIN, MANAGER, and ACCOUNTANT (expenses_reports_permissions.sql)
-- — the business's back-office/financial-management tier, not a
-- branch-operational role the way SALES is for sales.create. A real SME
-- workflow this must support: an ACCOUNTANT working centrally records
-- "Branch A's electricity bill" or "Branch B's rent" as routine back-
-- office bookkeeping, without being personally assigned to (or physically
-- present at) Branch A or Branch B at all — unlike a sale, which happens
-- AT the point of sale and is legitimately gated on the seller's own
-- operational presence there. Requiring has_branch_access here would
-- incorrectly treat expense posting as branch-operational work when it is
-- actually financial-management work that already has its own,
-- sufficient, business-wide gate (expenses.manage) — exactly the
-- "do not blindly impose branch access on finance/admin roles" case the
-- Phase 1G brief calls out explicitly. branch_id therefore gets the SAME
-- treatment as category_id already has in this function: real, same-
-- tenant, and (for a branch-specific expense) ACTIVE at posting time —
-- pure referenced-resource validation, checked only on the new-claim path,
-- never a caller-standing gate.

alter table public.expenses
  add column branch_id uuid,
  -- Nullable, and null EXACTLY when branch_id is null — mirrors
  -- category_name_snapshot's own "never re-derive from a later-mutable
  -- row" treatment, just optional here since the branch attribution
  -- itself is optional. A branch rename after the fact must not alter how
  -- an already-posted branch-attributed expense renders.
  add column branch_name_snapshot text,
  add constraint expenses_branch_snapshot_biconditional
    check ((branch_id is null) = (branch_name_snapshot is null));

alter table public.expenses
  add constraint expenses_branch_id_business_id_fkey
  foreign key (branch_id, business_id)
  references public.business_branches (id, business_id)
  on delete no action deferrable initially deferred;

create index expenses_business_branch_idx on public.expenses (business_id, branch_id);

-- expenses_enforce_immutable_fields (create_expenses.sql) must also guard
-- the two new columns — every other column on this table is permanently
-- immutable once inserted, by a writer-independent trigger; branch_id/
-- branch_name_snapshot are exactly as immutable as category_id/
-- category_name_snapshot, for the identical reason (a later reassignment
-- would silently rewrite financial history). CREATE OR REPLACE on the
-- SAME trigger function — the trigger itself (create_expenses.sql's
-- expenses_enforce_immutable_fields) is not re-created and needs no
-- changes of its own, since a trigger just calls whatever the function
-- currently is.
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
  if new.branch_id is distinct from old.branch_id then
    raise exception 'expenses.branch_id cannot be changed' using errcode = '23514';
  end if;
  if new.branch_name_snapshot is distinct from old.branch_name_snapshot then
    raise exception 'expenses.branch_name_snapshot cannot be changed' using errcode = '23514';
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

-- Grants ------------------------------------------------------------------

-- authenticated/service_role's existing SELECT grant on public.expenses is
-- column-restricted (create_expenses.sql) — the two new columns must be
-- added explicitly.
grant select (branch_id, branch_name_snapshot) on public.expenses to authenticated, service_role;

-- private_expense_writer's existing INSERT grant on public.expenses is
-- already narrowed to an explicit column list (create_expense_creation_requests_and_rpc.sql) —
-- unlike private_sale_writer's unrestricted one on public.sales, this one
-- genuinely needs the two new columns added.
grant insert (branch_id, branch_name_snapshot) on public.expenses to private_expense_writer;
grant select (id, business_id, name, status) on public.business_branches to private_expense_writer;

-- CRITICAL: see branch_aware_sales.sql's own identical comment — CREATE OR
-- REPLACE FUNCTION only replaces a function whose argument-TYPE list is
-- unchanged; appending p_branch_id changes it, so the OLD nine-parameter
-- signature must be dropped explicitly first, or it would coexist as a
-- second overload and break PostgREST's function resolution for every
-- ordinary call. This drops only that exact function object; the
-- migration FILE that originally created it is untouched.
drop function if exists public.create_expense(uuid, uuid, uuid, numeric, text, timestamptz, text, text, text);

create or replace function public.create_expense(
  p_business_id    uuid,
  p_creation_key   uuid,
  p_category_id    uuid,
  p_amount         numeric,
  p_payment_method text,
  p_incurred_at    timestamptz,
  p_payee          text default null,
  p_reference      text default null,
  p_notes          text default null,
  -- NEW, appended last, defaulted — Postgres allows appending defaulted
  -- parameters to an existing function's signature via CREATE OR REPLACE;
  -- it does not allow reordering or removing any existing one, and this
  -- does neither. PostgREST resolves RPC calls by NAMED parameter from the
  -- JSON body it receives, so the current Phase 1F application — which
  -- never sends a `p_branch_id` key at all — keeps calling this exact
  -- function exactly as before and simply gets NULL (business-wide),
  -- exactly matching every expense it has ever posted to date.
  p_branch_id      uuid default null
)
returns uuid  -- expense_id ONLY — never the full row, never a composite
              -- that could later leak an internal column merely because
              -- the table gained one.
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_uid                uuid;

  -- The exact maximum representable value of a numeric(14,2) column
  -- (precision 14, scale 2 -> 12 digits before the decimal point):
  -- 999,999,999,999.99. Mirrors create_sale's own v_max_money exactly —
  -- validated in an UNCONSTRAINED `numeric` local BEFORE ever being
  -- assigned into a numeric(14,2) column, so an out-of-range value never
  -- surfaces Postgres's own raw "numeric field overflow" error as the
  -- public contract.
  v_max_money          constant numeric := 999999999999.99;

  v_amount             numeric;
  -- The narrowed, numeric(14,2)-scaled candidate — used for the round-trip
  -- precision proof below, then as the ONE canonical representation of
  -- the amount from that point on (the INSERT, and the canonical payload
  -- both read v_amount_narrowed, never v_amount, once validated).
  v_amount_narrowed    numeric(14,2);
  v_payment_method     text;
  v_payee              text;
  v_reference          text;
  v_notes              text;
  v_incurred_at        timestamptz;

  v_canonical_payload  jsonb;
  -- Loaded via an explicit column list (never `select *`) — the narrowed
  -- SELECT grant on private.expense_creation_requests (see the role grant
  -- above) covers exactly canonical_payload/expense_id, not created_at,
  -- so `select * into a-full-row-record` would fail with "permission
  -- denied" for the excluded column.
  v_stored_payload     jsonb;
  v_stored_expense_id  uuid;
  v_expense_id         uuid;

  -- New-claim-only locals — current category/branch-state validation,
  -- never consulted on a replay.
  v_category_business_id uuid;
  v_category_name         text;
  v_category_status        text;
  v_branch_business_id      uuid;
  v_branch_name              text;
  v_branch_status             text;
  v_seq_number                bigint;
  v_expense_number              text;
begin
  -- 1) AUTHENTICATE
  v_uid := private.current_uid();
  if v_uid is null then
    raise exception 'authentication required' using errcode = '28000';
  end if;

  if p_business_id is null or p_creation_key is null or p_category_id is null then
    raise exception 'p_business_id, p_creation_key, and p_category_id are required'
      using errcode = '22023';
  end if;

  -- 2) AUTHORIZE — the caller's OWN permission, never "mutable referenced
  -- category/branch state", so this is always safe to re-check on every
  -- call, replay or not. See this file's own header comment for why this
  -- deliberately stays the ONLY authorization gate — no has_branch_access
  -- check is added here, unlike create_sale's.
  if not private.has_permission(p_business_id, 'expenses.manage') then
    raise exception 'insufficient_privilege' using errcode = '42501';
  end if;

  -- 3) NORMALIZE + VALIDATE INPUT SHAPE ONLY. Every malformed-input error
  -- below is controlled and happens BEFORE any lookup against the
  -- category's/branch's current state, and BEFORE the idempotency claim —
  -- so the claim's canonical payload is always built from already-
  -- validated, normalized values.

  if p_amount is null or p_amount <= 0 then
    raise exception 'INVALID_EXPENSE_AMOUNT' using errcode = '22023';
  end if;
  if p_amount > v_max_money then
    raise exception 'EXPENSE_AMOUNT_OUT_OF_RANGE' using errcode = '22023';
  end if;
  v_amount := p_amount;

  -- Excess precision (more than 2 decimal places) must be REJECTED, never
  -- silently rounded — mirrors create_sale's own quantity round-trip proof
  -- exactly (see that function's comment for the full reasoning). Casting
  -- to numeric(14,2) ROUNDS (1.234 -> 1.23) rather than raising, so
  -- proving the narrowed candidate is numerically EQUAL to the original
  -- unconstrained value is what makes this a genuine round-trip proof
  -- rather than textual decimal-place counting. Done here, on the
  -- unconstrained local, BEFORE the idempotency claim below — an
  -- excess-precision amount never reaches the request-ledger, the
  -- sequence table, or the expenses table at all.
  v_amount_narrowed := v_amount::numeric(14,2);
  if v_amount_narrowed <> v_amount then
    raise exception 'INVALID_EXPENSE_AMOUNT' using errcode = '22023';
  end if;

  v_payment_method := nullif(btrim(p_payment_method), '');
  if v_payment_method is null
     or v_payment_method not in ('CASH', 'BANK_TRANSFER', 'CARD', 'OTHER') then
    raise exception 'INVALID_EXPENSE_PAYMENT_METHOD' using errcode = '22023';
  end if;

  -- A small forward grace window (clock skew) is tolerated; an expense
  -- dated meaningfully in the future is never a valid "incurred" record.
  -- No lower bound — legitimate historical backfill entries are expected.
  if p_incurred_at is null or p_incurred_at > now() + interval '1 day' then
    raise exception 'INVALID_EXPENSE_DATE' using errcode = '22023';
  end if;
  v_incurred_at := p_incurred_at;

  v_payee := nullif(btrim(p_payee), '');
  if v_payee is not null and length(v_payee) > 200 then
    raise exception 'INVALID_EXPENSE_PAYEE' using errcode = '22023';
  end if;

  v_reference := nullif(btrim(p_reference), '');
  if v_reference is not null and length(v_reference) > 100 then
    raise exception 'INVALID_EXPENSE_REFERENCE' using errcode = '22023';
  end if;

  v_notes := nullif(btrim(p_notes), '');
  if v_notes is not null and length(v_notes) > 2000 then
    raise exception 'INVALID_EXPENSE_NOTES' using errcode = '22023';
  end if;

  -- CONSTRUCT CANONICAL CALLER INTENT — category_id, amount,
  -- payment_method, payee, reference, notes, incurred_at, branch_id ONLY.
  -- Never includes expense_number, category_name_snapshot,
  -- branch_name_snapshot, status, created_by, or any other computed/
  -- internal field — business_id is already the claim row's own
  -- primary-key component, so it is likewise omitted here (mirrors
  -- create_sale's/create_customer's own payload shape exactly). branch_id
  -- IS included (Phase 1G): a reused creation_key with a genuinely
  -- different branch attribution (including NULL vs a real branch) must
  -- be rejected as payload reuse, never silently resolved to whichever
  -- was requested first. incurred_at is stored as epoch seconds (text),
  -- not the timestamptz's own to_json() rendering: that rendering is
  -- session-TimeZone-dependent, so the SAME instant could otherwise
  -- serialize differently across two calls and make an exact replay
  -- falsely look like a conflicting request. Epoch-seconds text is
  -- timezone-invariant and exact.
  --
  -- amount is canonicalized through v_amount_narrowed (the validated
  -- numeric(14,2) candidate), NOT v_amount (the raw unconstrained input) —
  -- numeric(14,2)::text always produces exactly 2 decimal places
  -- (1, 1.0, and 1.00 all narrow to the identical numeric(14,2) value,
  -- which formats as the identical text "1.00"), so semantically
  -- equivalent amounts canonicalize identically regardless of how the
  -- caller happened to format the number. Using the unvalidated v_amount
  -- here instead would let differently-formatted-but-equal amounts
  -- falsely conflict under the same creation_key.
  v_canonical_payload := jsonb_build_object(
    'category_id', p_category_id,
    'amount', v_amount_narrowed::text,
    'payment_method', v_payment_method,
    'payee', v_payee,
    'reference', v_reference,
    'notes', v_notes,
    'incurred_at', extract(epoch from v_incurred_at)::text,
    'branch_id', p_branch_id
  );

  -- 4) CLAIM
  insert into private.expense_creation_requests (business_id, creation_key, canonical_payload)
  values (p_business_id, p_creation_key, v_canonical_payload)
  on conflict (business_id, creation_key) do nothing;

  if not found then
    -- 5) REPLAY DECISION — nothing about the category's/branch's current
    -- state has been consulted before this point.
    select canonical_payload, expense_id into v_stored_payload, v_stored_expense_id
    from private.expense_creation_requests
    where business_id = p_business_id and creation_key = p_creation_key;

    if v_stored_payload is distinct from v_canonical_payload then
      raise exception 'EXPENSE_IDEMPOTENCY_KEY_REUSED' using errcode = 'P0001';
    end if;

    return v_stored_expense_id;  -- exact replay, unconditionally
  end if;

  -- 6) ONLY A NEWLY CLAIMED REQUEST REACHES HERE — current category/
  -- branch-state validation begins. Scoped directly in the WHERE clause —
  -- a foreign-tenant category/branch is never loaded at all, not
  -- loaded-then-compared.
  select business_id, name, status
  into v_category_business_id, v_category_name, v_category_status
  from public.expense_categories
  where id = p_category_id and business_id = p_business_id;

  if v_category_business_id is null then
    raise exception 'EXPENSE_CATEGORY_NOT_FOUND' using errcode = '22023';  -- nonexistent/foreign: indistinguishable
  end if;
  if v_category_status <> 'ACTIVE' then
    raise exception 'EXPENSE_CATEGORY_ARCHIVED' using errcode = '23514';   -- real, same-tenant: informative
  end if;

  -- Branch attribution is entirely OPTIONAL — a NULL p_branch_id (the
  -- default, and the only value the current, unmodified Phase 1F
  -- application will ever send) means "business-wide" and skips this
  -- block entirely, exactly preserving today's behavior.
  if p_branch_id is not null then
    select business_id, name, status
    into v_branch_business_id, v_branch_name, v_branch_status
    from public.business_branches
    where id = p_branch_id and business_id = p_business_id;

    if v_branch_business_id is null then
      raise exception 'BRANCH_NOT_FOUND' using errcode = '22023';  -- nonexistent/foreign: indistinguishable
    end if;
    if v_branch_status <> 'ACTIVE' then
      raise exception 'BRANCH_NOT_ACTIVE' using errcode = '23514';   -- real, same-tenant: informative
    end if;
  end if;

  insert into private.business_expense_sequences (business_id, next_number)
  values (p_business_id, 2)
  on conflict (business_id) do update set next_number = private.business_expense_sequences.next_number + 1
  returning next_number - 1 into v_seq_number;
  -- lpad(string, length) TRUNCATES (keeping only the leftmost `length`
  -- characters) when the input is already longer than `length` — see
  -- create_sale's own comment for the confirmed-live example.
  -- greatest(6, length(...)) pads to AT LEAST 6 digits for the common case
  -- and never truncates once the counter exceeds 999999.
  v_expense_number := 'EXP-' || lpad(v_seq_number::text, greatest(6, length(v_seq_number::text)), '0');

  insert into public.expenses (
    business_id, expense_number, category_id, category_name_snapshot,
    branch_id, branch_name_snapshot,
    amount, payment_method, payee, reference, notes, incurred_at,
    creation_key, created_by
  ) values (
    p_business_id, v_expense_number, p_category_id, v_category_name,
    p_branch_id, v_branch_name,
    v_amount_narrowed, v_payment_method, v_payee, v_reference, v_notes, v_incurred_at,
    p_creation_key, v_uid
  )
  returning id into v_expense_id;

  update private.expense_creation_requests set expense_id = v_expense_id
  where business_id = p_business_id and creation_key = p_creation_key;

  return v_expense_id;
end;
$$;

-- Ownership transfer + explicit, narrow EXECUTE surface — required in
-- full here (unlike a genuine in-place CREATE OR REPLACE) because the DROP
-- above means this is a freshly-created function object. Mirrors
-- create_expense_creation_requests_and_rpc.sql's own original ownership/
-- grant block exactly, just for the new ten-parameter signature.
grant create on schema public to private_expense_writer;
alter function public.create_expense(uuid, uuid, uuid, numeric, text, timestamptz, text, text, text, uuid)
  owner to private_expense_writer;
revoke create on schema public from private_expense_writer;

revoke all on function public.create_expense(uuid, uuid, uuid, numeric, text, timestamptz, text, text, text, uuid)
  from public, anon, service_role;
grant execute on function public.create_expense(uuid, uuid, uuid, numeric, text, timestamptz, text, text, text, uuid)
  to authenticated;
