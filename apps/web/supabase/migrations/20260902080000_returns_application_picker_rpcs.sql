-- Phase 1I APPLICATION LAYER — additive picker/filter RPCs closing a
-- permission-contract gap discovered while building the create-return and
-- returns-list surfaces. ADDITIVE ONLY: does not alter any of the five
-- frozen Phase 1I DB-foundation migrations (20260901080000 through
-- 20260901080400, approved and frozen at commit 1505cad), any Phase 1A-1H
-- migration, or any existing table's SELECT policy/grant/role.
--
-- BLOCKER DISCOVERED (documented per this round's own explicit
-- instruction to "stop and clearly document the application-contract
-- blocker before modifying DB" — this migration IS that documented fix,
-- following the exact precedent Phase 1H's own remediation round already
-- established for the identical class of problem):
--
--   1. Return CREATION is authorized on returns.manage alone (per
--      create_sale_return's own header comment: "returns.manage must
--      NEVER silently require an unrelated permission such as
--      sales.create"). But the create-return UI needs a sale picker AND a
--      returnable-item lookup — public.sales'/public.sale_items' own
--      SELECT policies (20260826090400_create_sales_and_sale_items.sql)
--      are gated on sales.view, a permission returns.manage does NOT
--      imply. A returns.manage-only caller (no sales.view) could reach
--      create_sale_return directly with a known sale_id, but had no safe,
--      permission-correct way to even find or inspect one through the
--      application. Fixed by get_returnable_sale_options/
--      get_returnable_sale_items below, both authorized on returns.manage
--      alone.
--   2. The returns LIST's branch filter needs branch names. public.
--      business_branches' own SELECT policy
--      (20260828080000_create_business_branches.sql) is gated on
--      branches.view, a permission returns.view does NOT imply — and
--      sale_returns_select's own RLS (returns.view) is business-wide,
--      never scoped to the caller's own branch membership, so the filter
--      must expose the SAME business-wide set, not merely the caller's
--      operational branches. Fixed by get_returns_branch_filter_options
--      below, authorized on returns.view alone — mirrors
--      get_invoice_filter_branch_options
--      (20260831080700_invoice_picker_rpcs.sql) exactly.
--
-- Neither gap is a defect in the frozen DB foundation itself — Codex's own
-- review approved that foundation for its OWN documented scope (the
-- create_sale_return RPC's authorization contract, tested and confirmed
-- correct). This is the same "referenced-resource visibility gap for a
-- narrower permission than the table's own RLS" class of problem Phase 1H
-- hit and fixed the identical way, one phase later, via its own additive
-- picker-RPC migration — never by widening returns.manage/returns.view's
-- own meaning, and never by granting sales.view/branches.view to a caller
-- who does not hold them.
--
-- ┌─────────────────────────────────────────────────────────────────────┐
-- │ SECURITY REVIEW REQUIRED FOR ANY FUTURE GRANT TO THIS ROLE.          │
-- │ private_returns_picker_reader is a DELIBERATE, DOCUMENTED exception   │
-- │ to this codebase's usual "one narrow role per RPC" convention —      │
-- │ mirrors private_invoice_picker_reader's own identical, already-      │
-- │ reviewed precedent exactly: all three functions below are read-only,  │
-- │ side-effect-free, and share one purpose (resolving Phase 1I picker/   │
-- │ filter metadata across a permission boundary PostgREST's own          │
-- │ per-table RLS cannot cross). Never extend this role's grants to solve  │
-- │ some other function's privilege problem — give that one its own       │
-- │ dedicated role instead.                                                │
-- └─────────────────────────────────────────────────────────────────────┘
do $$
begin
  if not exists (select 1 from pg_catalog.pg_roles where rolname = 'private_returns_picker_reader') then
    create role private_returns_picker_reader noinherit nologin bypassrls;
  end if;
end;
$$;

grant private_returns_picker_reader to postgres;

grant usage on schema public to private_returns_picker_reader;
grant usage on schema private to private_returns_picker_reader;

-- Least-privilege column grants — exactly what the three function bodies
-- below read or filter on. No cost/COGS column anywhere (unit_cost_snapshot
-- on sale_items is deliberately NEVER granted here — mirrors that column's
-- own "never exposed to authenticated at all" treatment in
-- create_sales_and_sale_items.sql).
grant select (id, business_id, name, code, status, is_default)
  on public.business_branches to private_returns_picker_reader;
grant select (id, business_id, member_id, branch_id, is_primary)
  on public.business_member_branches to private_returns_picker_reader;
grant select (id, business_id, user_id, status)
  on public.business_members to private_returns_picker_reader;
grant select (
  id, business_id, sale_number, customer_name_snapshot, branch_id, branch_name_snapshot,
  status, total, amount_paid, completed_at
) on public.sales to private_returns_picker_reader;
grant select (id, business_id, sale_id, product_name_snapshot, sku_snapshot, quantity, unit_price)
  on public.sale_items to private_returns_picker_reader;
grant select (business_id, sale_item_id, quantity)
  on public.sale_return_items to private_returns_picker_reader;
-- Read for list_returns_for_viewer below (see that function's own header
-- comment for why the LIST specifically needs a BYPASSRLS join, unlike
-- the detail page's own plain, returns.view-gated RLS reads elsewhere).
grant select (
  id, business_id, return_number, sale_id, branch_id, branch_name_snapshot,
  reason, refund_amount, refund_method, status, created_at
) on public.sale_returns to private_returns_picker_reader;

grant execute on function private.current_uid() to private_returns_picker_reader;
grant execute on function private.has_permission(uuid, text) to private_returns_picker_reader;
grant execute on function private.has_branch_access(uuid, uuid) to private_returns_picker_reader;

-- get_returnable_sale_options -----------------------------------------------
--
-- Backs the create-return UI's sale picker. Authorization: returns.manage
-- ALONE — never sales.view, never branches.view. Scoped to the caller's
-- OWN assigned, ACTIVE branches (mirrors get_invoice_branch_options' own
-- branch-membership join exactly) — a return is an operational activity
-- tied to where the caller can act, matching create_sale_return's own
-- has_branch_access authorization. Only COMPLETED sales (the only
-- return-eligible status — matches create_sale_return's own
-- RETURN_SALE_NOT_ELIGIBLE check), bounded to 25 rows, searched by sale
-- number or customer name snapshot. No cost/COGS column returned.
create or replace function public.get_returnable_sale_options(
  p_business_id uuid,
  p_search      text default null
)
returns table (
  id                      uuid,
  sale_number             text,
  customer_name_snapshot  text,
  branch_name_snapshot    text,
  completed_at            timestamptz,
  total                   numeric,
  amount_paid             numeric
)
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_member_id uuid;
  v_pattern   text;
begin
  if private.current_uid() is null then
    raise exception 'authentication required' using errcode = '28000';
  end if;
  if p_business_id is null then
    raise exception 'p_business_id is required' using errcode = '22023';
  end if;

  if not private.has_permission(p_business_id, 'returns.manage') then
    raise exception 'insufficient_privilege' using errcode = '42501';
  end if;

  select bm.id into v_member_id
  from public.business_members bm
  where bm.business_id = p_business_id
    and bm.user_id = private.current_uid()
    and bm.status = 'active';

  if p_search is not null and btrim(p_search) <> '' then
    v_pattern := '%' || replace(replace(replace(btrim(p_search), '\', '\\'), '%', '\%'), '_', '\_') || '%';
  end if;

  return query
  select s.id, s.sale_number, s.customer_name_snapshot, s.branch_name_snapshot,
         s.completed_at, s.total, s.amount_paid
  from public.sales s
  join public.business_member_branches bmb
    on bmb.business_id = s.business_id and bmb.branch_id = s.branch_id and bmb.member_id = v_member_id
  where s.business_id = p_business_id
    and s.status = 'COMPLETED'
    and (
      v_pattern is null
      or s.sale_number ilike v_pattern escape '\'
      or s.customer_name_snapshot ilike v_pattern escape '\'
    )
  order by s.completed_at desc
  limit 25;
end;
$$;

grant create on schema public to private_returns_picker_reader;
alter function public.get_returnable_sale_options(uuid, text) owner to private_returns_picker_reader;
revoke create on schema public from private_returns_picker_reader;
revoke all on function public.get_returnable_sale_options(uuid, text) from public, anon, service_role;
grant execute on function public.get_returnable_sale_options(uuid, text) to authenticated;

-- get_returnable_sale_items -------------------------------------------------
--
-- Backs the create-return UI's item lookup, after the caller picks a
-- sale. Authorization: returns.manage ALONE. Applies the IDENTICAL
-- non-disclosure/eligibility contract create_sale_return itself enforces
-- — same error codes, same order — so this helper can never disagree with
-- the mutation it feeds: a foreign-tenant, nonexistent, or
-- inaccessible-branch sale_id all raise the SAME generic
-- RETURN_SALE_NOT_FOUND (checked before the distinguishable
-- RETURN_SALE_NOT_ELIGIBLE status check), never a distinguishable
-- disclosure. Returns each sale_item's own already-returned quantity
-- (summed from sale_return_items, business-scoped) alongside the
-- authoritative original quantity/unit_price — the application never
-- computes "remaining" from anything other than this server-derived
-- value. No cost/COGS column returned.
create or replace function public.get_returnable_sale_items(
  p_business_id uuid,
  p_sale_id     uuid
)
returns table (
  sale_item_id           uuid,
  product_name_snapshot  text,
  sku_snapshot           text,
  quantity               numeric,
  unit_price             numeric,
  already_returned       numeric
)
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_sale_found     uuid;
  v_sale_status    text;
  v_sale_branch_id uuid;
begin
  if private.current_uid() is null then
    raise exception 'authentication required' using errcode = '28000';
  end if;
  if p_business_id is null or p_sale_id is null then
    raise exception 'p_business_id and p_sale_id are required' using errcode = '22023';
  end if;

  if not private.has_permission(p_business_id, 'returns.manage') then
    raise exception 'insufficient_privilege' using errcode = '42501';
  end if;

  select s.id, s.status, s.branch_id into v_sale_found, v_sale_status, v_sale_branch_id
  from public.sales s
  where s.id = p_sale_id and s.business_id = p_business_id;

  if v_sale_found is null then
    raise exception 'RETURN_SALE_NOT_FOUND' using errcode = '22023';
  end if;

  if not private.has_branch_access(p_business_id, v_sale_branch_id) then
    raise exception 'RETURN_SALE_NOT_FOUND' using errcode = '22023';
  end if;

  if v_sale_status <> 'COMPLETED' then
    raise exception 'RETURN_SALE_NOT_ELIGIBLE' using errcode = '23514';
  end if;

  return query
  select si.id, si.product_name_snapshot, si.sku_snapshot, si.quantity, si.unit_price,
         coalesce(sri.total_returned, 0) as already_returned
  from public.sale_items si
  left join (
    select sri_inner.sale_item_id as returned_for_item_id, sum(sri_inner.quantity) as total_returned
    from public.sale_return_items sri_inner
    where sri_inner.business_id = p_business_id
    group by sri_inner.sale_item_id
  ) sri on sri.returned_for_item_id = si.id
  where si.sale_id = p_sale_id and si.business_id = p_business_id
  order by si.id asc;
end;
$$;

grant create on schema public to private_returns_picker_reader;
alter function public.get_returnable_sale_items(uuid, uuid) owner to private_returns_picker_reader;
revoke create on schema public from private_returns_picker_reader;
revoke all on function public.get_returnable_sale_items(uuid, uuid) from public, anon, service_role;
grant execute on function public.get_returnable_sale_items(uuid, uuid) to authenticated;

-- get_returns_branch_filter_options -----------------------------------------
--
-- Backs the returns list's branch filter. Authorization: returns.view
-- ALONE — never branches.view. returns.view is business-wide (never
-- scoped to operational branch assignment — sale_returns_select's own RLS
-- policy, 20260901080100_create_sale_returns_and_items.sql, checks only
-- private.has_permission(business_id, 'returns.view')), so this returns
-- the full business-wide branch set, including INACTIVE branches — a
-- historical return can reference a since-deactivated branch, matching
-- get_invoice_filter_branch_options' own identical treatment.
create or replace function public.get_returns_branch_filter_options(p_business_id uuid)
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

  if not private.has_permission(p_business_id, 'returns.view') then
    raise exception 'insufficient_privilege' using errcode = '42501';
  end if;

  return query
  select bb.id, bb.name, bb.code, bb.status
  from public.business_branches bb
  where bb.business_id = p_business_id
  order by bb.is_default desc, bb.name asc;
end;
$$;

grant create on schema public to private_returns_picker_reader;
alter function public.get_returns_branch_filter_options(uuid) owner to private_returns_picker_reader;
revoke create on schema public from private_returns_picker_reader;
revoke all on function public.get_returns_branch_filter_options(uuid) from public, anon, service_role;
grant execute on function public.get_returns_branch_filter_options(uuid) to authenticated;

-- list_returns_for_viewer ---------------------------------------------------
--
-- Backs the returns LIST page (/[businessId]/returns). Authorization:
-- returns.view ALONE. public.sale_returns' own SELECT policy
-- (20260901080100_create_sale_returns_and_items.sql) is ALREADY gated on
-- returns.view directly — a returns.view-only caller can already read the
-- raw sale_returns rows with no RLS gap at all (the detail page's own
-- reads go through that ordinary RLS path, unchanged). The actual gap
-- this closes is DISPLAY: the list's own "Sale #" column
-- (sale_number) lives on public.sales, whose SELECT policy is gated on
-- sales.view — a permission returns.view does NOT imply. Reads across
-- that boundary under BYPASSRLS, mirroring
-- list_invoice_payments_for_viewer's own established precedent for the
-- identical "one permission, cross-table display column" shape, but WITH
-- real keyset pagination (created_at, id both desc — matches
-- lib/pagination.ts's own cursor shape exactly), since — unlike that
-- lighter-weight payment-history precedent — the returns list is a
-- primary, paginated browsing surface, not a bounded recent-activity feed.
--
-- Codex application-layer security review, SEC-01: this function is a
-- directly callable `authenticated`-granted RPC — an authenticated
-- caller can invoke it with ANY p_search value, bypassing
-- listReturns' own application-layer truncation
-- (lib/returns/dal.ts, MAX_SEARCH_LENGTH = 200) entirely. p_search is
-- therefore independently truncated to 200 characters HERE, into its own
-- local variable, BEFORE btrim/wildcard-escaping ever runs on it — never
-- after the (potentially expensive, unboundedly long) pattern has already
-- been constructed. This is defense in depth, not a rate-limiting
-- subsystem (INFO-01 remains deferred to Phase 1P) — a deterministic,
-- cheap length bound only, mirroring this same function's own
-- pre-existing v_limit clamp immediately below.
create or replace function public.list_returns_for_viewer(
  p_business_id      uuid,
  p_search           text default null,
  p_branch_id        uuid default null,
  p_reason           text default null,
  p_cursor_created_at timestamptz default null,
  p_cursor_id        uuid default null,
  p_limit            int default 25
)
returns table (
  id                    uuid,
  return_number         text,
  sale_id               uuid,
  sale_number           text,
  branch_name_snapshot  text,
  reason                text,
  refund_amount         numeric,
  refund_method         text,
  status                text,
  created_at            timestamptz
)
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_search  text;
  v_pattern text;
  v_limit   int;
begin
  if private.current_uid() is null then
    raise exception 'authentication required' using errcode = '28000';
  end if;
  if p_business_id is null then
    raise exception 'p_business_id is required' using errcode = '22023';
  end if;

  if not private.has_permission(p_business_id, 'returns.view') then
    raise exception 'insufficient_privilege' using errcode = '42501';
  end if;

  -- Deterministic, cheap bound on the page size itself — never trusts an
  -- arbitrarily large caller-supplied p_limit (INFO-01 carryover: a
  -- length/size bound, never a rate-limiting subsystem).
  v_limit := least(greatest(coalesce(p_limit, 25), 1), 100);

  -- SEC-01: truncated to 200 characters into its OWN local variable
  -- first — before btrim, before wildcard-escaping, before the pattern is
  -- built — so an arbitrarily long p_search never reaches any of that
  -- work, regardless of caller (application DAL or a direct authenticated
  -- RPC call).
  v_search := left(p_search, 200);
  if v_search is not null and btrim(v_search) <> '' then
    v_pattern := '%' || replace(replace(replace(btrim(v_search), '\', '\\'), '%', '\%'), '_', '\_') || '%';
  end if;

  return query
  select sr.id, sr.return_number, sr.sale_id, s.sale_number, sr.branch_name_snapshot,
         sr.reason, sr.refund_amount, sr.refund_method, sr.status, sr.created_at
  from public.sale_returns sr
  join public.sales s
    on s.id = sr.sale_id and s.business_id = sr.business_id
  where sr.business_id = p_business_id
    and (p_branch_id is null or sr.branch_id = p_branch_id)
    and (p_reason is null or sr.reason = p_reason)
    and (
      v_pattern is null
      or sr.return_number ilike v_pattern escape '\'
      or s.sale_number ilike v_pattern escape '\'
    )
    and (
      p_cursor_created_at is null
      or sr.created_at < p_cursor_created_at
      or (sr.created_at = p_cursor_created_at and sr.id < p_cursor_id)
    )
  order by sr.created_at desc, sr.id desc
  limit v_limit;
end;
$$;

grant create on schema public to private_returns_picker_reader;
alter function public.list_returns_for_viewer(uuid, text, uuid, text, timestamptz, uuid, int) owner to private_returns_picker_reader;
revoke create on schema public from private_returns_picker_reader;
revoke all on function public.list_returns_for_viewer(uuid, text, uuid, text, timestamptz, uuid, int) from public, anon, service_role;
grant execute on function public.list_returns_for_viewer(uuid, text, uuid, text, timestamptz, uuid, int) to authenticated;
