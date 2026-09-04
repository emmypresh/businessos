-- Phase 1K — APPLICATION. One small, additive read-side helper for the
-- notification feed's own branch-name display.
--
-- WHY THIS IS NEEDED: this phase deliberately introduces NO
-- "notifications.view" permission (see the writer migration's own header
-- comment) — recipient targeting + active business membership is the
-- ENTIRE read-authority model. A notification's branch_id is informational
-- (see the DB foundation's own header comment), and public.business_branches'
-- own SELECT policy is gated on branches.view — a permission a
-- notification recipient need not hold. A plain RLS-backed query for
-- branch names would therefore silently require branches.view, exactly
-- the "silent permission dependency" this codebase's own Phase 1H/1I/1J
-- precedent already fixed identically for invoices/returns/audit
-- (get_invoice_filter_branch_options, get_returns_branch_filter_options,
-- get_audit_branch_filter_options) — this migration applies the
-- identical, already-reviewed fix, never a new pattern.
--
-- Gated on `private.is_business_member` alone (never branches.view, never
-- a new permission) — a branch NAME is a low-sensitivity display label a
-- notification's own recipient already has legitimate context for (they
-- can already see the notification and its raw branch_id; this only
-- resolves that id to a human-readable name), mirroring how a
-- notification's own title/body is already visible to them regardless of
-- any operational permission.

do $$
begin
  if not exists (select 1 from pg_catalog.pg_roles where rolname = 'private_notification_picker_reader') then
    create role private_notification_picker_reader noinherit nologin bypassrls;
  end if;
end;
$$;

grant private_notification_picker_reader to postgres;

grant usage on schema public to private_notification_picker_reader;
grant usage on schema private to private_notification_picker_reader;

grant select (id, business_id, name) on public.business_branches to private_notification_picker_reader;
grant execute on function private.current_uid() to private_notification_picker_reader;
grant execute on function private.is_business_member(uuid) to private_notification_picker_reader;

create or replace function public.get_notification_branch_options(p_business_id uuid)
returns table (id uuid, name text)
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

  if not private.is_business_member(p_business_id) then
    raise exception 'insufficient_privilege' using errcode = '42501';
  end if;

  return query
  select bb.id, bb.name
  from public.business_branches bb
  where bb.business_id = p_business_id;
end;
$$;

grant create on schema public to private_notification_picker_reader;
alter function public.get_notification_branch_options(uuid) owner to private_notification_picker_reader;
revoke create on schema public from private_notification_picker_reader;
revoke all on function public.get_notification_branch_options(uuid) from public, anon, service_role;
grant execute on function public.get_notification_branch_options(uuid) to authenticated;
