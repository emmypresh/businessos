-- Phase 1Q-0C Codex follow-up (finding 1): the expense.posted notification
-- body rendered a raw amount with no currency identity at all — e.g.
-- "Payee — 100 via CASH" — regardless of which currency the owning
-- business actually uses. A recipient reading their notification feed
-- across businesses/branches had no way to tell 100 NGN from 100 GBP.
--
-- This is presentation-only: the notification's own currency AUTHORITY is
-- unchanged (still expenses.currency_code, itself always equal to the
-- owning business's currency_code per the BEFORE INSERT trigger added in
-- 20260923090400_expense_currency_from_business.sql). No amount, no
-- rounding, no numeric value, no RLS/GRANT/SECURITY DEFINER posture, and
-- no notification delivery/dedup/recipient-resolution behavior changes —
-- only the notification BODY TEXT gains a currency symbol.
--
-- private.format_money_symbol is a small SQL-side mirror of the
-- established TypeScript formatter (apps/web/lib/currency.ts's
-- formatMoney(..., { display: "symbol" })) — same deterministic symbol
-- table, same fixed US-style comma-thousands/period-decimal digit
-- grouping regardless of locale (matching that file's own documented
-- "never borrow the locale's own currency formatting" rule), same
-- fallback to the bare ISO code for a currency outside the table. The two
-- implementations are intentionally kept in lockstep by that shared
-- contract, not by a single source of truth, because Postgres and
-- TypeScript cannot share a module — any change to one's symbol table
-- must be mirrored in the other.
create or replace function private.format_money_symbol(p_amount numeric, p_currency_code text)
returns text
language sql
immutable
set search_path = pg_catalog
as $$
  select
    case p_currency_code
      when 'NGN' then '₦'
      when 'GBP' then '£'
      when 'USD' then '$'
      when 'EUR' then '€'
      when 'GHS' then 'GH₵'
      when 'KES' then 'KSh'
      when 'ZAR' then 'R'
      else coalesce(p_currency_code, '')
    end
    || to_char(p_amount, 'FM999,999,999,999.00');
$$;

revoke all on function private.format_money_symbol(numeric, text) from public;
grant execute on function private.format_money_symbol(numeric, text) to private_expense_writer;

-- Re-create create_expense with ONLY the notification body line changed
-- (line previously read: coalesce(v_payee, v_category_name) || ' — ' ||
-- v_amount_narrowed::text || ' via ' || v_payment_method || '.') — every
-- other statement, including the audit-event jsonb payload (which
-- intentionally keeps the raw numeric-as-text amount, not a display
-- string, for downstream machine consumption) is byte-for-byte unchanged
-- from 20260923090400_expense_currency_from_business.sql.
grant create on schema public to private_expense_writer;

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

  v_business_currency  text;

  v_actor_email                text;
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
  --
  -- Codex follow-up (finding 1): the body now carries the owning
  -- business's own currency symbol via private.format_money_symbol,
  -- instead of a bare, currency-less number.
  v_notify_candidates := private.resolve_active_members_with_permission(p_business_id, 'expenses.view');
  v_notify_recipients := private.filter_notification_recipients_by_preference(
    p_business_id, 'expense.posted', v_notify_candidates
  );
  if coalesce(array_length(v_notify_recipients, 1), 0) > 0 then
    perform private.create_notification(
      p_business_id, 'FINANCE', 'expense.posted', 'Expense posted',
      v_notify_recipients, p_branch_id,
      coalesce(v_payee, v_category_name) || ' — '
        || private.format_money_symbol(v_amount_narrowed, v_business_currency)
        || ' via ' || v_payment_method || '.',
      'INFO', 'expense', v_expense_id,
      jsonb_build_object('amount', v_amount_narrowed::text, 'category', v_category_name),
      'expense.posted:' || v_expense_id::text
    );
  end if;

  return v_expense_id;
end;
$$;

alter function public.create_expense(uuid, uuid, uuid, numeric, text, timestamptz, text, text, text, uuid)
  owner to private_expense_writer;
revoke create on schema public from private_expense_writer;
