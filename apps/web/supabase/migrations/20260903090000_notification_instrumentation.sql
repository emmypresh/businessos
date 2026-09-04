-- Phase 1K APPLICATION LAYER: instrumenting 5 existing mutation RPCs to
-- raise in-app notifications, atomically, in the same transaction as the
-- business mutation they describe. Mirrors Phase 1J's own instrumentation
-- migration (20260902100000_instrument_core_audit_events.sql) exactly:
-- CREATE OR REPLACE with each function's EXACT existing signature (never
-- edits the frozen migration that first defined it), which preserves
-- ownership/ACL automatically; one new local variable and one call
-- inserted immediately before that function's own final `return`, on its
-- NEW-mutation path only.
--
-- INSTRUMENTED THIS ROUND (the 5 REQUIRED types): record_invoice_payment
-- (payment.recorded), create_sale_return (return.completed), create_expense
-- (expense.posted), create_business_invitation (staff.invited),
-- deactivate_business_branch (branch.deactivated).
--
-- DELIBERATELY DEFERRED THIS ROUND: sale.completed, invoice.created,
-- inventory.adjusted, product.created, customer.created — the task's own
-- brief names these as OPTIONAL ("if the existing RPC architecture
-- supports it cleanly"). The pattern below is proven and mechanically
-- identical for all five; deferring them is a scope decision made to keep
-- this round's surface reviewable and correct, not a technical blocker —
-- see the final report for the explicit list.
--
-- ══════════════════════════════════════════════════════════════════════
-- RECIPIENT TARGETING MATRIX — WHY BUSINESS-WIDE, PERMISSION-BASED, NOT
-- BRANCH-NARROWED, FOR THIS ROUND.
-- ══════════════════════════════════════════════════════════════════════
--
-- Every oversight permission this round targets (payments.view,
-- returns.view, expenses.view, staff.view/invite/manage, branches.view/
-- manage) is ALREADY documented and established, elsewhere in this exact
-- schema, as a BUSINESS-WIDE concern, never narrowed to the caller's own
-- branch assignment — see audit_events' own "READ MODEL" header comment
-- ("mirrors invoices.view's/sales.view's own established business-wide,
-- not branch-scoped precedent") and private.has_branch_access's own
-- header comment ("future branch-aware authorization is expected to
-- combine has_permission AND has_branch_access, never one in place of
-- the other... has_branch_access restricts MUTATION to the caller's own
-- branch — a completely different concern from READING"). Recipient
-- targeting for a notification IS a reading/visibility concern, not a
-- mutation-authority one, so this round's targeting policy for all 5
-- instrumented types is: every ACTIVE member of the business holding the
-- designated oversight permission, business-wide — never narrowed by
-- has_branch_access. This directly satisfies "OWNER should not
-- accidentally be excluded" (OWNER holds every relevant permission in
-- the seeded matrix) and "legitimate cross-branch oversight" (an
-- OWNER/ADMIN/MANAGER sees a branch-specific event exactly like a
-- business-wide one) without inventing a new branch-narrowed
-- notification-visibility concept this schema has never needed before.
-- `branch_id` is still recorded on every branch-specific notification
-- (informational, exactly as the DB foundation already established) for
-- future UI filtering — stricter branch-narrowed targeting (only notify
-- staff physically assigned to the affected branch) is a documented,
-- deferred future refinement, not attempted here.
--
-- Permission key chosen per type:
--   payment.recorded    -> payments.view
--   return.completed    -> returns.view
--   expense.posted      -> expenses.view
--   staff.invited       -> staff.view
--   branch.deactivated  -> branches.view
--
-- ══════════════════════════════════════════════════════════════════════
-- PREFERENCE FILTERING — AFTER authorization, never instead of it.
-- ══════════════════════════════════════════════════════════════════════
--
-- Recipient candidates are ALWAYS resolved from live, active membership +
-- permission first (private.resolve_active_members_with_permission).
-- ONLY THEN are candidates who explicitly disabled that notification_type
-- (`notification_preferences.in_app_enabled = false`) removed
-- (private.filter_notification_recipients_by_preference). A MISSING
-- preference row means enabled — the filter only ever REMOVES a
-- candidate, never adds one who wasn't already authorization-valid. If
-- filtering leaves ZERO recipients (everyone eligible opted out), the
-- instrumented function skips the private.create_notification call
-- entirely rather than calling it with an empty array — which
-- private.create_notification would reject with
-- INVALID_NOTIFICATION_RECIPIENTS, and since this call lives inside the
-- SAME transaction as the business mutation, an unhandled exception here
-- would roll back the mutation itself. A user's own notification
-- preference must never be able to break someone else's unrelated
-- business transaction — this is exactly why the recipient list is
-- checked for emptiness before ever calling the writer.

create or replace function private.resolve_active_members_with_permission(
  p_business_id     uuid,
  p_permission_key  text
)
returns uuid[]
language sql
stable
security definer
set search_path = ''
as $$
  select coalesce(array_agg(distinct bm.user_id), array[]::uuid[])
  from public.business_members bm
  join public.role_permissions rp on rp.role_id = bm.role_id
  join public.permissions p on p.id = rp.permission_id
  where bm.business_id = p_business_id
    and bm.status = 'active'
    and p.key = p_permission_key;
$$;

create or replace function private.filter_notification_recipients_by_preference(
  p_business_id          uuid,
  p_notification_type    text,
  p_candidate_user_ids   uuid[]
)
returns uuid[]
language sql
stable
security definer
set search_path = ''
as $$
  select coalesce(array_agg(uid), array[]::uuid[])
  from unnest(p_candidate_user_ids) as uid
  where not exists (
    select 1 from public.notification_preferences np
    where np.business_id = p_business_id
      and np.user_id = uid
      and np.notification_type = p_notification_type
      and np.in_app_enabled = false
  );
$$;

-- private_notification_recipient_resolver -------------------------------
--
-- NOLOGIN NOINHERIT: cannot establish a session, does not inherit any
-- other role's privileges. BYPASSRLS: required because both
-- business_members and notification_preferences carry RLS policies keyed
-- on `auth.uid()` (the CURRENTLY AUTHENTICATED caller) — these two
-- resolver functions run inside a mutation RPC's own transaction with no
-- PostgREST session context of their own, so `auth.uid()` would be NULL
-- and every RLS-gated row would be invisible without BYPASSRLS, exactly
-- like every other Phase 1C-1J private reader/writer role.
--
-- A SINGLE shared resolver role/function pair, not five separate direct
-- table grants to each of the five mutation-writer roles below — mirrors
-- private.current_verified_email's own established "one narrowly-owned
-- helper, many EXECUTE-granted callers" pattern exactly, which
-- concentrates the sensitive SELECT surface (business_members,
-- role_permissions, permissions, notification_preferences) in ONE
-- reviewed place instead of fanning it out across five.
do $$
begin
  if not exists (select 1 from pg_catalog.pg_roles where rolname = 'private_notification_recipient_resolver') then
    create role private_notification_recipient_resolver noinherit nologin bypassrls;
  end if;
end;
$$;

grant private_notification_recipient_resolver to postgres;

grant usage on schema public to private_notification_recipient_resolver;
grant usage on schema private to private_notification_recipient_resolver;

grant select (business_id, user_id, status, role_id) on public.business_members
  to private_notification_recipient_resolver;
grant select (role_id, permission_id) on public.role_permissions
  to private_notification_recipient_resolver;
grant select (id, key) on public.permissions
  to private_notification_recipient_resolver;
grant select (business_id, user_id, notification_type, in_app_enabled) on public.notification_preferences
  to private_notification_recipient_resolver;

grant create on schema private to private_notification_recipient_resolver;
alter function private.resolve_active_members_with_permission(uuid, text)
  owner to private_notification_recipient_resolver;
alter function private.filter_notification_recipients_by_preference(uuid, text, uuid[])
  owner to private_notification_recipient_resolver;
revoke create on schema private from private_notification_recipient_resolver;

revoke all on function private.resolve_active_members_with_permission(uuid, text)
  from public, anon, authenticated, service_role;
revoke all on function private.filter_notification_recipients_by_preference(uuid, text, uuid[])
  from public, anon, authenticated, service_role;

-- EXECUTE grants — resolver functions + private.create_notification —
-- to EXACTLY the 5 existing trusted writer roles instrumented below.
-- Never PUBLIC/anon/authenticated/service_role, and never a broad/
-- generic role. Each grant is justified by the ONE notification type
-- that writer's own function now raises:
--   private_invoice_payment_writer -> payment.recorded
--   private_sale_return_writer     -> return.completed
--   private_expense_writer         -> expense.posted
--   private_invitation_writer      -> staff.invited
--   private_branch_writer          -> branch.deactivated
grant execute on function private.resolve_active_members_with_permission(uuid, text) to
  private_invoice_payment_writer, private_sale_return_writer, private_expense_writer,
  private_invitation_writer, private_branch_writer;
grant execute on function private.filter_notification_recipients_by_preference(uuid, text, uuid[]) to
  private_invoice_payment_writer, private_sale_return_writer, private_expense_writer,
  private_invitation_writer, private_branch_writer;
grant execute on function private.create_notification(
  uuid, text, text, text, uuid[], uuid, text, text, text, uuid, jsonb, text
) to
  private_invoice_payment_writer, private_sale_return_writer, private_expense_writer,
  private_invitation_writer, private_branch_writer;

-- deactivate_business_branch's own instrumentation below captures the
-- transition's fresh `updated_at` via `UPDATE ... RETURNING updated_at`
-- for its dedup key (see that function's own header comment) — Postgres
-- requires SELECT privilege on any column named in a RETURNING clause,
-- in addition to UPDATE, even though private_branch_writer already had
-- UPDATE on this table before this round. Discovered live via a genuine
-- "permission denied for table business_branches" regression in the
-- existing test suite (this exact category of gotcha has now hit three
-- different writers in this codebase — private_sale_return_writer in
-- Phase 1I, private_audit_writer/private_notification_writer's own
-- RETURNING id grants in Phase 1J/1K — and is fixed proactively here
-- rather than left as a recurring footgun).
grant select (updated_at) on public.business_branches to private_branch_writer;

-- ══════════════════════════════════════════════════════════════════════
-- INSTRUMENTED MUTATIONS — CREATE OR REPLACE, EXACT existing signatures.
-- Preserves each function's existing owner/ACL automatically (no DROP,
-- no ownership/grant footer needed here) — see
-- 20260902100000_instrument_core_audit_events.sql's own closing comment
-- for the identical reasoning this round relies on again.
-- ══════════════════════════════════════════════════════════════════════

-- record_invoice_payment -> payment.recorded -----------------------------
--
-- DEDUP KEY: 'payment.recorded:<payment_id>' — payment_id is this
-- function's own freshly-inserted primary key, unique per real payment
-- row; an exact replay never reaches this instrumentation block at all
-- (it returns earlier, at the function's own pre-existing REPLAY
-- DECISION line), so the dedup key's own uniqueness is a second,
-- redundant layer of replay-safety, not the only one.
create or replace function public.record_invoice_payment(
  p_business_id    uuid,
  p_creation_key   uuid,
  p_invoice_id     uuid,
  p_amount         numeric,
  p_payment_method text,
  p_paid_at        text,
  p_reference      text default null,
  p_note           text default null
)
returns uuid
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

  -- Phase 1J instrumentation locals.
  v_invoice_number     text;
  v_actor_email        text;
  -- Phase 1K instrumentation locals.
  v_notify_candidates  uuid[];
  v_notify_recipients  uuid[];
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

  if not private.is_valid_offset_bearing_instant(p_paid_at) then
    raise exception 'INVALID_PAYMENT_DATE' using errcode = '22023';
  end if;
  v_paid_at := p_paid_at::timestamptz;
  if v_paid_at > now() + interval '1 day' then
    raise exception 'PAYMENT_DATE_IN_FUTURE' using errcode = '22023';
  end if;

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

  -- 6) ONLY A NEWLY CLAIMED REQUEST REACHES HERE.
  select id, branch_id, status, total_amount, amount_paid, invoice_number
  into v_invoice_found, v_branch_id, v_status, v_total_amount, v_amount_paid, v_invoice_number
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

  -- Phase 1J instrumentation: payment.recorded (audit).
  v_actor_email := private.current_verified_email();
  perform private.record_audit_event(
    p_business_id, 'USER', v_uid, 'payment.recorded', 'FINANCE',
    v_branch_id, v_actor_email, null,
    'invoice_payment', v_payment_id, v_invoice_number, 'SUCCESS',
    jsonb_build_object(
      'amount', v_amount::text,
      'method', v_payment_method
    )
  );

  -- Phase 1K instrumentation: payment.recorded (notification). Recorded
  -- only on this NEW-CLAIM path, identical placement to the audit call
  -- above. Recipients: every ACTIVE member holding payments.view,
  -- business-wide (see this migration's own header comment), minus
  -- anyone who explicitly disabled this type. Branch is the invoice's
  -- own authoritative branch (v_branch_id) — never caller-supplied.
  v_notify_candidates := private.resolve_active_members_with_permission(p_business_id, 'payments.view');
  v_notify_recipients := private.filter_notification_recipients_by_preference(
    p_business_id, 'payment.recorded', v_notify_candidates
  );
  if coalesce(array_length(v_notify_recipients, 1), 0) > 0 then
    perform private.create_notification(
      p_business_id, 'FINANCE', 'payment.recorded', 'Payment recorded',
      v_notify_recipients, v_branch_id,
      'A payment of ' || v_amount::text || ' was recorded via ' || v_payment_method ||
        ' for invoice ' || v_invoice_number || '.',
      'SUCCESS', 'invoice_payment', v_payment_id,
      jsonb_build_object('amount', v_amount::text, 'method', v_payment_method, 'invoice_number', v_invoice_number),
      'payment.recorded:' || v_payment_id::text
    );
  end if;

  return v_payment_id;
end;
$$;

-- create_sale_return -> return.completed ---------------------------------
--
-- DEDUP KEY: 'return.completed:<sale_return_id>' — the return's own
-- freshly-inserted primary key.
create or replace function public.create_sale_return(
  p_business_id  uuid,
  p_creation_key uuid,
  p_sale_id      uuid,
  p_items        jsonb,
  p_refund_amount numeric default 0,
  p_refund_method text default null,
  p_reason        text default null,
  p_notes         text default null
)
returns uuid
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_uid                 uuid;
  v_raw_item            jsonb;
  v_sale_item_id_text   text;
  v_sale_item_id        uuid;
  v_quantity_wide       numeric;
  v_quantity            numeric(14,3);
  v_restock             boolean;
  v_seen_sale_items     uuid[] := array[]::uuid[];
  v_norm_items          jsonb := '[]'::jsonb;
  v_max_items           constant int := 100;
  v_max_money           constant numeric := 999999999999.99;

  v_refund_amount       numeric;
  v_refund_method       text;
  v_reason              text;
  v_notes               text;

  v_canonical_payload   jsonb;
  v_stored_request      private.sale_return_creation_requests;
  v_sale_return_id      uuid;

  v_sale_found          uuid;
  v_sale_status         text;
  v_sale_branch_id      uuid;
  v_sale_branch_name    text;
  v_sale_amount_paid    numeric(14,2);
  v_branch_status       text;
  v_seq_number          bigint;
  v_return_number       text;
  v_restock_location_id uuid;
  v_needs_restock       boolean := false;

  v_snapshots           jsonb := '{}'::jsonb;
  v_sorted_item         record;
  v_item                jsonb;
  v_sale_item           record;
  v_already_returned    numeric;
  v_line_total_wide     numeric;
  v_return_value_basis  numeric := 0;
  v_cumulative_refund   numeric;

  v_position            int := 0;
  v_snapshot            jsonb;

  -- Phase 1J instrumentation locals.
  v_restocked_count     int := 0;
  v_actor_email         text;
  -- Phase 1K instrumentation locals.
  v_notify_candidates   uuid[];
  v_notify_recipients   uuid[];
begin
  -- 1) AUTHENTICATE
  v_uid := private.current_uid();
  if v_uid is null then
    raise exception 'authentication required' using errcode = '28000';
  end if;

  if p_business_id is null or p_creation_key is null or p_sale_id is null or p_items is null then
    raise exception 'p_business_id, p_creation_key, p_sale_id, and p_items are required'
      using errcode = '22023';
  end if;

  -- 2) AUTHORIZE
  if not private.has_permission(p_business_id, 'returns.manage') then
    raise exception 'insufficient_privilege' using errcode = '42501';
  end if;

  -- 3) NORMALIZE CALLER REQUEST
  if jsonb_typeof(p_items) is distinct from 'array' then
    raise exception 'MALFORMED_RETURN_ITEMS' using errcode = '22023';
  end if;
  if jsonb_array_length(p_items) = 0 then
    raise exception 'MALFORMED_RETURN_ITEMS' using errcode = '22023';
  end if;
  if jsonb_array_length(p_items) > v_max_items then
    raise exception 'TOO_MANY_RETURN_ITEMS' using errcode = '22023';
  end if;

  for v_raw_item in select * from jsonb_array_elements(p_items)
  loop
    if jsonb_typeof(v_raw_item) is distinct from 'object' then
      raise exception 'MALFORMED_RETURN_ITEMS' using errcode = '22023';
    end if;

    if jsonb_typeof(v_raw_item->'sale_item_id') is distinct from 'string' then
      raise exception 'MALFORMED_RETURN_ITEMS' using errcode = '22023';
    end if;
    v_sale_item_id_text := v_raw_item->>'sale_item_id';
    if v_sale_item_id_text !~ '^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$' then
      raise exception 'MALFORMED_RETURN_ITEMS' using errcode = '22023';
    end if;
    v_sale_item_id := v_sale_item_id_text::uuid;

    if v_sale_item_id = any(v_seen_sale_items) then
      raise exception 'DUPLICATE_SALE_ITEM_LINE' using errcode = '22023';
    end if;
    v_seen_sale_items := array_append(v_seen_sale_items, v_sale_item_id);

    if jsonb_typeof(v_raw_item->'quantity') is distinct from 'number' then
      raise exception 'MALFORMED_RETURN_ITEMS' using errcode = '22023';
    end if;
    v_quantity_wide := (v_raw_item->'quantity')::text::numeric;
    if v_quantity_wide <= 0 or v_quantity_wide > 1000000 then
      raise exception 'MALFORMED_RETURN_ITEMS' using errcode = '22023';
    end if;
    v_quantity := v_quantity_wide::numeric(14,3);
    if v_quantity <> v_quantity_wide then
      raise exception 'MALFORMED_RETURN_ITEMS' using errcode = '22023';
    end if;

    if jsonb_typeof(v_raw_item->'restock') is distinct from 'boolean' then
      raise exception 'MALFORMED_RETURN_ITEMS' using errcode = '22023';
    end if;
    v_restock := (v_raw_item->>'restock')::boolean;

    v_norm_items := v_norm_items || jsonb_build_array(jsonb_build_object(
      'sale_item_id', v_sale_item_id::text,
      'quantity', v_quantity::text,
      'restock', v_restock
    ));
  end loop;

  v_refund_amount := coalesce(p_refund_amount, 0);
  if v_refund_amount < 0 then
    raise exception 'INVALID_REFUND_AMOUNT' using errcode = '22023';
  end if;
  if v_refund_amount > v_max_money then
    raise exception 'INVALID_REFUND_AMOUNT' using errcode = '22023';
  end if;
  if round(v_refund_amount, 2) <> v_refund_amount then
    raise exception 'INVALID_REFUND_AMOUNT' using errcode = '22023';
  end if;

  v_refund_method := nullif(btrim(p_refund_method), '');
  if v_refund_amount = 0 then
    if v_refund_method is not null then
      raise exception 'INVALID_REFUND_METHOD' using errcode = '22023';
    end if;
  else
    if v_refund_method is null then
      raise exception 'INVALID_REFUND_METHOD' using errcode = '22023';
    end if;
    if v_refund_method not in ('CASH', 'BANK_TRANSFER', 'POS_CARD', 'OTHER') then
      raise exception 'INVALID_REFUND_METHOD' using errcode = '22023';
    end if;
  end if;

  v_reason := nullif(btrim(p_reason), '');
  if v_reason is not null and v_reason not in ('CUSTOMER_RETURN', 'DAMAGED', 'WRONG_ITEM', 'DEFECTIVE', 'OTHER') then
    raise exception 'INVALID_RETURN_REASON' using errcode = '22023';
  end if;

  v_notes := nullif(btrim(p_notes), '');
  if v_notes is not null and length(v_notes) > 2000 then
    raise exception 'INVALID_RETURN_NOTES' using errcode = '22023';
  end if;

  v_canonical_payload := jsonb_build_object(
    'sale_id', p_sale_id,
    'items', v_norm_items,
    'refund_amount', v_refund_amount::text,
    'refund_method', v_refund_method,
    'reason', v_reason,
    'notes', v_notes
  );

  -- 4) CLAIM
  insert into private.sale_return_creation_requests (business_id, creation_key, canonical_payload)
  values (p_business_id, p_creation_key, v_canonical_payload)
  on conflict (business_id, creation_key) do nothing;

  if not found then
    -- 5) REPLAY DECISION
    select * into v_stored_request
    from private.sale_return_creation_requests
    where business_id = p_business_id and creation_key = p_creation_key;

    if v_stored_request.canonical_payload is distinct from v_canonical_payload then
      raise exception 'RETURN_IDEMPOTENCY_KEY_REUSED' using errcode = 'P0001';
    end if;

    return v_stored_request.sale_return_id;
  end if;

  -- 6) ONLY A NEWLY CLAIMED REQUEST REACHES HERE.
  select id, status, branch_id, branch_name_snapshot, amount_paid
  into v_sale_found, v_sale_status, v_sale_branch_id, v_sale_branch_name, v_sale_amount_paid
  from public.sales
  where id = p_sale_id and business_id = p_business_id
  for update;

  if v_sale_found is null then
    raise exception 'RETURN_SALE_NOT_FOUND' using errcode = '22023';
  end if;

  select status into v_branch_status
  from public.business_branches
  where id = v_sale_branch_id and business_id = p_business_id
  for share;

  if v_branch_status is null or v_branch_status <> 'ACTIVE' then
    raise exception 'RETURN_SALE_NOT_FOUND' using errcode = '22023';
  end if;

  if not private.has_branch_access(p_business_id, v_sale_branch_id) then
    raise exception 'RETURN_SALE_NOT_FOUND' using errcode = '22023';
  end if;

  if v_sale_status <> 'COMPLETED' then
    raise exception 'RETURN_SALE_NOT_ELIGIBLE' using errcode = '23514';
  end if;

  -- 7) LOCK + VALIDATE EACH REFERENCED SALE ITEM.
  for v_sorted_item in
    select value as item, (value->>'sale_item_id')::uuid as sale_item_id
    from jsonb_array_elements(v_norm_items)
    order by (value->>'sale_item_id')::uuid
  loop
    select id, product_id, product_name_snapshot, sku_snapshot, unit_price, quantity, unit_cost_snapshot
    into v_sale_item
    from public.sale_items
    where id = v_sorted_item.sale_item_id and sale_id = p_sale_id and business_id = p_business_id
    for update;

    if not found then
      raise exception 'RETURN_ITEM_NOT_FOUND' using errcode = '22023';
    end if;

    select coalesce(sum(quantity), 0) into v_already_returned
    from public.sale_return_items
    where business_id = p_business_id and sale_item_id = v_sale_item.id;

    if v_already_returned + (v_sorted_item.item->>'quantity')::numeric(14,3) > v_sale_item.quantity then
      raise exception 'RETURN_QUANTITY_EXCEEDED' using errcode = '22023';
    end if;

    v_line_total_wide := round(v_sale_item.unit_price * (v_sorted_item.item->>'quantity')::numeric(14,3), 2);
    if v_line_total_wide > v_max_money then
      raise exception 'INVALID_REFUND_AMOUNT' using errcode = '22023';
    end if;
    v_return_value_basis := v_return_value_basis + v_line_total_wide;

    v_snapshots := jsonb_set(v_snapshots, array[v_sale_item.id::text], jsonb_build_object(
      'product_id', v_sale_item.product_id::text,
      'product_name_snapshot', v_sale_item.product_name_snapshot,
      'sku_snapshot', v_sale_item.sku_snapshot,
      'unit_price_snapshot', v_sale_item.unit_price::text,
      'line_total', v_line_total_wide::text,
      'unit_cost_snapshot', v_sale_item.unit_cost_snapshot::text
    ));

    if (v_sorted_item.item->>'restock')::boolean then
      v_needs_restock := true;
    end if;
  end loop;

  -- 8) REFUND INVARIANTS.
  if v_refund_amount > v_return_value_basis then
    raise exception 'RETURN_REFUND_EXCEEDED' using errcode = '22023';
  end if;

  select coalesce(sum(refund_amount), 0) into v_cumulative_refund
  from public.sale_returns
  where business_id = p_business_id and sale_id = p_sale_id;

  if v_cumulative_refund + v_refund_amount > v_sale_amount_paid then
    raise exception 'RETURN_REFUND_EXCEEDED' using errcode = '22023';
  end if;

  -- 9) ALLOCATE RETURN NUMBER.
  insert into private.business_return_sequences (business_id, next_number)
  values (p_business_id, 2)
  on conflict (business_id) do update set next_number = private.business_return_sequences.next_number + 1
  returning next_number - 1 into v_seq_number;
  v_return_number := 'RET-' || lpad(v_seq_number::text, greatest(6, length(v_seq_number::text)), '0');

  -- 10) INSERT THE RETURN HEADER.
  insert into public.sale_returns (
    business_id, return_number, sale_id, branch_id, branch_name_snapshot,
    refund_amount, refund_method, reason, notes, creation_key, created_by
  ) values (
    p_business_id, v_return_number, p_sale_id, v_sale_branch_id, v_sale_branch_name,
    v_refund_amount, v_refund_method, v_reason, v_notes, p_creation_key, v_uid
  )
  returning id into v_sale_return_id;

  -- 11) RESOLVE THE RESTOCK LOCATION ONCE.
  if v_needs_restock then
    select id into v_restock_location_id
    from public.inventory_locations
    where business_id = p_business_id and branch_id = v_sale_branch_id
      and is_branch_default = true and status = 'active';

    if v_restock_location_id is null then
      raise exception 'NO_DEFAULT_LOCATION' using errcode = '22023';
    end if;
  end if;

  -- 12) INSERT THE RETURN ITEMS.
  for v_item in select * from jsonb_array_elements(v_norm_items)
  loop
    v_snapshot := v_snapshots->(v_item->>'sale_item_id');

    insert into public.sale_return_items (
      business_id, sale_return_id, sale_item_id, product_id,
      product_name_snapshot, sku_snapshot, quantity, unit_price_snapshot, line_total,
      restock, position
    ) values (
      p_business_id, v_sale_return_id, (v_item->>'sale_item_id')::uuid, (v_snapshot->>'product_id')::uuid,
      v_snapshot->>'product_name_snapshot', v_snapshot->>'sku_snapshot',
      (v_item->>'quantity')::numeric(14,3), (v_snapshot->>'unit_price_snapshot')::numeric(14,2),
      (v_snapshot->>'line_total')::numeric(14,2),
      (v_item->>'restock')::boolean, v_position
    );
    v_position := v_position + 1;

    if (v_item->>'restock')::boolean then
      perform private.apply_inventory_movement(
        p_business_id, (v_snapshot->>'product_id')::uuid, v_restock_location_id, 'SALE_RETURN',
        (v_item->>'quantity')::numeric(14,3),
        nullif(v_snapshot->>'unit_cost_snapshot', '')::numeric(14,2),
        'sale_return', v_sale_return_id,
        'Return ' || v_return_number, null, gen_random_uuid(), v_uid
      );
      v_restocked_count := v_restocked_count + 1;
    end if;
  end loop;

  update private.sale_return_creation_requests set sale_return_id = v_sale_return_id
  where business_id = p_business_id and creation_key = p_creation_key;

  -- Phase 1J instrumentation: return.created (audit).
  v_actor_email := private.current_verified_email();
  perform private.record_audit_event(
    p_business_id, 'USER', v_uid, 'return.created', 'COMMERCE',
    v_sale_branch_id, v_actor_email, null,
    'sale_return', v_sale_return_id, v_return_number, 'SUCCESS',
    jsonb_build_object(
      'refund_amount', v_refund_amount::text,
      'reason', v_reason,
      'restocked_item_count', v_restocked_count
    )
  );

  -- Phase 1K instrumentation: return.completed (notification). Recorded
  -- only on this NEW-CLAIM path. Recipients: every ACTIVE member holding
  -- returns.view, business-wide, minus anyone who disabled this type.
  -- Branch is the sale's own authoritative branch (already locked and
  -- validated above).
  v_notify_candidates := private.resolve_active_members_with_permission(p_business_id, 'returns.view');
  v_notify_recipients := private.filter_notification_recipients_by_preference(
    p_business_id, 'return.completed', v_notify_candidates
  );
  if coalesce(array_length(v_notify_recipients, 1), 0) > 0 then
    perform private.create_notification(
      p_business_id, 'COMMERCE', 'return.completed', 'Return completed',
      v_notify_recipients, v_sale_branch_id,
      'Return ' || v_return_number ||
        case when v_refund_amount > 0 then ' was completed with a refund of ' || v_refund_amount::text || '.'
             else ' was completed.' end,
      'INFO', 'sale_return', v_sale_return_id,
      jsonb_build_object('refund_amount', v_refund_amount::text, 'return_number', v_return_number),
      'return.completed:' || v_sale_return_id::text
    );
  end if;

  return v_sale_return_id;
end;
$$;

-- create_expense -> expense.posted ---------------------------------------
--
-- DEDUP KEY: 'expense.posted:<expense_id>' — the expense's own freshly-
-- inserted primary key.
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
  v_seq_number                bigint;
  v_expense_number              text;
  -- Phase 1J instrumentation local.
  v_actor_email                 text;
  -- Phase 1K instrumentation locals.
  v_notify_candidates           uuid[];
  v_notify_recipients           uuid[];
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

-- create_business_invitation -> staff.invited -----------------------------
--
-- DEDUP KEY: 'staff.invited:<invitation_id>' — the invitation's own
-- freshly-inserted primary key.
create or replace function public.create_business_invitation(
  p_business_id        uuid,
  p_creation_key       uuid,
  p_email              text,
  p_role               text,
  p_branch_ids         jsonb default '[]'::jsonb,
  p_primary_branch_id  uuid default null
)
returns uuid
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_uid                uuid;
  v_caller_role        text;
  v_email              text;
  v_role_id            uuid;
  v_raw_id             jsonb;
  v_branch_id_text     text;
  v_branch_id          uuid;
  v_branch_ids         uuid[] := array[]::uuid[];
  v_max_branches       constant int := 50;
  v_canonical_payload  jsonb;
  v_stored_payload     jsonb;
  v_stored_invitation_id uuid;
  v_invitation_id      uuid;
  v_status             text;
  v_found_business_id  uuid;
  -- Phase 1J instrumentation local.
  v_actor_email        text;
  -- Phase 1K instrumentation locals.
  v_notify_candidates  uuid[];
  v_notify_recipients  uuid[];
begin
  v_uid := private.current_uid();
  if v_uid is null then
    raise exception 'authentication required' using errcode = '28000';
  end if;

  if p_business_id is null or p_creation_key is null or p_email is null or p_role is null then
    raise exception 'p_business_id, p_creation_key, p_email, and p_role are required'
      using errcode = '22023';
  end if;

  -- 2) AUTHORIZE
  if not private.has_permission(p_business_id, 'staff.invite') then
    raise exception 'insufficient_privilege' using errcode = '42501';
  end if;

  -- 3) NORMALIZE + VALIDATE INPUT SHAPE ONLY.
  v_email := lower(btrim(p_email));
  if v_email is null or v_email !~* '^[^@[:space:]]+@[^@[:space:]]+\.[^@[:space:]]+$' or length(v_email) > 254 then
    raise exception 'INVALID_INVITATION_EMAIL' using errcode = '22023';
  end if;

  select id into v_role_id from public.roles where name = p_role;
  if v_role_id is null then
    raise exception 'INVALID_ROLE' using errcode = '22023';
  end if;

  select r.name into v_caller_role
  from public.business_members bm
  join public.roles r on r.id = bm.role_id
  where bm.business_id = p_business_id and bm.user_id = v_uid and bm.status = 'active';

  if p_role = 'OWNER' and v_caller_role <> 'OWNER' then
    raise exception 'CANNOT_ASSIGN_OWNER_ROLE' using errcode = '42501';
  end if;

  if jsonb_typeof(p_branch_ids) is distinct from 'array' then
    raise exception 'INVALID_BRANCH_ASSIGNMENT' using errcode = '22023';
  end if;
  if jsonb_array_length(p_branch_ids) = 0 then
    raise exception 'INVALID_BRANCH_ASSIGNMENT' using errcode = '22023';
  end if;
  if jsonb_array_length(p_branch_ids) > v_max_branches then
    raise exception 'INVALID_BRANCH_ASSIGNMENT' using errcode = '22023';
  end if;
  if p_primary_branch_id is null then
    raise exception 'INVALID_BRANCH_ASSIGNMENT' using errcode = '22023';
  end if;

  for v_raw_id in select * from jsonb_array_elements(p_branch_ids)
  loop
    if jsonb_typeof(v_raw_id) is distinct from 'string' then
      raise exception 'INVALID_BRANCH_ASSIGNMENT' using errcode = '22023';
    end if;
    v_branch_id_text := v_raw_id #>> '{}';
    if v_branch_id_text !~ '^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$' then
      raise exception 'INVALID_BRANCH_ASSIGNMENT' using errcode = '22023';
    end if;
    v_branch_id := v_branch_id_text::uuid;
    if v_branch_id = any(v_branch_ids) then
      raise exception 'INVALID_BRANCH_ASSIGNMENT' using errcode = '22023';
    end if;
    v_branch_ids := array_append(v_branch_ids, v_branch_id);
  end loop;

  if p_primary_branch_id is not null and not (p_primary_branch_id = any(v_branch_ids)) then
    raise exception 'INVALID_BRANCH_ASSIGNMENT' using errcode = '22023';
  end if;

  select jsonb_agg(to_jsonb(x) order by x) into v_canonical_payload
  from unnest(v_branch_ids) as x;

  v_canonical_payload := jsonb_build_object(
    'email', v_email,
    'role_id', v_role_id::text,
    'branch_ids', coalesce(v_canonical_payload, '[]'::jsonb),
    'primary_branch_id', p_primary_branch_id::text
  );

  -- 4) CLAIM
  insert into private.business_invitation_requests (business_id, creation_key, canonical_payload)
  values (p_business_id, p_creation_key, v_canonical_payload)
  on conflict (business_id, creation_key) do nothing;

  if not found then
    -- 5) REPLAY DECISION
    select canonical_payload, invitation_id into v_stored_payload, v_stored_invitation_id
    from private.business_invitation_requests
    where business_id = p_business_id and creation_key = p_creation_key;

    if v_stored_payload is distinct from v_canonical_payload then
      raise exception 'INVITATION_IDEMPOTENCY_KEY_REUSED' using errcode = 'P0001';
    end if;

    return v_stored_invitation_id;
  end if;

  -- 6) ONLY A NEWLY CLAIMED REQUEST REACHES HERE.
  update public.business_invitations
  set status = 'EXPIRED'
  where business_id = p_business_id and email = v_email
    and status = 'PENDING' and expires_at <= now();

  for v_branch_id in select unnest(v_branch_ids)
  loop
    select business_id, status into v_found_business_id, v_status
    from public.business_branches
    where id = v_branch_id and business_id = p_business_id;

    if v_found_business_id is null then
      raise exception 'BRANCH_NOT_FOUND' using errcode = '22023';
    end if;
    if v_status <> 'ACTIVE' then
      raise exception 'BRANCH_NOT_ACTIVE' using errcode = '23514';
    end if;
  end loop;

  begin
    insert into public.business_invitations
      (business_id, email, role_id, expires_at, invited_by, creation_key)
    values
      (p_business_id, v_email, v_role_id, now() + interval '7 days', v_uid, p_creation_key)
    returning id into v_invitation_id;
  exception
    when unique_violation then
      raise exception 'INVITATION_ALREADY_PENDING' using errcode = '23505';
  end;

  for v_branch_id in select unnest(v_branch_ids)
  loop
    insert into public.business_invitation_branches (business_id, invitation_id, branch_id, is_primary)
    values (p_business_id, v_invitation_id, v_branch_id, v_branch_id = p_primary_branch_id);
  end loop;

  update private.business_invitation_requests set invitation_id = v_invitation_id
  where business_id = p_business_id and creation_key = p_creation_key;

  -- Phase 1J instrumentation: staff.invited (audit).
  v_actor_email := private.current_verified_email();
  perform private.record_audit_event(
    p_business_id, 'USER', v_uid, 'staff.invited', 'ORGANIZATION',
    p_primary_branch_id, v_actor_email, null,
    'staff_invitation', v_invitation_id, v_email, 'SUCCESS',
    jsonb_build_object(
      'role', p_role,
      'branch_count', array_length(v_branch_ids, 1)
    )
  );

  -- Phase 1K instrumentation: staff.invited (notification). Recorded only
  -- on this NEW-CLAIM path. Recipients: every ACTIVE member holding
  -- staff.view, business-wide (organization-level event), minus anyone
  -- who disabled this type.
  v_notify_candidates := private.resolve_active_members_with_permission(p_business_id, 'staff.view');
  v_notify_recipients := private.filter_notification_recipients_by_preference(
    p_business_id, 'staff.invited', v_notify_candidates
  );
  if coalesce(array_length(v_notify_recipients, 1), 0) > 0 then
    perform private.create_notification(
      p_business_id, 'ORGANIZATION', 'staff.invited', 'Staff invitation sent',
      v_notify_recipients, p_primary_branch_id,
      v_email || ' was invited as ' || p_role || '.',
      'INFO', 'staff_invitation', v_invitation_id,
      jsonb_build_object('role', p_role, 'email', v_email),
      'staff.invited:' || v_invitation_id::text
    );
  end if;

  return v_invitation_id;
end;
$$;

-- deactivate_business_branch -> branch.deactivated ------------------------
--
-- DEDUP KEY: 'branch.deactivated:<branch_id>:<updated_at>' — this function
-- has no idempotency-ledger of its own (per this migration's own header
-- comment mirrored from Phase 1J's identical note); its OWN pre-existing
-- "already inactive: no-op" branch is what prevents a duplicate event on
-- a REPLAY of the exact same transition (a retry never reaches this
-- instrumentation block again). The `updated_at` timestamp captured by
-- THIS statement's own `RETURNING` clause is what distinguishes ONE
-- deactivation EVENT INSTANCE from a LATER, genuinely separate one (the
-- branch reactivated, then deactivated again) — a bare
-- 'branch.deactivated:<branch_id>' key would incorrectly and permanently
-- suppress every future deactivation of the same branch forever, which
-- is exactly the "incorrectly merging unrelated events" failure mode
-- this phase's own instructions warn against.
create or replace function public.deactivate_business_branch(
  p_business_id uuid,
  p_branch_id   uuid
)
returns uuid
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_uid        uuid;
  v_found_id   uuid;
  v_status     text;
  v_is_default boolean;
  -- Phase 1J instrumentation locals.
  v_name       text;
  v_actor_email text;
  -- Phase 1K instrumentation locals.
  v_updated_at         timestamptz;
  v_notify_candidates  uuid[];
  v_notify_recipients  uuid[];
begin
  v_uid := private.current_uid();
  if v_uid is null then
    raise exception 'authentication required' using errcode = '28000';
  end if;

  if p_business_id is null or p_branch_id is null then
    raise exception 'p_business_id and p_branch_id are required' using errcode = '22023';
  end if;

  if not private.has_permission(p_business_id, 'branches.manage') then
    raise exception 'insufficient_privilege' using errcode = '42501';
  end if;

  select id, status, is_default, name into v_found_id, v_status, v_is_default, v_name
  from public.business_branches
  where id = p_branch_id and business_id = p_business_id
  for update;

  if v_found_id is null then
    raise exception 'BRANCH_NOT_FOUND' using errcode = '22023';
  end if;
  if v_is_default then
    raise exception 'DEFAULT_BRANCH_CANNOT_BE_DEACTIVATED' using errcode = '23514';
  end if;
  if v_status = 'INACTIVE' then
    return v_found_id;  -- already inactive: no-op — no audit event and no
                         -- notification either: nothing actually changed.
  end if;

  update public.business_branches set status = 'INACTIVE'
  where id = p_branch_id and business_id = p_business_id
  returning updated_at into v_updated_at;

  -- Phase 1J instrumentation: branch.deactivated (audit).
  v_actor_email := private.current_verified_email();
  perform private.record_audit_event(
    p_business_id, 'USER', v_uid, 'branch.deactivated', 'ORGANIZATION',
    v_found_id, v_actor_email, null,
    'branch', v_found_id, v_name, 'SUCCESS', '{}'::jsonb
  );

  -- Phase 1K instrumentation: branch.deactivated (notification).
  -- Recipients: every ACTIVE member holding branches.view, business-wide
  -- (organizational oversight, explicitly permitting cross-branch
  -- visibility), minus anyone who disabled this type.
  v_notify_candidates := private.resolve_active_members_with_permission(p_business_id, 'branches.view');
  v_notify_recipients := private.filter_notification_recipients_by_preference(
    p_business_id, 'branch.deactivated', v_notify_candidates
  );
  if coalesce(array_length(v_notify_recipients, 1), 0) > 0 then
    perform private.create_notification(
      p_business_id, 'ORGANIZATION', 'branch.deactivated', 'Branch deactivated',
      v_notify_recipients, v_found_id,
      v_name || ' has been deactivated.',
      'WARNING', 'branch', v_found_id,
      jsonb_build_object('branch_name', v_name),
      'branch.deactivated:' || v_found_id::text || ':' || v_updated_at::text
    );
  end if;

  return v_found_id;
end;
$$;
