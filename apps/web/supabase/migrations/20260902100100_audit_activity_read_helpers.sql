-- Phase 1J — APPLICATION. One small, additive read-side helper for the
-- Activity feed's own branch filter.
--
-- WHY THIS IS NEEDED (per this phase's own explicit "stop/report before
-- adding another SECURITY DEFINER surface unless clearly justified"
-- instruction): audit.view is deliberately business-wide and does NOT
-- imply branches.view (this phase's own frozen foundation, documented in
-- 20260902090000_create_audit_events.sql's own header comment). The
-- Activity feed's branch filter needs branch NAMES to display, but
-- public.business_branches' own SELECT policy
-- (20260828080000_create_business_branches.sql) is gated on
-- branches.view — a permission audit.view does not imply. A plain
-- RLS-backed query would therefore silently require branches.view,
-- exactly the "silent permission dependency" this phase's own
-- instructions explicitly forbid. audit_events itself carries branch_id
-- but NO branch_name_snapshot column (confirmed by inspecting the frozen
-- foundation directly, not assumed) — option A ("safe RLS-compatible
-- branch query") and option "derive labels from audit_events itself" are
-- therefore both unavailable. This is the SAME permission-contract gap
-- Phase 1H/1I's own remediation rounds already hit and fixed identically
-- for invoices/returns (get_invoice_filter_branch_options,
-- get_returns_branch_filter_options) — this migration applies the
-- identical, already-reviewed fix, never a new pattern.
--
-- Business-wide (never scoped to the caller's own operational branch
-- assignment), matching audit.view's own business-wide read model
-- exactly, and includes INACTIVE branches — a historical audit event can
-- reference a since-deactivated branch (branch.deactivated is itself one
-- of this phase's own instrumented events).

do $$
begin
  if not exists (select 1 from pg_catalog.pg_roles where rolname = 'private_audit_picker_reader') then
    create role private_audit_picker_reader noinherit nologin bypassrls;
  end if;
end;
$$;

grant private_audit_picker_reader to postgres;

grant usage on schema public to private_audit_picker_reader;
grant usage on schema private to private_audit_picker_reader;

-- is_default is referenced in this function's own ORDER BY clause below
-- — Postgres requires SELECT privilege on every column referenced
-- anywhere in a query, not merely the ones in its SELECT list.
grant select (id, business_id, name, code, status, is_default)
  on public.business_branches to private_audit_picker_reader;
grant execute on function private.current_uid() to private_audit_picker_reader;
grant execute on function private.has_permission(uuid, text) to private_audit_picker_reader;

create or replace function public.get_audit_branch_filter_options(p_business_id uuid)
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

  if not private.has_permission(p_business_id, 'audit.view') then
    raise exception 'insufficient_privilege' using errcode = '42501';
  end if;

  return query
  select bb.id, bb.name, bb.code, bb.status
  from public.business_branches bb
  where bb.business_id = p_business_id
  order by bb.is_default desc, bb.name asc;
end;
$$;

grant create on schema public to private_audit_picker_reader;
alter function public.get_audit_branch_filter_options(uuid) owner to private_audit_picker_reader;
revoke create on schema public from private_audit_picker_reader;
revoke all on function public.get_audit_branch_filter_options(uuid) from public, anon, service_role;
grant execute on function public.get_audit_branch_filter_options(uuid) to authenticated;
