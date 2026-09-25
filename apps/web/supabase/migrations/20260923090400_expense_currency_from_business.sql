-- Phase 1Q-0C: expenses.currency_code stops being a hardcoded 'NGN'
-- literal and instead durably tracks the OWNING BUSINESS's own base
-- currency (public.businesses.currency_code, Phase 1Q-0A). This is not
-- FX — a business still has exactly one base currency, and this
-- migration only removes the Phase 1E-era Nigeria-only assumption so a
-- non-Nigerian business's expenses can validly carry that business's own
-- currency instead of being structurally forced into NGN.
--
-- Existing rows are untouched: every business in this database today has
-- currency_code = 'NGN' (Phase 1Q-0A backfill), and every existing
-- expense already has currency_code = 'NGN', so dropping the old literal
-- CHECK and replacing it with a business-derived trigger invariant is a
-- no-op for current data — no numeric value or currency identity on any
-- existing row changes.

-- 1) Drop the old NGN-only literal CHECK and default. The column itself,
-- its NOT NULL constraint, and its shape stay exactly as they were —
-- only the "must literally equal 'NGN'" rule is removed, replaced below
-- by a stronger, business-derived rule (not merely "any 3-letter code").
alter table public.expenses
  drop constraint expenses_currency_code_check,
  alter column currency_code drop default;

-- 2) Durable invariant: expenses.currency_code must always equal the
-- owning business's own currency_code. Enforced as a BEFORE INSERT
-- trigger (independent of RLS/GRANTs, so it holds for every writer, not
-- just create_expense) — UPDATE is not covered here because
-- expenses_enforce_immutable_fields (20260827080200_create_expenses.sql)
-- already forbids currency_code from ever changing on any UPDATE, for
-- any writer, so a currency mismatch could only ever be introduced at
-- INSERT time.
--
-- SECURITY DEFINER (mirroring private.has_permission's own treatment) is
-- required here: this function must read public.businesses.currency_code
-- regardless of which role performs the INSERT, and private_expense_writer
-- (the only role that ever inserts into public.expenses) is not otherwise
-- granted SELECT on public.businesses at all.
create or replace function private.enforce_expense_currency_matches_business()
returns trigger
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
declare
  v_business_currency text;
begin
  select currency_code into v_business_currency
  from public.businesses
  where id = new.business_id;

  if v_business_currency is null then
    raise exception 'expenses.business_id does not reference a valid business' using errcode = '23503';
  end if;

  if new.currency_code is distinct from v_business_currency then
    raise exception 'expenses.currency_code must equal the owning business''s currency_code'
      using errcode = '23514';
  end if;

  return new;
end;
$$;

revoke all on function private.enforce_expense_currency_matches_business() from public;

create trigger expenses_enforce_currency_matches_business
  before insert on public.expenses
  for each row
  execute function private.enforce_expense_currency_matches_business();

-- 3) create_expense (the sole expense-creation entry point) now derives
-- currency_code server-side from the owning business, instead of relying
-- on a column default — the client has never been able to influence this
-- (there was and is no p_currency_code parameter), so this changes no
-- part of the function's public contract, only how the stored value is
-- produced.
grant select (id, currency_code) on public.businesses to private_expense_writer;
grant insert (currency_code) on public.expenses to private_expense_writer;

-- Re-creating the CURRENT ten-parameter signature (p_branch_id appended,
-- Phase 1G/20260829080300_branch_aware_expenses.sql) — CREATE OR REPLACE
-- only replaces a function whose argument-TYPE list is unchanged, and
-- the stale nine-parameter signature was already DROPPED by that
-- migration, so recreating it here would coexist as a second, ambiguous
-- overload rather than replacing anything.
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
  p_branch_id      uuid default null
)
returns uuid
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_uid                uuid;

  v_max_money          constant numeric := 999999999999.99;

  v_amount             numeric;
  v_amount_narrowed    numeric(14,2);
  v_payment_method     text;
  v_payee              text;
  v_reference          text;
  v_notes              text;
  v_incurred_at        timestamptz;

  v_canonical_payload  jsonb;
  v_stored_payload     jsonb;
  v_stored_expense_id  uuid;
  v_expense_id         uuid;

  v_category_business_id uuid;
  v_category_name         text;
  v_category_status        text;
  v_branch_business_id      uuid;
  v_branch_name              text;
  v_branch_status             text;
  v_seq_number                 bigint;
  v_expense_number               text;

  -- New: the owning business's OWN base currency — read once, on a
  -- newly-claimed request only (never re-derived on a replay, exactly
  -- like every other current-state lookup in this function), and used as
  -- the sole source of the inserted row's currency_code. The caller has
  -- no parameter to influence this value at all.
  v_business_currency  text;

  -- Phase 1J instrumentation local.
  v_actor_email                text;
  -- Phase 1K instrumentation locals.
  v_notify_candidates          uuid[];
  v_notify_recipients          uuid[];
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

  -- 2) AUTHORIZE
  if not private.has_permission(p_business_id, 'expenses.manage') then
    raise exception 'insufficient_privilege' using errcode = '42501';
  end if;

  -- 3) NORMALIZE + VALIDATE INPUT SHAPE ONLY.

  if p_amount is null or p_amount <= 0 then
    raise exception 'INVALID_EXPENSE_AMOUNT' using errcode = '22023';
  end if;
  if p_amount > v_max_money then
    raise exception 'EXPENSE_AMOUNT_OUT_OF_RANGE' using errcode = '22023';
  end if;
  v_amount := p_amount;

  v_amount_narrowed := v_amount::numeric(14,2);
  if v_amount_narrowed <> v_amount then
    raise exception 'INVALID_EXPENSE_AMOUNT' using errcode = '22023';
  end if;

  v_payment_method := nullif(btrim(p_payment_method), '');
  if v_payment_method is null
     or v_payment_method not in ('CASH', 'BANK_TRANSFER', 'CARD', 'OTHER') then
    raise exception 'INVALID_EXPENSE_PAYMENT_METHOD' using errcode = '22023';
  end if;

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
    -- 5) REPLAY DECISION
    select canonical_payload, expense_id into v_stored_payload, v_stored_expense_id
    from private.expense_creation_requests
    where business_id = p_business_id and creation_key = p_creation_key;

    if v_stored_payload is distinct from v_canonical_payload then
      raise exception 'EXPENSE_IDEMPOTENCY_KEY_REUSED' using errcode = 'P0001';
    end if;

    return v_stored_expense_id;
  end if;

  -- 6) ONLY A NEWLY CLAIMED REQUEST REACHES HERE.
  select business_id, name, status
  into v_category_business_id, v_category_name, v_category_status
  from public.expense_categories
  where id = p_category_id and business_id = p_business_id;

  if v_category_business_id is null then
    raise exception 'EXPENSE_CATEGORY_NOT_FOUND' using errcode = '22023';
  end if;
  if v_category_status <> 'ACTIVE' then
    raise exception 'EXPENSE_CATEGORY_ARCHIVED' using errcode = '23514';
  end if;

  if p_branch_id is not null then
    select business_id, name, status
    into v_branch_business_id, v_branch_name, v_branch_status
    from public.business_branches
    where id = p_branch_id and business_id = p_business_id;

    if v_branch_business_id is null then
      raise exception 'BRANCH_NOT_FOUND' using errcode = '22023';
    end if;
    if v_branch_status <> 'ACTIVE' then
      raise exception 'BRANCH_NOT_ACTIVE' using errcode = '23514';
    end if;
  end if;

  insert into private.business_expense_sequences (business_id, next_number)
  values (p_business_id, 2)
  on conflict (business_id) do update set next_number = private.business_expense_sequences.next_number + 1
  returning next_number - 1 into v_seq_number;
  v_expense_number := 'EXP-' || lpad(v_seq_number::text, greatest(6, length(v_seq_number::text)), '0');

  -- The business's own base currency — Phase 1Q-0C. p_business_id has
  -- already been proven valid by the has_permission check above (a
  -- nonexistent business can never hold a permission grant), so a null
  -- result here would indicate a genuine data-integrity fault, not a
  -- reachable caller-input error.
  select currency_code into v_business_currency
  from public.businesses
  where id = p_business_id;

  insert into public.expenses (
    business_id, expense_number, category_id, category_name_snapshot,
    branch_id, branch_name_snapshot,
    amount, currency_code, payment_method, payee, reference, notes, incurred_at,
    creation_key, created_by
  ) values (
    p_business_id, v_expense_number, p_category_id, v_category_name,
    p_branch_id, v_branch_name,
    v_amount_narrowed, v_business_currency, v_payment_method, v_payee, v_reference, v_notes, v_incurred_at,
    p_creation_key, v_uid
  )
  returning id into v_expense_id;

  update private.expense_creation_requests set expense_id = v_expense_id
  where business_id = p_business_id and creation_key = p_creation_key;

  -- Phase 1J instrumentation: expense.posted (audit).
  v_actor_email := private.current_verified_email();
  perform private.record_audit_event(
    p_business_id, 'USER', v_uid, 'expense.posted', 'FINANCE',
    p_branch_id, v_actor_email, null,
    'expense', v_expense_id, coalesce(v_payee, v_category_name), 'SUCCESS',
    jsonb_build_object(
      'amount', v_amount_narrowed::text,
      'category', v_category_name
    )
  );

  -- Phase 1K instrumentation: expense.posted (notification). Recorded
  -- only on this NEW-CLAIM path. Recipients: every ACTIVE member holding
  -- expenses.view, business-wide, minus anyone who disabled this type.
  -- Branch is p_branch_id itself (nullable — business-wide expense has
  -- none), matching this function's own optional-branch design.
  v_notify_candidates := private.resolve_active_members_with_permission(p_business_id, 'expenses.view');
  v_notify_recipients := private.filter_notification_recipients_by_preference(
    p_business_id, 'expense.posted', v_notify_candidates
  );
  if coalesce(array_length(v_notify_recipients, 1), 0) > 0 then
    perform private.create_notification(
      p_business_id, 'FINANCE', 'expense.posted', 'Expense posted',
      v_notify_recipients, p_branch_id,
      coalesce(v_payee, v_category_name) || ' — ' || v_amount_narrowed::text || ' via ' || v_payment_method || '.',
      'INFO', 'expense', v_expense_id,
      jsonb_build_object('amount', v_amount_narrowed::text, 'category', v_category_name),
      'expense.posted:' || v_expense_id::text
    );
  end if;

  return v_expense_id;
end;
$$;

grant create on schema public to private_expense_writer;
alter function public.create_expense(uuid, uuid, uuid, numeric, text, timestamptz, text, text, text, uuid)
  owner to private_expense_writer;
revoke create on schema public from private_expense_writer;
