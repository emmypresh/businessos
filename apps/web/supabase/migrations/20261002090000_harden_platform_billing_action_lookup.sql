-- Phase 1O-D remediation — Billing action lookup data-minimization fix.
--
-- Codex finding (MEDIUM): list_platform_action_eligible_businesses
-- (20261002080000) behaved like a global business directory rather than a
-- targeted action lookup:
--   - a blank/missing search normalized to NULL, and NULL matched every
--     business (`v_search is null or ...`);
--   - `%`/`_` in caller input were interpreted as ILIKE wildcards, letting
--     a crafted search broaden far past an exact/substring name match;
--   - every business was returned regardless of whether the CALLER's own
--     held permission could actually act on it (e.g. a BILLING caller,
--     who only ever holds platform.subscriptions.extend_trial, saw
--     businesses with no TRIALING subscription at all — rows
--     platform_extend_trial would unconditionally reject).
-- This is a genuine least-privilege problem given BILLING deliberately
-- does NOT hold platform.businesses.view (20261001080000/20261002080000's
-- own header) — the lookup must not become a de facto substitute for that
-- permission.
--
-- This migration is intentionally a FORWARD fix, not an in-place edit of
-- 20261002080000: that migration is already applied to local migration
-- history (`supabase status` shows a running local stack), so per
-- forward-migration discipline it is treated as applied/frozen rather than
-- edited retroactively.
--
-- get_platform_business_action_context is NOT touched here — it takes a
-- single p_business_id and returns at most one row; it was never an
-- enumerable browsing surface and has no search/pagination parameters to
-- minimize.
--
-- ═══════════════════════════════════════════════════════════════════════
-- SECTION 1 — private.escape_ilike_pattern: escapes %, _, and the escape
-- character \ itself, so a caller-supplied search term is always matched
-- LITERALLY. Declared once so both the search-bounds and the ILIKE clause
-- below stay in lockstep; only this migration's own RPC calls it.
-- ═══════════════════════════════════════════════════════════════════════
create or replace function private.escape_ilike_pattern(p_text text)
returns text
language sql
immutable
set search_path = ''
as $$
  select replace(replace(replace(p_text, '\', '\\'), '%', '\%'), '_', '\_');
$$;

revoke all on function private.escape_ilike_pattern(text) from public, anon, authenticated;
grant execute on function private.escape_ilike_pattern(text) to private_platform_action_writer;

-- ═══════════════════════════════════════════════════════════════════════
-- SECTION 2 — list_platform_action_eligible_businesses, hardened.
--
-- Behavioral changes from 20261002080000:
--   1. Search is now MANDATORY. Missing, empty, or whitespace-only search
--      returns zero rows (fail closed) rather than "all businesses" — no
--      exception, since an empty search box is a normal, expected UI
--      state, not a caller error.
--   2. A non-blank search below the 3-character minimum is a validation
--      error (INVALID_SEARCH), matching this RPC's own established style
--      for out-of-bounds input (the existing >200-character check).
--      3 characters is used (rather than 1) because it materially reduces
--      single/double-character enumeration sweeps across the directory.
--   3. The search term is escaped via private.escape_ilike_pattern and the
--      ILIKE clause carries an explicit ESCAPE '\' — literal `%`, `_`, and
--      `\` in a business name now match literally, never as wildcards.
--   4. Rows are filtered to ONLY businesses actionable by a permission the
--      caller actually holds: suspend/reactivate require the business to
--      be non-archived (the exact gate platform_suspend_business/
--      platform_reactivate_business themselves enforce); extend_trial
--      requires an active TRIALING subscription (the exact gate
--      platform_extend_trial itself enforces). A caller who holds only
--      extend_trial (BILLING) never sees a non-TRIALING business here,
--      even if its name matches; the lookup's eligibility predicate is a
--      literal restatement of each mutation's own state check, so the
--      lookup can never claim "eligible" for a row a mutation would
--      reject.
--   5. Max page size lowered from 100 to 50 — this is a targeted lookup,
--      not a paged directory; there is no legitimate need for a wider
--      page on a search-only surface. Default remains the caller-supplied
--      value (callers already pass an explicit page size).
-- ═══════════════════════════════════════════════════════════════════════
create or replace function public.list_platform_action_eligible_businesses(
  p_search    text default null,
  p_page      integer default 1,
  p_page_size integer default 25
)
returns table (
  business_id          uuid,
  business_name        text,
  business_status      text,
  subscription_status  text,
  trial_ends_at        timestamptz,
  total_count          bigint
)
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_search        text;
  v_escaped       text;
  v_page          integer;
  v_page_size     integer;
  v_offset        integer;
  v_can_suspend   boolean;
  v_can_reactivate boolean;
  v_can_extend    boolean;
begin
  if private.current_uid() is null then
    raise exception 'authentication required' using errcode = '28000';
  end if;

  v_can_suspend    := private.has_platform_permission('platform.businesses.suspend');
  v_can_reactivate := private.has_platform_permission('platform.businesses.reactivate');
  v_can_extend     := private.has_platform_permission('platform.subscriptions.extend_trial');

  if not (v_can_suspend or v_can_reactivate or v_can_extend) then
    raise exception 'insufficient_privilege' using errcode = '42501';
  end if;

  -- Blank/missing search: fail closed with zero rows, never "all
  -- businesses". This is a normal UI state (empty search box), not caller
  -- error, so no exception is raised.
  v_search := nullif(btrim(coalesce(p_search, '')), '');
  if v_search is null then
    return;
  end if;
  if length(v_search) < 3 then
    raise exception 'INVALID_SEARCH' using errcode = '22023';
  end if;
  if length(v_search) > 200 then
    raise exception 'INVALID_SEARCH' using errcode = '22023';
  end if;

  v_escaped := private.escape_ilike_pattern(v_search);

  v_page := coalesce(p_page, 1);
  if v_page < 1 then
    raise exception 'INVALID_PAGE' using errcode = '22023';
  end if;
  v_page_size := coalesce(p_page_size, 25);
  if v_page_size < 1 or v_page_size > 50 then
    raise exception 'INVALID_PAGE_SIZE' using errcode = '22023';
  end if;
  v_offset := (v_page - 1) * v_page_size;

  return query
  with base as (
    select b.id as business_id, b.name as business_name, b.status as business_status,
           bs.status as subscription_status, bs.trial_ends_at
    from public.businesses b
    left join public.business_subscriptions bs on bs.business_id = b.id
    where b.name ilike '%' || v_escaped || '%' escape '\'
      and (
        ((v_can_suspend or v_can_reactivate) and b.status <> 'archived')
        or (v_can_extend and bs.status = 'TRIALING')
      )
  ),
  counted as (
    select base.*, count(*) over () as total_count from base
  )
  select counted.business_id, counted.business_name, counted.business_status,
         counted.subscription_status, counted.trial_ends_at, counted.total_count
  from counted
  order by counted.business_name asc, counted.business_id asc
  limit v_page_size
  offset v_offset;
end;
$$;

-- CREATE OR REPLACE on an already-owned, already-granted function
-- preserves ownership and existing grants (they attach to the function
-- object, not its body) — no re-grant/re-revoke needed, mirroring
-- 20261001080000's own "has_permission/is_business_member" precedent for
-- in-place hardening of an existing function signature.
