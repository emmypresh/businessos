-- Phase 1E: expense voiding — the ONLY authorized path to move a POSTED
-- expense to VOIDED. Financial expenses are never deleted and never
-- un-voided in Phase 1E; there is no other status transition this
-- function (or any other) performs.
--
-- ┌─────────────────────────────────────────────────────────────────────┐
-- │ SECURITY REVIEW REQUIRED FOR ANY FUTURE GRANT TO THIS ROLE.          │
-- │ BYPASSRLS is a role-wide attribute, not scoped to the table it's     │
-- │ granted on today. Never extend private_expense_voider's table grants │
-- │ as a quick fix for some other function's privilege problem; give     │
-- │ that function its own dedicated minimal role instead — this role     │
-- │ exists ONLY for void_expense, deliberately separate from             │
-- │ private_expense_writer (create_expense_creation_requests_and_rpc.sql),│
-- │ which has no UPDATE privilege on public.expenses at all.             │
-- └─────────────────────────────────────────────────────────────────────┘
do $$
begin
  if not exists (select 1 from pg_catalog.pg_roles where rolname = 'private_expense_voider') then
    create role private_expense_voider noinherit nologin bypassrls;
  end if;
end;
$$;

grant private_expense_voider to postgres;

grant usage on schema public to private_expense_voider;
grant usage on schema private to private_expense_voider;

-- SELECT narrowed to exactly (id, business_id, status) — the WHERE clause
-- and the already-voided check are all this function reads back; UPDATE
-- narrowed to exactly the four void-state columns void_expense ever
-- writes — never amount/category/date/etc. This is what makes "no
-- amount/category/date rewrite" a grant-level guarantee, not merely a
-- promise the function body happens to keep (belt and suspenders on top
-- of expenses_enforce_immutable_fields, which independently protects
-- every other column against every writer).
grant select (id, business_id, status) on public.expenses to private_expense_voider;
grant update (status, voided_at, voided_by, void_reason) on public.expenses to private_expense_voider;

grant execute on function private.current_uid() to private_expense_voider;
grant execute on function private.has_permission(uuid, text) to private_expense_voider;

create or replace function public.void_expense(
  p_business_id uuid,
  p_expense_id  uuid,
  p_reason      text
)
returns uuid  -- expense_id ONLY, matching create_expense's own return shape.
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_uid       uuid;
  v_reason    text;
  v_status    text;
  v_found_id  uuid;
begin
  v_uid := private.current_uid();
  if v_uid is null then
    raise exception 'authentication required' using errcode = '28000';
  end if;

  if p_business_id is null or p_expense_id is null then
    raise exception 'p_business_id and p_expense_id are required' using errcode = '22023';
  end if;

  -- The caller's OWN permission — never inferred from anything about the
  -- target expense, so this is safe to check before the target is even
  -- looked up.
  if not private.has_permission(p_business_id, 'expenses.manage') then
    raise exception 'insufficient_privilege' using errcode = '42501';
  end if;

  v_reason := nullif(btrim(p_reason), '');
  if v_reason is null or length(v_reason) > 500 then
    raise exception 'INVALID_VOID_REASON' using errcode = '22023';
  end if;

  -- Scoped directly in the WHERE clause (a foreign-tenant expense is
  -- never loaded at all, not loaded-then-compared) and locked FOR UPDATE
  -- — a second concurrent void of the SAME expense blocks on this lock
  -- until the first commits, then re-reads status = 'VOIDED' and
  -- correctly raises EXPENSE_ALREADY_VOIDED rather than racing.
  select id, status into v_found_id, v_status
  from public.expenses
  where id = p_expense_id and business_id = p_business_id
  for update;

  if v_found_id is null then
    -- Nonexistent id and foreign-tenant id are indistinguishable to the
    -- caller — same controlled error either way, matching
    -- CUSTOMER_NOT_FOUND's/PRODUCT_NOT_FOUND's own non-disclosure
    -- treatment in create_sale.
    raise exception 'EXPENSE_NOT_FOUND' using errcode = '22023';
  end if;

  if v_status = 'VOIDED' then
    raise exception 'EXPENSE_ALREADY_VOIDED' using errcode = '23514';
  end if;

  -- Only the four void-state columns are ever written here — no
  -- amount/category/date/etc. rewrite, enforced both by this statement's
  -- own column list and by the narrowed GRANT above.
  update public.expenses
  set status = 'VOIDED', voided_at = now(), voided_by = v_uid, void_reason = v_reason
  where id = p_expense_id and business_id = p_business_id;

  return p_expense_id;
end;
$$;

grant create on schema public to private_expense_voider;
alter function public.void_expense(uuid, uuid, text) owner to private_expense_voider;
revoke create on schema public from private_expense_voider;

-- Explicit, narrow surface: EXECUTE to `authenticated` only. No
-- `service_role` grant — matching every other Phase 1D/1E RPC's own
-- precedent (no concrete service_role actor calling this yet).
revoke all on function public.void_expense(uuid, uuid, text) from public, anon, service_role;
grant execute on function public.void_expense(uuid, uuid, text) to authenticated;
