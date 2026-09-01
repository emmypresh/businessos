-- Phase 1H: atomic, idempotent, concurrency-safe invoice payment
-- recording. This is the ONLY path that ever writes to
-- public.invoice_payments or changes public.invoices.amount_paid/status
-- away from their creation-time values (ISSUED/0) — no other function,
-- and no direct table grant, does either.
--
-- CONCURRENCY / OVERPAYMENT: the invoice row is locked with SELECT ...
-- FOR UPDATE before its balance is ever read. A second concurrent
-- payment attempt against the SAME invoice blocks on that lock until the
-- first attempt's transaction commits (or rolls back) — it then
-- re-reads the ALREADY-UPDATED amount_paid, so its own overpayment check
-- is always evaluated against the true, post-first-payment balance,
-- never a stale snapshot. This is what makes two simultaneous payments
-- structurally unable to both succeed if their combined total would
-- exceed the invoice's own total_amount — no application-level
-- coordination, no optimistic-concurrency retry loop, required.

create table private.invoice_payment_requests (
  business_id       uuid not null references public.businesses (id) on delete cascade,
  creation_key      uuid not null,
  payment_id        uuid references public.invoice_payments (id) on delete cascade,
  canonical_payload jsonb not null,
  created_at        timestamptz not null default now(),

  primary key (business_id, creation_key)
);

alter table private.invoice_payment_requests enable row level security;
alter table private.invoice_payment_requests force row level security;

revoke all on private.invoice_payment_requests from public, anon, authenticated, service_role;

-- ┌─────────────────────────────────────────────────────────────────────┐
-- │ SECURITY REVIEW REQUIRED FOR ANY FUTURE GRANT TO THIS ROLE.          │
-- │ Never extend private_invoice_payment_writer's table grants as a      │
-- │ quick fix for some other function's privilege problem; give that     │
-- │ function its own dedicated minimal role instead — deliberately       │
-- │ separate from private_invoice_writer (create_invoice_rpc.sql), which │
-- │ has no UPDATE privilege on public.invoices at all.                   │
-- └─────────────────────────────────────────────────────────────────────┘
do $$
begin
  if not exists (select 1 from pg_catalog.pg_roles where rolname = 'private_invoice_payment_writer') then
    create role private_invoice_payment_writer noinherit nologin bypassrls;
  end if;
end;
$$;

grant private_invoice_payment_writer to postgres;

grant usage on schema public to private_invoice_payment_writer;
grant usage on schema private to private_invoice_payment_writer;

-- SELECT narrowed to exactly what this function reads back from the
-- locked row; UPDATE narrowed to exactly the two columns it ever writes
-- — never a whole-table UPDATE grant, and never touching
-- customer_name_snapshot/branch_name_snapshot/notes/etc.
grant select (id, business_id, branch_id, status, total_amount, amount_paid) on public.invoices to private_invoice_payment_writer;
grant update (amount_paid, status) on public.invoices to private_invoice_payment_writer;

grant insert on public.invoice_payments to private_invoice_payment_writer;
grant select (id) on public.invoice_payments to private_invoice_payment_writer;

grant select, insert on private.invoice_payment_requests to private_invoice_payment_writer;
grant update (payment_id) on private.invoice_payment_requests to private_invoice_payment_writer;

grant execute on function private.current_uid() to private_invoice_payment_writer;
grant execute on function private.has_permission(uuid, text) to private_invoice_payment_writer;

-- private.is_valid_offset_bearing_instant --------------------------------
--
-- Codex security audit, SEC-02 ("Public payment RPC bypasses explicit-
-- instant validation"): record_invoice_payment's own p_paid_at parameter
-- USED to be typed `timestamptz` — PostgREST/PostgreSQL parses the
-- caller's raw input INTO that type before this function's own body ever
-- runs, so a direct authenticated RPC caller (curl/Postman, bypassing the
-- browser's own correct datetime-local -> real-instant conversion AND
-- bypassing lib/validation/invoices.ts's own PaymentPaidAtSchema/
-- isValidOffsetBearingInstant entirely) could submit a timezone-less or
-- semantically impossible string and have PostgreSQL's own liberal
-- timestamptz parser silently accept or normalize it — live-probed:
-- timezone-less input and a far-future instant were both accepted.
-- record_invoice_payment's own parameter is changed below from
-- `timestamptz` to `text` specifically so this function can inspect the
-- ORIGINAL lexical value before any implicit cast happens, and
-- independently re-validate it — the PUBLIC, directly-callable RPC is
-- its own trust boundary, never allowed to rely on the browser or the
-- Server Action having already checked anything.
--
-- Mirrors lib/date/iso-instant.ts's own exact strategy, in SQL: regex-
-- capture every component, range-check each explicitly, and validate
-- real calendar days-in-month (full Gregorian leap-year rule: divisible
-- by 4, except divisible by 100, unless ALSO divisible by 400) — never
-- delegating "is this real" to Postgres's own ::timestamptz cast, which
-- record_invoice_payment only ever invokes AFTER this function has
-- already proven the string unambiguous and real (see that function's
-- own comment on why the cast is then safe).
create or replace function private.is_valid_offset_bearing_instant(p_value text)
returns boolean
language plpgsql
immutable
set search_path = ''
as $$
declare
  v_match         text[];
  v_year          int;
  v_month         int;
  v_day           int;
  v_hour          int;
  v_minute        int;
  v_second        int;
  v_offset        text;
  v_offset_hour   int;
  v_offset_minute int;
  v_is_leap_year  boolean;
  v_days_in_month int;
begin
  if p_value is null then
    return false;
  end if;

  -- Structural match is NECESSARY but not sufficient — every numeric
  -- component captured here is independently range-checked below.
  -- Requires seconds AND a trailing Z or a numeric ±HH:MM offset;
  -- optional milliseconds (1-3 digits, non-capturing) are allowed.
  v_match := regexp_match(
    p_value,
    '^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.\d{1,3})?(Z|[+-]\d{2}:\d{2})$'
  );
  if v_match is null then
    return false;
  end if;

  v_year   := v_match[1]::int;
  v_month  := v_match[2]::int;
  v_day    := v_match[3]::int;
  v_hour   := v_match[4]::int;
  v_minute := v_match[5]::int;
  v_second := v_match[6]::int;
  v_offset := v_match[7];

  if v_month < 1 or v_month > 12 then
    return false;
  end if;

  -- Gregorian leap-year rule, applied exactly: divisible by 4, except
  -- divisible by 100, unless ALSO divisible by 400.
  v_is_leap_year := (v_year % 4 = 0 and v_year % 100 <> 0) or (v_year % 400 = 0);
  v_days_in_month := case v_month
    when 2 then (case when v_is_leap_year then 29 else 28 end)
    when 4 then 30
    when 6 then 30
    when 9 then 30
    when 11 then 30
    else 31
  end;
  if v_day < 1 or v_day > v_days_in_month then
    return false;
  end if;

  if v_hour < 0 or v_hour > 23 then
    return false;
  end if;
  if v_minute < 0 or v_minute > 59 then
    return false;
  end if;
  -- No leap-second support — 60 is rejected outright, matching the
  -- application-layer validator's own identical rule.
  if v_second < 0 or v_second > 59 then
    return false;
  end if;

  if v_offset <> 'Z' then
    -- The outer pattern already constrains this to `[+-]\d{2}:\d{2}`;
    -- re-extracted here purely to range-check hours/minutes
    -- independently — e.g. "+24:00"/"+12:60" match the SHAPE but are not
    -- real offsets.
    v_offset_hour := substring(v_offset from 2 for 2)::int;
    v_offset_minute := substring(v_offset from 5 for 2)::int;
    if v_offset_hour < 0 or v_offset_hour > 23 then
      return false;
    end if;
    if v_offset_minute < 0 or v_offset_minute > 59 then
      return false;
    end if;
  end if;

  return true;
end;
$$;

-- Newly created functions default to PUBLIC EXECUTE in Postgres — revoked
-- immediately, matching every other private.* helper's own established
-- convention (private.has_branch_access, private.has_permission, ...).
-- Never called directly by `authenticated` either — only from within
-- record_invoice_payment's own SECURITY DEFINER body, hence the single
-- narrow grant above to private_invoice_payment_writer alone.
revoke all on function private.is_valid_offset_bearing_instant(text) from public;
grant execute on function private.is_valid_offset_bearing_instant(text) to private_invoice_payment_writer;

create or replace function public.record_invoice_payment(
  p_business_id    uuid,
  p_creation_key   uuid,
  p_invoice_id     uuid,
  p_amount         numeric,
  p_payment_method text,
  -- Codex security audit, SEC-02: TEXT, not timestamptz — see
  -- private.is_valid_offset_bearing_instant's own header comment above
  -- for the full reasoning. The caller's ORIGINAL lexical value must
  -- reach this function's body unparsed, so it can be independently
  -- validated before any implicit Postgres cast has a chance to silently
  -- normalize an ambiguous or impossible instant.
  p_paid_at        text,
  p_reference      text default null,
  p_note           text default null
)
returns uuid  -- payment_id ONLY.
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_uid                uuid;
  v_amount             numeric;
  v_payment_method     text;
  v_paid_at            timestamptz;
  v_reference          text;
  v_note               text;
  v_canonical_payload  jsonb;
  v_stored_request     private.invoice_payment_requests;
  v_payment_id         uuid;

  v_invoice_found      uuid;
  v_branch_id          uuid;
  v_status             text;
  v_total_amount       numeric(14,2);
  v_amount_paid        numeric(14,2);
  v_balance            numeric;
  v_new_amount_paid    numeric(14,2);
  v_new_status         text;
  v_max_money          constant numeric := 999999999999.99;
begin
  -- 1) AUTHENTICATE
  v_uid := private.current_uid();
  if v_uid is null then
    raise exception 'authentication required' using errcode = '28000';
  end if;

  if p_business_id is null or p_creation_key is null or p_invoice_id is null
     or p_amount is null or p_payment_method is null or p_paid_at is null then
    raise exception 'p_business_id, p_creation_key, p_invoice_id, p_amount, p_payment_method, and p_paid_at are required'
      using errcode = '22023';
  end if;

  -- 2) AUTHORIZE — the caller's OWN permission, never inferred from the
  -- referenced invoice's own state, so this is always safe before the
  -- invoice is even looked up.
  if not private.has_permission(p_business_id, 'payments.record') then
    raise exception 'insufficient_privilege' using errcode = '42501';
  end if;

  -- 3) NORMALIZE CALLER REQUEST
  v_amount := p_amount;
  if v_amount <= 0 then
    raise exception 'INVALID_PAYMENT_AMOUNT' using errcode = '22023';
  end if;
  if v_amount > v_max_money then
    raise exception 'PAYMENT_AMOUNT_OUT_OF_RANGE' using errcode = '22023';
  end if;
  -- Codex adversarial review, remediation round 1, Medium 1: p_amount is
  -- caller-authoritative (there is no server-priced source for a payment
  -- amount) and arrives as `numeric`, so — unlike a JS float multiplied
  -- by 100 — round(numeric, 2) is an exact decimal round-trip proof, not
  -- a floating-point approximation: 1.999 must be REJECTED outright,
  -- never silently coerced to 2.00. Same technique as create_invoice's
  -- own custom-line unit_price check (create_invoice_rpc.sql).
  if round(v_amount, 2) <> v_amount then
    raise exception 'INVALID_PAYMENT_AMOUNT' using errcode = '22023';
  end if;

  v_payment_method := p_payment_method;
  if v_payment_method not in ('CASH', 'BANK_TRANSFER', 'POS_CARD', 'OTHER') then
    raise exception 'INVALID_PAYMENT_METHOD' using errcode = '22023';
  end if;

  v_reference := nullif(btrim(p_reference), '');
  if v_reference is not null and length(v_reference) > 200 then
    raise exception 'INVALID_PAYMENT_REFERENCE' using errcode = '22023';
  end if;
  v_note := nullif(btrim(p_note), '');
  if v_note is not null and length(v_note) > 500 then
    raise exception 'INVALID_PAYMENT_NOTE' using errcode = '22023';
  end if;

  -- Codex security audit, SEC-02: this is THE public trust boundary for
  -- p_paid_at — never assume the browser's own datetime-local->instant
  -- conversion or lib/validation/invoices.ts's own PaymentPaidAtSchema
  -- ran first; a direct authenticated RPC caller bypasses both entirely.
  -- Lexical + semantic validation happens BEFORE any cast, exactly
  -- mirroring the application-layer fix's own ordering — see
  -- private.is_valid_offset_bearing_instant's own header comment for the
  -- full technique.
  if not private.is_valid_offset_bearing_instant(p_paid_at) then
    raise exception 'INVALID_PAYMENT_DATE' using errcode = '22023';
  end if;
  -- Safe ONLY now: every calendar/clock/offset component has already
  -- been proven real and unambiguous, so this cast has nothing left to
  -- silently normalize — it can only ever produce the exact instant the
  -- caller's own string denoted.
  v_paid_at := p_paid_at::timestamptz;
  -- Same 1-day future grace window as PaymentPaidAtSchema
  -- (lib/validation/invoices.ts) — enforced independently here too, for
  -- the identical reason: a direct RPC caller must never be able to
  -- backdate the application layer's own future-date rule.
  if v_paid_at > now() + interval '1 day' then
    raise exception 'PAYMENT_DATE_IN_FUTURE' using errcode = '22023';
  end if;

  -- Canonicalized to the PARSED UTC instant (v_paid_at, a timestamptz —
  -- internally just a UTC point in time with no retained textual form),
  -- never the raw p_paid_at text — so two different-but-equivalent
  -- explicit representations of the exact same instant
  -- ("2026-08-31T15:30:00+01:00" and "2026-08-31T14:30:00Z") fingerprint
  -- IDENTICALLY. jsonb_build_object's own serialization of a timestamptz
  -- value is deterministic for a given, fixed session timezone (a
  -- server-side setting, never caller-controlled — so this is consistent
  -- across every call, whatever that setting is), so the same instant
  -- always produces the same canonical_payload regardless of which of
  -- its many equally-valid textual spellings the caller originally
  -- submitted. This preserves record_invoice_payment's own pre-existing
  -- idempotency behavior exactly — the canonical payload
  -- already embedded the (implicitly cast) timestamptz value before this
  -- fix, never the raw text, so replay/mismatch semantics are unchanged.
  v_canonical_payload := jsonb_build_object(
    'invoice_id', p_invoice_id,
    'amount', v_amount::text,
    'payment_method', v_payment_method,
    'paid_at', v_paid_at,
    'reference', v_reference,
    'note', v_note
  );

  -- 4) CLAIM
  insert into private.invoice_payment_requests (business_id, creation_key, canonical_payload)
  values (p_business_id, p_creation_key, v_canonical_payload)
  on conflict (business_id, creation_key) do nothing;

  if not found then
    -- 5) REPLAY DECISION — nothing about the invoice's current state has
    -- been consulted before this point.
    select * into v_stored_request
    from private.invoice_payment_requests
    where business_id = p_business_id and creation_key = p_creation_key;

    if v_stored_request.canonical_payload is distinct from v_canonical_payload then
      raise exception 'PAYMENT_IDEMPOTENCY_KEY_REUSED' using errcode = 'P0001';
    end if;

    return v_stored_request.payment_id;  -- exact replay, unconditionally
  end if;

  -- 6) ONLY A NEWLY CLAIMED REQUEST REACHES HERE. Lock the invoice row
  -- BEFORE reading its balance — see this file's own header comment on
  -- why this is what makes concurrent overpayment structurally
  -- impossible, not merely unlikely.
  select id, branch_id, status, total_amount, amount_paid
  into v_invoice_found, v_branch_id, v_status, v_total_amount, v_amount_paid
  from public.invoices
  where id = p_invoice_id and business_id = p_business_id
  for update;

  if v_invoice_found is null then
    raise exception 'INVOICE_NOT_FOUND' using errcode = '22023';
  end if;
  if v_status = 'VOID' then
    raise exception 'INVOICE_VOID' using errcode = '23514';
  end if;
  if v_status = 'PAID' then
    raise exception 'INVOICE_ALREADY_PAID' using errcode = '23514';
  end if;

  v_balance := v_total_amount - v_amount_paid;
  if v_amount > v_balance then
    raise exception 'PAYMENT_EXCEEDS_BALANCE' using errcode = '22023';
  end if;

  v_new_amount_paid := v_amount_paid + v_amount;
  v_new_status := case when v_new_amount_paid = v_total_amount then 'PAID' else 'PARTIALLY_PAID' end;

  -- branch_id is ALWAYS the invoice's own — never a caller-supplied
  -- value (there is no p_branch_id parameter at all; see this migration's
  -- own header comment for the full reasoning).
  insert into public.invoice_payments (
    business_id, invoice_id, branch_id, amount, payment_method,
    reference, note, paid_at, creation_key, recorded_by
  ) values (
    p_business_id, p_invoice_id, v_branch_id, v_amount, v_payment_method,
    v_reference, v_note, v_paid_at, p_creation_key, v_uid
  )
  returning id into v_payment_id;

  update public.invoices
  set amount_paid = v_new_amount_paid, status = v_new_status
  where id = p_invoice_id and business_id = p_business_id;

  update private.invoice_payment_requests set payment_id = v_payment_id
  where business_id = p_business_id and creation_key = p_creation_key;

  return v_payment_id;
end;
$$;

grant create on schema public to private_invoice_payment_writer;
alter function public.record_invoice_payment(uuid, uuid, uuid, numeric, text, text, text, text)
  owner to private_invoice_payment_writer;
revoke create on schema public from private_invoice_payment_writer;

revoke all on function public.record_invoice_payment(uuid, uuid, uuid, numeric, text, text, text, text)
  from public, anon, service_role;
grant execute on function public.record_invoice_payment(uuid, uuid, uuid, numeric, text, text, text, text)
  to authenticated;
