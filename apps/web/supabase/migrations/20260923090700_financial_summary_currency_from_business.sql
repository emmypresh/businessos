-- Phase 1Q-0C Slice 2: get_financial_summary stops hardcoding
-- 'currency_code', 'NGN' in its returned jsonb and instead derives it from
-- the owning business's own base currency (public.businesses.currency_code,
-- Phase 1Q-0A) — the same authoritative source expenses/invoices/sales all
-- now derive their own currency_code from (20260923090400-090600). Not
-- FX — a business still has exactly one base currency, so the aggregate
-- sums below never mix currencies: sales.currency_code and
-- expenses.currency_code are BOTH already durably enforced (via their own
-- BEFORE INSERT triggers) to equal this exact same business row's
-- currency_code, for every row summed here, regardless of range or branch
-- filter.
--
-- No signature change — CREATE OR REPLACE FUNCTION is safe here (unlike
-- the branch-aware migration's own DROP, which changed the parameter
-- list).

grant select (id, currency_code) on public.businesses to private_reports_reader;

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
  v_max_money       constant numeric := 999999999999.99;

  v_gross_sales     numeric;
  v_cash_collected  numeric;
  v_outstanding     numeric;
  v_expenses        numeric;
  v_net_cash_flow   numeric;
  v_sales_count     bigint;
  v_expense_count   bigint;
  v_branch_found_id uuid;
  v_business_currency text;
begin
  if private.current_uid() is null then
    raise exception 'authentication required' using errcode = '28000';
  end if;

  if p_business_id is null or p_from is null or p_to is null then
    raise exception 'p_business_id, p_from, and p_to are required' using errcode = '22023';
  end if;
  if p_from >= p_to then
    raise exception 'INVALID_REPORT_RANGE' using errcode = '22023';
  end if;

  if not private.has_permission(p_business_id, 'reports.view') then
    raise exception 'insufficient_privilege' using errcode = '42501';
  end if;

  if p_branch_id is not null then
    select id into v_branch_found_id
    from public.business_branches
    where id = p_branch_id and business_id = p_business_id;

    if v_branch_found_id is null then
      raise exception 'BRANCH_NOT_FOUND' using errcode = '22023';
    end if;
  end if;

  -- The business's own base currency — Phase 1Q-0C. p_business_id has
  -- already been proven valid by the has_permission check above (a
  -- nonexistent business can never hold a permission grant).
  select currency_code into v_business_currency
  from public.businesses
  where id = p_business_id;

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
    and (p_branch_id is null or branch_id = p_branch_id);

  if v_gross_sales > v_max_money or v_cash_collected > v_max_money
     or v_outstanding > v_max_money or v_expenses > v_max_money then
    raise exception 'REPORT_AMOUNT_OUT_OF_RANGE' using errcode = '22023';
  end if;

  v_net_cash_flow := v_cash_collected - v_expenses;

  return jsonb_build_object(
    'currency_code', v_business_currency,
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
