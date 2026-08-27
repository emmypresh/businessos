-- Phase 1E: atomic, idempotent, single-shot POSTED-expense creation.
--
-- public.create_expense is the ONLY Phase 1E expense-mutation entry point
-- that creates a row. It creates a POSTED expense in exactly one
-- transaction — validating the caller, the input shape, and the category —
-- or nothing commits at all. There is no DRAFT status and no code path
-- that ever leaves a committed row in any other status.
--
-- Idempotency follows private.sale_creation_requests' proven design
-- exactly: the arbiter is a dedicated request-ledger row's
-- INSERT ... ON CONFLICT DO NOTHING, and a replay of an already-committed
-- request returns the STORED result immediately, with NO revalidation of
-- the category's current state whatsoever — only a NEWLY claimed request
-- proceeds to that validation. This is deliberate: a category renamed or
-- archived AFTER the original expense committed must never cause an exact
-- replay of that expense to fail or diverge.

create table private.expense_creation_requests (
  business_id       uuid not null references public.businesses (id) on delete cascade,
  creation_key      uuid not null,
  -- Filled in once the winning claimant actually creates the expense, in
  -- the same transaction as the claim — never visible to another
  -- transaction in a half-populated state.
  expense_id        uuid references public.expenses (id) on delete cascade,
  canonical_payload jsonb not null,
  created_at        timestamptz not null default now(),

  primary key (business_id, creation_key)
);

-- Never exposed through the Data API: `private` is not in config.toml's
-- api.schemas, so this table is unreachable via PostgREST regardless of
-- GRANTs. RLS is enabled and forced anyway, with zero policies for any
-- client role — mirroring every other request-ledger table's own
-- treatment.
alter table private.expense_creation_requests enable row level security;
alter table private.expense_creation_requests force row level security;

revoke all on private.expense_creation_requests from public, anon, authenticated, service_role;

-- ┌─────────────────────────────────────────────────────────────────────┐
-- │ SECURITY REVIEW REQUIRED FOR ANY FUTURE GRANT TO THIS ROLE.          │
-- │ BYPASSRLS is a role-wide attribute, not scoped to the tables it's    │
-- │ granted on today. Never extend private_expense_writer's table grants │
-- │ as a quick fix for some other function's privilege problem; give     │
-- │ that function its own dedicated minimal role instead — exactly as    │
-- │ private_expense_voider (void_expense_rpc.sql) gets its own.          │
-- └─────────────────────────────────────────────────────────────────────┘
do $$
begin
  if not exists (select 1 from pg_catalog.pg_roles where rolname = 'private_expense_writer') then
    create role private_expense_writer noinherit nologin bypassrls;
  end if;
end;
$$;

grant private_expense_writer to postgres;

grant usage on schema public to private_expense_writer;
grant usage on schema private to private_expense_writer;

-- Least-privilege: SELECT narrowed to exactly the columns the function
-- body reads (id/business_id for the WHERE clause, name/status for the
-- active-category check and snapshot) — never a whole-table grant.
grant select (id, business_id, name, status) on public.expense_categories to private_expense_writer;

-- INSERT narrowed to EXACTLY the columns create_expense's own INSERT
-- statement supplies — never a whole-table grant. Every column omitted
-- here (id, currency_code, status, created_at, voided_at, voided_by,
-- void_reason) is either defaulted (gen_random_uuid(), 'NGN', 'POSTED',
-- now()) or left null by that default, and Postgres requires no INSERT
-- privilege at all for a column absent from the statement's own target
-- list — so this role structurally cannot set currency_code to anything
-- but 'NGN', cannot set status to anything but 'POSTED', and cannot touch
-- the void-state columns even if the function body were changed to try.
grant insert (
  business_id, expense_number, category_id, category_name_snapshot,
  amount, payment_method, payee, reference, notes, incurred_at,
  creation_key, created_by
) on public.expenses to private_expense_writer;
-- This role only ever INSERTs an expense and reads back its own freshly
-- generated id via RETURNING — SELECT is narrowed to exactly that one
-- column, matching private_customer_creator's/private_sale_writer's own
-- treatment of their respective tables.
grant select (id) on public.expenses to private_expense_writer;

-- The arbiter table: SELECT narrowed to exactly the four columns the
-- function body reads (business_id/creation_key for the WHERE clause,
-- expense_id/canonical_payload for the replay comparison and return
-- value) — created_at is never read, so it is excluded. INSERT stays a
-- plain (unnarrowed) grant: the INSERT statement only ever supplies
-- business_id/creation_key/canonical_payload, with expense_id and
-- created_at left to their column defaults, matching
-- customer_creation_requests'/sale_creation_requests' own INSERT grant
-- treatment. UPDATE stays narrowed to the one column ever written after
-- the initial claim.
grant select (business_id, creation_key, expense_id, canonical_payload)
  on private.expense_creation_requests to private_expense_writer;
grant insert on private.expense_creation_requests to private_expense_writer;
grant update (expense_id) on private.expense_creation_requests to private_expense_writer;

-- The counter table: INSERT for the first-ever claim on a business,
-- UPDATE narrowed to next_number for every subsequent claim. SELECT is
-- narrowed to exactly (business_id, next_number) — required by
-- ON CONFLICT (business_id) DO UPDATE itself and by the
-- DO UPDATE SET next_number = next_number + 1 expression, which reads the
-- pre-update value — not a general "browse this table" grant.
grant select (business_id, next_number) on private.business_expense_sequences to private_expense_writer;
grant insert on private.business_expense_sequences to private_expense_writer;
grant update (next_number) on private.business_expense_sequences to private_expense_writer;

-- Explicit cross-role EXECUTE dependencies (SECURITY DEFINER does not
-- transitively grant EXECUTE on functions a function calls).
grant execute on function private.current_uid() to private_expense_writer;
grant execute on function private.has_permission(uuid, text) to private_expense_writer;

create or replace function public.create_expense(
  p_business_id    uuid,
  p_creation_key   uuid,
  p_category_id    uuid,
  p_amount         numeric,
  p_payment_method text,
  p_incurred_at    timestamptz,
  p_payee          text default null,
  p_reference      text default null,
  p_notes          text default null
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

  -- New-claim-only locals — current category-state validation, never
  -- consulted on a replay.
  v_category_business_id uuid;
  v_category_name         text;
  v_category_status        text;
  v_seq_number               bigint;
  v_expense_number             text;
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
  -- category state", so this is always safe to re-check on every call,
  -- replay or not.
  if not private.has_permission(p_business_id, 'expenses.manage') then
    raise exception 'insufficient_privilege' using errcode = '42501';
  end if;

  -- 3) NORMALIZE + VALIDATE INPUT SHAPE ONLY. Every malformed-input error
  -- below is controlled and happens BEFORE any lookup against the
  -- category's current state, and BEFORE the idempotency claim — so the
  -- claim's canonical payload is always built from already-validated,
  -- normalized values (never re-derived at a different shape on replay).

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
  -- payment_method, payee, reference, notes, incurred_at ONLY. Never
  -- includes expense_number, category_name_snapshot, status, created_by,
  -- or any other computed/internal field — business_id is already the
  -- claim row's own primary-key component, so it is likewise omitted here
  -- (mirrors create_sale's/create_customer's own payload shape exactly).
  -- incurred_at is stored as epoch seconds (text), not the timestamptz's
  -- own to_json() rendering: that rendering is session-TimeZone-dependent,
  -- so the SAME instant could otherwise serialize differently across two
  -- calls and make an exact replay falsely look like a conflicting
  -- request. Epoch-seconds text is timezone-invariant and exact.
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
    'incurred_at', extract(epoch from v_incurred_at)::text
  );

  -- 4) CLAIM
  insert into private.expense_creation_requests (business_id, creation_key, canonical_payload)
  values (p_business_id, p_creation_key, v_canonical_payload)
  on conflict (business_id, creation_key) do nothing;

  if not found then
    -- 5) REPLAY DECISION — nothing about the category's current state has
    -- been consulted before this point.
    select canonical_payload, expense_id into v_stored_payload, v_stored_expense_id
    from private.expense_creation_requests
    where business_id = p_business_id and creation_key = p_creation_key;

    if v_stored_payload is distinct from v_canonical_payload then
      raise exception 'EXPENSE_IDEMPOTENCY_KEY_REUSED' using errcode = 'P0001';
    end if;

    return v_stored_expense_id;  -- exact replay, unconditionally
  end if;

  -- 6) ONLY A NEWLY CLAIMED REQUEST REACHES HERE — current category-state
  -- validation begins. Scoped directly in the WHERE clause — a
  -- foreign-tenant category is never loaded at all, not loaded-then-compared.
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
    amount, payment_method, payee, reference, notes, incurred_at,
    creation_key, created_by
  ) values (
    p_business_id, v_expense_number, p_category_id, v_category_name,
    v_amount_narrowed, v_payment_method, v_payee, v_reference, v_notes, v_incurred_at,
    p_creation_key, v_uid
  )
  returning id into v_expense_id;

  update private.expense_creation_requests set expense_id = v_expense_id
  where business_id = p_business_id and creation_key = p_creation_key;

  return v_expense_id;
end;
$$;

grant create on schema public to private_expense_writer;
alter function public.create_expense(uuid, uuid, uuid, numeric, text, timestamptz, text, text, text)
  owner to private_expense_writer;
revoke create on schema public from private_expense_writer;

-- Explicit, narrow surface: EXECUTE to `authenticated` only. No
-- `service_role` grant — matching create_sale's/create_customer's own
-- precedent (no concrete service_role actor calling this yet).
revoke all on function public.create_expense(uuid, uuid, uuid, numeric, text, timestamptz, text, text, text)
  from public, anon, service_role;
grant execute on function public.create_expense(uuid, uuid, uuid, numeric, text, timestamptz, text, text, text)
  to authenticated;
