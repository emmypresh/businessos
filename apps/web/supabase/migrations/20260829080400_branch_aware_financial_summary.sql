-- Phase 1G: branch-filterable financial summary.
--
-- public.get_financial_summary keeps its exact existing name and every
-- existing parameter in the exact existing order — ONE new trailing
-- parameter, defaulted, added via CREATE OR REPLACE FUNCTION. PostgREST
-- resolves RPC calls by NAMED parameter, so the current Phase 1F
-- application (which never sends a `p_branch_id` key) keeps getting the
-- exact same business-wide aggregate as before, byte-for-byte.
--
-- Semantics (documented here because they are a genuine product decision,
-- not merely mechanical):
--   p_branch_id IS NULL  -> business-wide, UNCHANGED from today: every
--     COMPLETED sale and every POSTED expense in range, regardless of
--     branch attribution — this is what makes "business-wide summary
--     includes both branch-attributed and company-wide expenses" true
--     without any special-casing: no branch filter is applied at all, so
--     a NULL-branch_id (company-wide) expense and a real-branch_id
--     (branch-attributed) expense are both included identically.
--   p_branch_id IS NOT NULL -> sales are restricted to that exact branch
--     (sales.branch_id is NOT NULL — see the branch-aware-sales
--     migration's own proof — so this is a plain equality filter), and
--     expenses are restricted to that exact branch's OWN attributed
--     expenses ONLY — a company-wide (NULL branch_id) expense is
--     EXCLUDED from a single-branch summary rather than arbitrarily
--     allocated across branches, per the Phase 1G brief's own explicit
--     recommendation. `branch_id = p_branch_id` already achieves this
--     without a separate "and branch_id is not null" clause: SQL's
--     three-valued logic makes `NULL = <any non-null value>` evaluate to
--     NULL (never TRUE), so a company-wide expense's WHERE clause simply
--     never matches once a specific branch is requested.
--
-- Authorization is UNCHANGED and deliberately stays that way:
-- reports.view alone, exactly as before, with no additional
-- has_branch_access requirement for a branch-filtered request. reports.view
-- is held by the same back-office tier as expenses.manage (OWNER, ADMIN,
-- MANAGER, ACCOUNTANT) and this function's own original design already
-- states the guiding principle explicitly ("reports.view is a permission
-- INDEPENDENT of sales.view/expenses.view... the underlying SELECTs run
-- under a dedicated BYPASSRLS role for exactly that reason") — it is a
-- deliberately broad financial-oversight permission, not an operational-
-- presence gate. Gating a NARROWER, single-branch-filtered view behind
-- something the BROADER business-wide view does not itself require would
-- be an inconsistent, accidental narrowing of exactly the owners'/
-- accountants' company-wide financial visibility the Phase 1G brief
-- explicitly warns against. The only branch-related check here is a
-- tenant-consistency one: p_branch_id, if given, must be a REAL branch OF
-- THIS BUSINESS — never an ACTIVE-only requirement, since historical
-- reporting must remain available for an inactive branch too (inactive
-- means "no NEW operational activity", never "erase history" — see the
-- Phase 1G brief's own "Inactive Branch Semantics" section).

-- Narrowed to exactly the columns the two aggregate queries now read —
-- never a whole-table grant, matching this role's own existing precedent.
grant select (branch_id) on public.sales to private_reports_reader;
grant select (branch_id) on public.expenses to private_reports_reader;
grant select (id, business_id) on public.business_branches to private_reports_reader;

-- CRITICAL: see branch_aware_sales.sql's own identical comment — CREATE OR
-- REPLACE FUNCTION only replaces a function whose argument-TYPE list is
-- unchanged; appending p_branch_id changes it, so the OLD three-parameter
-- signature must be dropped explicitly first, or it would coexist as a
-- second overload and break PostgREST's function resolution for every
-- ordinary call. This drops only that exact function object; the
-- migration FILE that originally created it is untouched.
drop function if exists public.get_financial_summary(uuid, timestamptz, timestamptz);

create or replace function public.get_financial_summary(
  p_business_id uuid,
  p_from        timestamptz,
  p_to          timestamptz,
  p_branch_id   uuid default null
)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  -- The exact maximum representable value of a numeric(14,2) column,
  -- mirroring create_sale's/create_expense's own v_max_money exactly —
  -- every aggregate below is validated against this BEFORE being embedded
  -- in the returned jsonb, so a pathological accumulation (however
  -- unlikely at this application's scale) never surfaces as a silent
  -- misrepresentation or a raw internal error.
  v_max_money       constant numeric := 999999999999.99;

  -- Deliberately UNCONSTRAINED `numeric` locals: Postgres numeric
  -- arithmetic itself never overflows — only an assignment into a
  -- precision/scale-constrained destination can — so these stay
  -- unconstrained all the way to the explicit range check below, never
  -- narrowed to numeric(14,2) at any point in this function.
  v_gross_sales     numeric;
  v_cash_collected  numeric;
  v_outstanding     numeric;
  v_expenses        numeric;
  v_net_cash_flow   numeric;
  v_sales_count     bigint;
  v_expense_count   bigint;
  v_branch_found_id uuid;
begin
  if private.current_uid() is null then
    raise exception 'authentication required' using errcode = '28000';
  end if;

  if p_business_id is null or p_from is null or p_to is null then
    raise exception 'p_business_id, p_from, and p_to are required' using errcode = '22023';
  end if;
  -- [p_from, p_to) — a half-open interval, checked explicitly rather than
  -- silently swapped or clamped: an equal or inverted range is a caller
  -- error, not a valid empty-result request.
  if p_from >= p_to then
    raise exception 'INVALID_REPORT_RANGE' using errcode = '22023';
  end if;

  -- AUTHORIZE — reports.view ONLY. Never sales.view, never expenses.view,
  -- never has_branch_access, never a role-name comparison. This is the
  -- caller's own permission, so it is safe (and correct) to check
  -- unconditionally on every call. See this file's own header comment for
  -- the full reasoning on why a branch filter does not additionally
  -- require has_branch_access.
  if not private.has_permission(p_business_id, 'reports.view') then
    raise exception 'insufficient_privilege' using errcode = '42501';
  end if;

  -- Tenant-consistency only — deliberately NOT an ACTIVE-only check (see
  -- this file's own header comment: inactive-branch history must remain
  -- reportable). A foreign/nonexistent branch id is rejected the same
  -- non-disclosing way every other cross-tenant reference in this schema
  -- is.
  if p_branch_id is not null then
    select id into v_branch_found_id
    from public.business_branches
    where id = p_branch_id and business_id = p_business_id;

    if v_branch_found_id is null then
      raise exception 'BRANCH_NOT_FOUND' using errcode = '22023';
    end if;
  end if;

  select
    coalesce(sum(total), 0),
    coalesce(sum(amount_paid), 0),
    coalesce(sum(total - amount_paid), 0),
    count(*)
  into v_gross_sales, v_cash_collected, v_outstanding, v_sales_count
  from public.sales
  where business_id = p_business_id
    and status = 'COMPLETED'
    and completed_at >= p_from
    and completed_at < p_to
    and (p_branch_id is null or branch_id = p_branch_id);

  select
    coalesce(sum(amount), 0),
    count(*)
  into v_expenses, v_expense_count
  from public.expenses
  where business_id = p_business_id
    and status = 'POSTED'
    and incurred_at >= p_from
    and incurred_at < p_to
    -- Excludes a company-wide (NULL branch_id) expense from a single-
    -- branch summary — see this file's own header comment.
    and (p_branch_id is null or branch_id = p_branch_id);

  if v_gross_sales > v_max_money or v_cash_collected > v_max_money
     or v_outstanding > v_max_money or v_expenses > v_max_money then
    raise exception 'REPORT_AMOUNT_OUT_OF_RANGE' using errcode = '22023';
  end if;

  v_net_cash_flow := v_cash_collected - v_expenses;

  -- Currency is hardcoded, not derived from any row: Phase 1E is
  -- single-currency by design (expenses.currency_code is fixed 'NGN' at
  -- the create_expense boundary, and every Phase 1D sale already defaults
  -- to 'NGN' too) — there is no per-business currency setting yet for
  -- this function to read.
  return jsonb_build_object(
    'currency_code', 'NGN',
    'gross_sales', v_gross_sales,
    'cash_collected', v_cash_collected,
    'outstanding_sales', v_outstanding,
    'expenses', v_expenses,
    'net_cash_flow', v_net_cash_flow,
    'sales_count', v_sales_count,
    'expense_count', v_expense_count
  );
end;
$$;

-- Ownership transfer + explicit, narrow EXECUTE surface — required in
-- full here (unlike a genuine in-place CREATE OR REPLACE) because the DROP
-- above means this is a freshly-created function object. Mirrors
-- get_financial_summary_rpc.sql's own original ownership/grant block
-- exactly, just for the new four-parameter signature.
grant create on schema public to private_reports_reader;
alter function public.get_financial_summary(uuid, timestamptz, timestamptz, uuid)
  owner to private_reports_reader;
revoke create on schema public from private_reports_reader;

revoke all on function public.get_financial_summary(uuid, timestamptz, timestamptz, uuid)
  from public, anon, service_role;
grant execute on function public.get_financial_summary(uuid, timestamptz, timestamptz, uuid)
  to authenticated;
