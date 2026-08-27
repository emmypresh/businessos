-- Phase 1E: the financial-summary reporting foundation.
--
-- public.get_financial_summary is CASH FLOW information, not accounting
-- profit — it reports gross sales, cash collected, outstanding sales,
-- expenses, and net cash flow for a [p_from, p_to) window. It never
-- computes or exposes cost, COGS, profit, margin, or tax liability; those
-- remain explicitly out of scope for Phase 1E (see sale_items.unit_cost_snapshot's
-- own "NOT formal accounting COGS" comment in create_sales_and_sale_items.sql
-- — this function doesn't even reference that column).
--
-- reports.view is a permission INDEPENDENT of sales.view/expenses.view: a
-- caller holding reports.view but neither of those two may still call
-- this function and get the real aggregate — the underlying SELECTs run
-- under a dedicated BYPASSRLS role for exactly that reason (RLS on
-- public.sales/public.expenses is gated on sales.view/expenses.view,
-- which would otherwise silently zero out or partially filter the
-- aggregate for a caller who has reports.view but not those two,
-- defeating the entire point of a separate permission). Symmetrically,
-- holding sales.view/expenses.view alone — without reports.view — grants
-- no access to this function at all; the ONLY gate checked here is
-- reports.view, never inferred from anything else, never by role name.
--
-- RETURNS JSONB, not a typed composite: every returned field is either an
-- explicitly COALESCE(..., 0)'d aggregate or a fixed literal ('NGN'), so
-- (unlike public.get_product_cost's own reason for choosing jsonb) there
-- is no genuinely-nullable value here to misrepresent — jsonb is used
-- instead for a small, deliberately narrow, self-describing return shape
-- (exactly the eight named fields below, nothing else), matching this
-- codebase's existing "hand-authored JSON accessor" precedent rather than
-- introducing a first-of-its-kind typed composite/SETOF return shape.
--
-- ┌─────────────────────────────────────────────────────────────────────┐
-- │ SECURITY REVIEW REQUIRED FOR ANY FUTURE GRANT TO THIS ROLE.          │
-- │ BYPASSRLS is a role-wide attribute, not scoped to the two tables it's │
-- │ granted on today. Never extend private_reports_reader's table grants │
-- │ as a quick fix for some other function's privilege problem; give     │
-- │ that function its own dedicated minimal role instead.                │
-- └─────────────────────────────────────────────────────────────────────┘
do $$
begin
  if not exists (select 1 from pg_catalog.pg_roles where rolname = 'private_reports_reader') then
    create role private_reports_reader noinherit nologin bypassrls;
  end if;
end;
$$;

grant private_reports_reader to postgres;

grant usage on schema public to private_reports_reader;
grant usage on schema private to private_reports_reader;

-- Least-privilege: SELECT narrowed to exactly the columns this function's
-- two aggregate queries read — never a whole-table grant, and never
-- cost/unit_cost_snapshot-adjacent columns (this function has no
-- business reading those; it is not a cost/profit accessor).
grant select (business_id, total, amount_paid, status, completed_at)
  on public.sales to private_reports_reader;
grant select (business_id, amount, status, incurred_at)
  on public.expenses to private_reports_reader;

grant execute on function private.current_uid() to private_reports_reader;
grant execute on function private.has_permission(uuid, text) to private_reports_reader;

create or replace function public.get_financial_summary(
  p_business_id uuid,
  p_from        timestamptz,
  p_to          timestamptz
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
  -- never a role-name comparison. This is the caller's own permission, so
  -- it is safe (and correct) to check unconditionally on every call.
  if not private.has_permission(p_business_id, 'reports.view') then
    raise exception 'insufficient_privilege' using errcode = '42501';
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
    and completed_at < p_to;

  select
    coalesce(sum(amount), 0),
    count(*)
  into v_expenses, v_expense_count
  from public.expenses
  where business_id = p_business_id
    and status = 'POSTED'
    and incurred_at >= p_from
    and incurred_at < p_to;

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

grant create on schema public to private_reports_reader;
alter function public.get_financial_summary(uuid, timestamptz, timestamptz)
  owner to private_reports_reader;
revoke create on schema public from private_reports_reader;

-- Explicit, narrow surface: EXECUTE to `authenticated` only.
revoke all on function public.get_financial_summary(uuid, timestamptz, timestamptz)
  from public, anon, service_role;
grant execute on function public.get_financial_summary(uuid, timestamptz, timestamptz)
  to authenticated;
