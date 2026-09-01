-- Phase 1H remediation round 1 (Codex adversarial review) — Medium 2,
-- Medium 3, Medium 4, Low 6. ADDITIVE ONLY. Does not alter any of the
-- seven original Phase 1H migrations (20260831080000 through
-- 20260831080600), any Phase 1A-1G migration (including the frozen
-- 20260830080000_branch_option_rpc.sql, whose own five-scope whitelist
-- cannot be extended), business_branches'/customers'/products'/invoices'/
-- invoice_payments' own existing SELECT policies, or any existing
-- grant/role.
--
-- PROBLEM (three related permission-contract gaps, one shared root cause):
-- application-layer picker/list surfaces resolved their data through
-- PostgREST embeds/plain table reads, each independently re-enforcing
-- THAT table's own RLS policy — gated on a DIFFERENT permission than the
-- one the calling workflow is actually authorized on:
--   * invoice creation is gated on invoices.manage, but its customer
--     picker required customers.view and its product picker required
--     products.view (neither implied by invoices.manage);
--   * the invoice list's branch filter (invoices.view) fell back to
--     lib/branches/dal.ts's plain, branches.view-gated listBranches;
--   * payment recording (payments.record) had no invoice picker at all
--     reachable without invoices.view, and payment history (payments.view
--     alone) could not resolve invoice_number/customer_name_snapshot/
--     branch_name_snapshot, since public.invoices' own SELECT policy is
--     gated on invoices.view, not payments.view.
-- This is the exact "permission-split" defect class Phase 1F/1G's own
-- get_invitation_branch_options/get_business_branch_options RPCs already
-- exist to eliminate for branch pickers — this migration applies the same
-- fix to the three NEW Phase-1H-specific surfaces those two frozen RPCs
-- cannot cover (get_business_branch_options' scope whitelist is fixed;
-- neither RPC touches customers, products, or invoices at all).
--
-- FIX: six new SECURITY DEFINER RPCs, each authorized on EXACTLY the one
-- permission that already gates the real workflow it backs — never a
-- newly-invented broader grant, never an unrelated permission smuggled in.
-- Each returns only the minimal columns that workflow's own UI displays or
-- searches by (see each function's own header below for the exact list).
--
-- ┌─────────────────────────────────────────────────────────────────────┐
-- │ SECURITY REVIEW REQUIRED FOR ANY FUTURE GRANT TO THIS ROLE.          │
-- │ private_invoice_picker_reader is a DELIBERATE, DOCUMENTED exception   │
-- │ to this codebase's usual "one narrow role per RPC" convention (every  │
-- │ mutation RPC above it — private_invoice_writer/                      │
-- │ private_invoice_payment_writer/private_invoice_voider — correctly    │
-- │ keeps its own separate role). All six functions below are read-only,  │
-- │ side-effect-free, and share one purpose (resolving Phase 1H picker/   │
-- │ list metadata across a permission boundary PostgREST's own per-table  │
-- │ RLS cannot cross) — sharing one BYPASSRLS role among them is no wider  │
-- │ a blast radius than six separate BYPASSRLS roles each granted the      │
-- │ identical column set would be, and is easier to audit as a single     │
-- │ surface. Never extend this role's grants to solve some other          │
-- │ function's privilege problem — including a future, unrelated Phase   │
-- │ 1H+ read-only RPC; give that one its own dedicated role instead.      │
-- └─────────────────────────────────────────────────────────────────────┘
do $$
begin
  if not exists (select 1 from pg_catalog.pg_roles where rolname = 'private_invoice_picker_reader') then
    create role private_invoice_picker_reader noinherit nologin bypassrls;
  end if;
end;
$$;

grant private_invoice_picker_reader to postgres;

grant usage on schema public to private_invoice_picker_reader;
grant usage on schema private to private_invoice_picker_reader;

-- Least-privilege column grants — exactly what the six function bodies
-- below read or filter on, never a whole-table grant, and never any
-- cost/address/phone-adjacent column beyond the few genuinely displayed
-- or searched.
grant select (id, business_id, name, code, status, is_default)
  on public.business_branches to private_invoice_picker_reader;
grant select (id, business_id, member_id, branch_id, is_primary)
  on public.business_member_branches to private_invoice_picker_reader;
grant select (id, business_id, user_id, status)
  on public.business_members to private_invoice_picker_reader;
grant select (id, business_id, name, phone, email, status)
  on public.customers to private_invoice_picker_reader;
grant select (id, business_id, name, sku, selling_price, status)
  on public.products to private_invoice_picker_reader;
grant select (
  id, business_id, invoice_number, customer_name_snapshot, branch_name_snapshot,
  -- branch_id (Codex security audit, SEC-01): the AUTHORITATIVE branch a
  -- target invoice belongs to, read-only, used solely by
  -- get_invoice_void_eligibility to check the caller's own operational
  -- access to it — never returned to any caller.
  status, total_amount, amount_paid, created_at, branch_id
) on public.invoices to private_invoice_picker_reader;
grant select (id, business_id, invoice_id, amount, payment_method, reference, paid_at)
  on public.invoice_payments to private_invoice_picker_reader;

grant execute on function private.current_uid() to private_invoice_picker_reader;
grant execute on function private.has_permission(uuid, text) to private_invoice_picker_reader;
-- Codex security audit, SEC-01: get_invoice_void_eligibility must apply
-- the IDENTICAL branch-authorization rule void_invoice itself does — the
-- eligibility helper and the actual mutation must never disagree.
grant execute on function private.has_branch_access(uuid, uuid) to private_invoice_picker_reader;

-- get_invoice_branch_options ----------------------------------------------
--
-- Backs invoice creation's branch picker. Authorization: invoices.manage
-- ALONE — never branches.view, never sales.create/products.manage/
-- inventory.adjust (this deliberately does NOT reuse
-- get_business_branch_options' 'operations' scope, since extending that
-- scope's fixed whitelist would require editing the frozen
-- 20260830080000_branch_option_rpc.sql). Same semantics as that
-- 'operations' scope otherwise: the caller's OWN assigned, ACTIVE branches
-- only — invoice creation is an operational activity tied to where the
-- caller can act, matching create_invoice's own has_branch_access check.
create or replace function public.get_invoice_branch_options(p_business_id uuid)
returns table (id uuid, name text, code text, is_default boolean, is_primary boolean)
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_member_id uuid;
begin
  if private.current_uid() is null then
    raise exception 'authentication required' using errcode = '28000';
  end if;
  if p_business_id is null then
    raise exception 'p_business_id is required' using errcode = '22023';
  end if;

  if not private.has_permission(p_business_id, 'invoices.manage') then
    raise exception 'insufficient_privilege' using errcode = '42501';
  end if;

  select bm.id into v_member_id
  from public.business_members bm
  where bm.business_id = p_business_id
    and bm.user_id = private.current_uid()
    and bm.status = 'active';

  return query
  select bb.id, bb.name, bb.code, bb.is_default, bmb.is_primary
  from public.business_member_branches bmb
  join public.business_branches bb
    on bb.id = bmb.branch_id and bb.business_id = bmb.business_id
  where bmb.business_id = p_business_id
    and bmb.member_id = v_member_id
    and bb.status = 'ACTIVE'
  order by bmb.is_primary desc, bb.name asc;
end;
$$;

grant create on schema public to private_invoice_picker_reader;
alter function public.get_invoice_branch_options(uuid) owner to private_invoice_picker_reader;
revoke create on schema public from private_invoice_picker_reader;
revoke all on function public.get_invoice_branch_options(uuid) from public, anon, service_role;
grant execute on function public.get_invoice_branch_options(uuid) to authenticated;

-- get_invoice_customer_options ---------------------------------------------
--
-- Backs invoice creation's customer picker. Authorization: invoices.manage
-- ALONE — never customers.view. Returns active customers only, bounded to
-- 25 rows (matching lib/pagination.ts's own DEFAULT_PAGE_SIZE, the same
-- bound every other typeahead picker in this app already uses).
--
-- Codex adversarial review, remediation round 2, Medium 1: this used to
-- RETURN phone/email alongside id/name — the invoice-creation UI only
-- ever displays/uses id/name (components/invoices/customer-picker.tsx),
-- so returning contact data here handed an invoices.manage-only caller
-- (who does NOT hold customers.view) read authority over customer
-- phone/email merely because they could call this RPC directly — the
-- RPC's own RETURNS TABLE shape is the actual security boundary, not the
-- application code that happens to discard those fields afterward
-- (searchCustomersForInvoiceAction already only mapped out id/name, but
-- a caller invoking this RPC directly via supabase.rpc(...) was never
-- bound by that). Fixed by narrowing the return shape to id/name only —
-- phone/email are still searched INTERNALLY (a customer found by phone
-- number is a real, useful lookup), just never returned. The SELECT
-- grant below necessarily still includes phone/email (a WHERE-clause
-- reference needs the same column privilege a SELECT-list reference
-- does), but that is exactly this role's own existing least-privilege
-- boundary — never anon/PUBLIC/service_role, never customers.view
-- granted to invoices.manage-only callers, and the OUTPUT contract this
-- function actually exposes is now strictly id/name, asserted by an
-- exact-key-set test (tests/integration/invoice-payment-rpc.test.ts).
create or replace function public.get_invoice_customer_options(
  p_business_id uuid,
  p_search      text default null
)
returns table (id uuid, name text)
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_pattern text;
begin
  if private.current_uid() is null then
    raise exception 'authentication required' using errcode = '28000';
  end if;
  if p_business_id is null then
    raise exception 'p_business_id is required' using errcode = '22023';
  end if;

  if not private.has_permission(p_business_id, 'invoices.manage') then
    raise exception 'insufficient_privilege' using errcode = '42501';
  end if;

  if p_search is not null and btrim(p_search) <> '' then
    v_pattern := '%' || replace(replace(replace(btrim(p_search), '\', '\\'), '%', '\%'), '_', '\_') || '%';
  end if;

  return query
  select c.id, c.name
  from public.customers c
  where c.business_id = p_business_id
    and c.status = 'active'
    and (
      v_pattern is null
      or c.name ilike v_pattern escape '\'
      or c.phone ilike v_pattern escape '\'
      or c.email ilike v_pattern escape '\'
    )
  order by c.name asc
  limit 25;
end;
$$;

grant create on schema public to private_invoice_picker_reader;
alter function public.get_invoice_customer_options(uuid, text) owner to private_invoice_picker_reader;
revoke create on schema public from private_invoice_picker_reader;
revoke all on function public.get_invoice_customer_options(uuid, text) from public, anon, service_role;
grant execute on function public.get_invoice_customer_options(uuid, text) to authenticated;

-- get_invoice_product_options ----------------------------------------------
--
-- Backs invoice creation's product picker. Authorization: invoices.manage
-- ALONE — never products.view. Returns active products only, bounded to
-- 25 rows, searched by name/sku. Deliberately excludes every cost column
-- (products.cost_price and any inventory-cost-adjacent column) — an
-- invoice-creating caller has no legitimate need to see cost, matching
-- inventory.view_cost's own separate-permission treatment elsewhere in
-- this schema; selling_price is the only price this returns, exactly what
-- create_invoice itself prices product lines from.
create or replace function public.get_invoice_product_options(
  p_business_id uuid,
  p_search      text default null
)
returns table (id uuid, name text, sku text, selling_price numeric)
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_pattern text;
begin
  if private.current_uid() is null then
    raise exception 'authentication required' using errcode = '28000';
  end if;
  if p_business_id is null then
    raise exception 'p_business_id is required' using errcode = '22023';
  end if;

  if not private.has_permission(p_business_id, 'invoices.manage') then
    raise exception 'insufficient_privilege' using errcode = '42501';
  end if;

  if p_search is not null and btrim(p_search) <> '' then
    v_pattern := '%' || replace(replace(replace(btrim(p_search), '\', '\\'), '%', '\%'), '_', '\_') || '%';
  end if;

  return query
  select p.id, p.name, p.sku, p.selling_price
  from public.products p
  where p.business_id = p_business_id
    and p.status = 'active'
    and (
      v_pattern is null
      or p.name ilike v_pattern escape '\'
      or p.sku ilike v_pattern escape '\'
    )
  order by p.name asc
  limit 25;
end;
$$;

grant create on schema public to private_invoice_picker_reader;
alter function public.get_invoice_product_options(uuid, text) owner to private_invoice_picker_reader;
revoke create on schema public from private_invoice_picker_reader;
revoke all on function public.get_invoice_product_options(uuid, text) from public, anon, service_role;
grant execute on function public.get_invoice_product_options(uuid, text) to authenticated;

-- get_invoice_filter_branch_options ----------------------------------------
--
-- Backs the invoice list's branch filter. Authorization: invoices.view
-- ALONE — never branches.view (see lib/branches/dal.ts's own
-- listInvoiceFilterBranchOptions header comment for the exact,
-- now-fixed, gap this replaces). invoices.view is business-wide (never
-- gated on operational branch assignment, matching sales.view/
-- inventory.view's own precedent), and a historical invoice can reference
-- a since-deactivated branch, so this includes INACTIVE branches too —
-- matching get_business_branch_options' own 'reports'/'sales_filter'
-- scopes' identical treatment.
create or replace function public.get_invoice_filter_branch_options(p_business_id uuid)
returns table (id uuid, name text, code text, status text)
language plpgsql
stable
security definer
set search_path = ''
as $$
begin
  if private.current_uid() is null then
    raise exception 'authentication required' using errcode = '28000';
  end if;
  if p_business_id is null then
    raise exception 'p_business_id is required' using errcode = '22023';
  end if;

  if not private.has_permission(p_business_id, 'invoices.view') then
    raise exception 'insufficient_privilege' using errcode = '42501';
  end if;

  return query
  select bb.id, bb.name, bb.code, bb.status
  from public.business_branches bb
  where bb.business_id = p_business_id
  order by bb.is_default desc, bb.name asc;
end;
$$;

grant create on schema public to private_invoice_picker_reader;
alter function public.get_invoice_filter_branch_options(uuid) owner to private_invoice_picker_reader;
revoke create on schema public from private_invoice_picker_reader;
revoke all on function public.get_invoice_filter_branch_options(uuid) from public, anon, service_role;
grant execute on function public.get_invoice_filter_branch_options(uuid) to authenticated;

-- get_payable_invoice_options -----------------------------------------------
--
-- Backs the payment-recording surface's invoice picker
-- (/[businessId]/payments/record). Authorization: payments.record ALONE —
-- never invoices.view. Returns only invoices that can actually receive a
-- payment (ISSUED or PARTIALLY_PAID — never PAID or VOID, matching
-- record_invoice_payment's own INVOICE_ALREADY_PAID/INVOICE_VOID checks,
-- so a caller can never even select an ineligible invoice from this
-- picker, though the RPC remains the authoritative check regardless),
-- bounded to 25 rows, searched by invoice number or customer name.
create or replace function public.get_payable_invoice_options(
  p_business_id uuid,
  p_search      text default null
)
returns table (
  id                      uuid,
  invoice_number          text,
  customer_name_snapshot  text,
  branch_name_snapshot    text,
  total_amount            numeric,
  amount_paid             numeric,
  status                  text
)
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_pattern text;
begin
  if private.current_uid() is null then
    raise exception 'authentication required' using errcode = '28000';
  end if;
  if p_business_id is null then
    raise exception 'p_business_id is required' using errcode = '22023';
  end if;

  if not private.has_permission(p_business_id, 'payments.record') then
    raise exception 'insufficient_privilege' using errcode = '42501';
  end if;

  if p_search is not null and btrim(p_search) <> '' then
    v_pattern := '%' || replace(replace(replace(btrim(p_search), '\', '\\'), '%', '\%'), '_', '\_') || '%';
  end if;

  return query
  select i.id, i.invoice_number, i.customer_name_snapshot, i.branch_name_snapshot,
         i.total_amount, i.amount_paid, i.status
  from public.invoices i
  where i.business_id = p_business_id
    and i.status in ('ISSUED', 'PARTIALLY_PAID')
    and (
      v_pattern is null
      or i.invoice_number ilike v_pattern escape '\'
      or i.customer_name_snapshot ilike v_pattern escape '\'
    )
  order by i.created_at desc
  limit 25;
end;
$$;

grant create on schema public to private_invoice_picker_reader;
alter function public.get_payable_invoice_options(uuid, text) owner to private_invoice_picker_reader;
revoke create on schema public from private_invoice_picker_reader;
revoke all on function public.get_payable_invoice_options(uuid, text) from public, anon, service_role;
grant execute on function public.get_payable_invoice_options(uuid, text) to authenticated;

-- list_invoice_payments_for_viewer -----------------------------------------
--
-- Backs the payment-history surface (/[businessId]/payments). Authorization:
-- payments.view ALONE. public.invoice_payments' own SELECT policy
-- (20260831080300_create_invoice_payments.sql) is ALREADY gated on
-- payments.view directly — a payments.view-only caller can already read
-- the raw payment rows with no RLS gap at all. The actual gap this closes
-- is DISPLAY: invoice_number/customer_name_snapshot/branch_name_snapshot
-- live on public.invoices, whose OWN SELECT policy is gated on
-- invoices.view — a DIFFERENT permission — so a plain PostgREST embed
-- would independently re-enforce that policy and silently drop or block
-- the join for a payments.view-only caller. Reads across that boundary
-- under BYPASSRLS, exactly matching get_financial_summary's own
-- established precedent (20260827080600_get_financial_summary_rpc.sql)
-- for the identical "one permission, cross-table read" shape. Bounded to
-- the 100 most recent payments — a deliberate, documented scope choice
-- (Phase 1H's own product brief has no stated need for a fully paginated
-- payment ledger browser yet; the invoice detail page already shows a
-- given invoice's own full payment history via the ordinary
-- payments.view-gated RLS path), not a Phase 2 infrastructure gap.
create or replace function public.list_invoice_payments_for_viewer(
  p_business_id uuid,
  p_search      text default null
)
returns table (
  id                      uuid,
  paid_at                 timestamptz,
  invoice_number          text,
  customer_name_snapshot  text,
  branch_name_snapshot    text,
  amount                  numeric,
  payment_method          text,
  reference               text
)
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_pattern text;
begin
  if private.current_uid() is null then
    raise exception 'authentication required' using errcode = '28000';
  end if;
  if p_business_id is null then
    raise exception 'p_business_id is required' using errcode = '22023';
  end if;

  if not private.has_permission(p_business_id, 'payments.view') then
    raise exception 'insufficient_privilege' using errcode = '42501';
  end if;

  if p_search is not null and btrim(p_search) <> '' then
    v_pattern := '%' || replace(replace(replace(btrim(p_search), '\', '\\'), '%', '\%'), '_', '\_') || '%';
  end if;

  return query
  select ip.id, ip.paid_at, i.invoice_number, i.customer_name_snapshot, i.branch_name_snapshot,
         ip.amount, ip.payment_method, ip.reference
  from public.invoice_payments ip
  join public.invoices i
    on i.id = ip.invoice_id and i.business_id = ip.business_id
  where ip.business_id = p_business_id
    and (
      v_pattern is null
      or i.invoice_number ilike v_pattern escape '\'
      or i.customer_name_snapshot ilike v_pattern escape '\'
    )
  order by ip.paid_at desc, ip.id desc
  limit 100;
end;
$$;

grant create on schema public to private_invoice_picker_reader;
alter function public.list_invoice_payments_for_viewer(uuid, text) owner to private_invoice_picker_reader;
revoke create on schema public from private_invoice_picker_reader;
revoke all on function public.list_invoice_payments_for_viewer(uuid, text) from public, anon, service_role;
grant execute on function public.list_invoice_payments_for_viewer(uuid, text) to authenticated;

-- get_invoice_void_eligibility ----------------------------------------------
--
-- Backs the invoice detail page's Void button (Low 6). Authorization:
-- invoices.manage ALONE — never payments.view. Before this fix, a caller
-- holding invoices.manage but not payments.view received an empty
-- payments=[] array (application-layer RLS filtering, not a real "no
-- payments" fact) and the UI wrongly inferred "no payments -> show Void" —
-- void_invoice itself would have correctly rejected the call
-- (INVOICE_HAS_PAYMENTS), so this was a UI-only false affordance, never an
-- actual authorization bypass, but showing an action the backend will
-- always reject is a real defect. Returns a single authoritative boolean —
-- never the payment rows themselves (that remains payments.view's own,
-- separate concern) — computed identically to void_invoice's own
-- existence check.
create or replace function public.get_invoice_void_eligibility(
  p_business_id uuid,
  p_invoice_id  uuid
)
returns boolean
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_status      text;
  v_found_id    uuid;
  v_branch_id   uuid;
  v_has_payment boolean;
begin
  if private.current_uid() is null then
    raise exception 'authentication required' using errcode = '28000';
  end if;
  if p_business_id is null or p_invoice_id is null then
    raise exception 'p_business_id and p_invoice_id are required' using errcode = '22023';
  end if;

  if not private.has_permission(p_business_id, 'invoices.manage') then
    raise exception 'insufficient_privilege' using errcode = '42501';
  end if;

  select id, status, branch_id into v_found_id, v_status, v_branch_id
  from public.invoices
  where id = p_invoice_id and business_id = p_business_id;

  if v_found_id is null then
    raise exception 'INVOICE_NOT_FOUND' using errcode = '22023';
  end if;

  -- Codex security audit, SEC-01: identical branch-authorization rule as
  -- void_invoice itself (20260831080500_invoice_void_rpc.sql, same
  -- header comment) — never a distinguishable error for "found but wrong
  -- branch" versus "not found at all".
  if not private.has_branch_access(p_business_id, v_branch_id) then
    raise exception 'INVOICE_NOT_FOUND' using errcode = '22023';
  end if;

  if v_status = 'VOID' then
    return false;
  end if;

  select exists (
    select 1 from public.invoice_payments where invoice_id = p_invoice_id
  ) into v_has_payment;

  return not v_has_payment;
end;
$$;

grant create on schema public to private_invoice_picker_reader;
alter function public.get_invoice_void_eligibility(uuid, uuid) owner to private_invoice_picker_reader;
revoke create on schema public from private_invoice_picker_reader;
revoke all on function public.get_invoice_void_eligibility(uuid, uuid) from public, anon, service_role;
grant execute on function public.get_invoice_void_eligibility(uuid, uuid) to authenticated;
