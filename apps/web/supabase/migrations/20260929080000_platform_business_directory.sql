-- Phase 1O-B — read-only internal business directory & search.
--
-- Adds exactly two new RPCs for platform staff: public.list_platform_businesses
-- (paginated/searchable/filterable/sortable directory) and
-- public.get_platform_business_detail (single-business read-only summary).
-- Both are SECURITY DEFINER, owned by a new, narrowly-privileged role
-- (private_platform_directory_reader), and both independently re-verify
-- platform.businesses.view + AAL2 via private.has_platform_permission
-- (20260928090000_platform_admin_require_aal2.sql) — the same DB-layer
-- defense-in-depth precedent every existing platform RPC in 1O-A already
-- establishes. Neither function mutates anything; this migration creates
-- no INSERT/UPDATE/DELETE policy or RPC anywhere.
--
-- OWNER EMAIL: per 20260828080700_business_invitation_rpcs.sql's own
-- explicit design note, auth.users is readable directly by exactly one
-- function in this schema (private.current_verified_email, owned by
-- `postgres`, since `postgres` holds USAGE on the auth schema WITHOUT
-- GRANT OPTION and cannot extend that access to any new role). This
-- migration adds a SECOND such function, private.get_business_owner_email
-- — also deliberately left owned by `postgres` for the identical reason —
-- rather than granting the new narrow reader role any access to
-- auth.users at all. It is called only per already-paginated row (at most
-- p_page_size, bounded to 100), never once per business in the full
-- unfiltered table, so the directory query remains a single bounded pass
-- with no N+1 pattern against auth.users or any other table.
--
-- OWNER DEFINITION: the business_members row with role name = 'OWNER' and
-- status = 'active', earliest by created_at, for a given business_id. A
-- business is expected to have exactly one such row (owner_membership_and_
-- last_owner_protection.sql enforces "every business has at least one
-- OWNER" but does not itself prevent a role reassignment RPC from
-- producing more than one active OWNER in the future); "earliest active
-- OWNER" is the deterministic tie-breaker if that ever happens.
--
-- BRANCH COUNT: both ACTIVE and total counts are returned
-- (branch_count = all branches regardless of status, active_branch_count
-- = status = 'ACTIVE' only) — cheap to compute together from the same
-- aggregate pass, so both are exposed rather than picking one.
--
-- MEMBER COUNT: active memberships only (business_members.status =
-- 'active') — the operationally useful "how many people currently work
-- here" number, not a historical total including invited/suspended/
-- removed rows.

-- ---------------------------------------------------------------------
-- 1. Narrow reader role, mirroring private_management_reports_reader's
--    exact shape (noinherit nologin bypassrls + explicit, narrow,
--    column-level SELECT grants — never a blanket table grant).
-- ---------------------------------------------------------------------
do $$
begin
  if not exists (select 1 from pg_catalog.pg_roles where rolname = 'private_platform_directory_reader') then
    create role private_platform_directory_reader noinherit nologin bypassrls;
  end if;
end
$$;

grant private_platform_directory_reader to postgres;
grant usage on schema public, private to private_platform_directory_reader;

grant select (id, name, slug, status, country_code, currency_code, timezone, created_at)
  on public.businesses to private_platform_directory_reader;
grant select (id, business_id, user_id, role_id, status, created_at)
  on public.business_members to private_platform_directory_reader;
grant select (id, name) on public.roles to private_platform_directory_reader;
grant select (id, business_id, name, code, status, created_at)
  on public.business_branches to private_platform_directory_reader;
grant select (
  business_id, plan_id, status, trial_ends_at, current_period_ends_at, cancel_at_period_end
) on public.business_subscriptions to private_platform_directory_reader;
grant select (id, code, name) on public.subscription_plans to private_platform_directory_reader;
grant select (id, business_id, member_id, branch_id, is_primary)
  on public.business_member_branches to private_platform_directory_reader;

grant execute on function private.current_uid() to private_platform_directory_reader;
grant execute on function private.has_platform_permission(text) to private_platform_directory_reader;

-- ---------------------------------------------------------------------
-- 2. Owner-email lookup — the one new place auth.users is read from,
--    owned by `postgres` (see header comment above for why).
-- ---------------------------------------------------------------------
create or replace function private.get_business_owner_email(p_business_id uuid)
returns text
language sql
stable
security definer
set search_path = ''
as $$
  select lower(btrim(u.email))
  from public.business_members bm
  join public.roles r on r.id = bm.role_id
  join auth.users u on u.id = bm.user_id
  where bm.business_id = p_business_id
    and r.name = 'OWNER'
    and bm.status = 'active'
  order by bm.created_at asc
  limit 1;
$$;

revoke all on function private.get_business_owner_email(uuid) from public, anon, authenticated;
grant execute on function private.get_business_owner_email(uuid) to private_platform_directory_reader;

-- Per-member email lookup for the detail page's member summary — scoped
-- to a single business_id (never a bare "look up any user_id" primitive:
-- the join is always through business_members, so this can only ever
-- return emails for actual members of the requested business, never an
-- arbitrary auth.users row). Also owned by `postgres`, for the identical
-- reason as private.get_business_owner_email above.
create or replace function private.get_business_member_emails(p_business_id uuid)
returns table (member_id uuid, email text)
language sql
stable
security definer
set search_path = ''
as $$
  select bm.id, lower(btrim(u.email))
  from public.business_members bm
  join auth.users u on u.id = bm.user_id
  where bm.business_id = p_business_id;
$$;

revoke all on function private.get_business_member_emails(uuid) from public, anon, authenticated;
grant execute on function private.get_business_member_emails(uuid) to private_platform_directory_reader;

-- ---------------------------------------------------------------------
-- 3. list_platform_businesses — paginated/searchable/filterable/sortable
--    directory. Returns rows already carrying total_count (a window
--    function over the FILTERED-but-unpaginated set) so the client never
--    issues a second, separate, unbounded count query.
-- ---------------------------------------------------------------------
create or replace function public.list_platform_businesses(
  p_search              text default null,
  p_country_code        text default null,
  p_currency_code       text default null,
  p_plan_code           text default null,
  p_subscription_status text default null,
  p_sort                text default 'created_at',
  p_dir                 text default 'desc',
  p_page                integer default 1,
  p_page_size           integer default 25
)
returns table (
  business_id           uuid,
  business_name         text,
  slug                  text,
  status                text,
  country_code          text,
  currency_code         text,
  timezone              text,
  created_at            timestamptz,
  owner_email           text,
  plan_code             text,
  plan_name             text,
  subscription_status   text,
  trial_ends_at         timestamptz,
  current_period_ends_at timestamptz,
  cancel_at_period_end  boolean,
  branch_count          bigint,
  active_branch_count   bigint,
  member_count          bigint,
  total_count           bigint
)
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_search     text;
  v_sort       text;
  v_dir        text;
  v_page       integer;
  v_page_size  integer;
  v_offset     integer;
begin
  if private.current_uid() is null then
    raise exception 'authentication required' using errcode = '28000';
  end if;
  if not private.has_platform_permission('platform.businesses.view') then
    raise exception 'insufficient_privilege' using errcode = '42501';
  end if;

  -- Bounds ---------------------------------------------------------------
  if p_search is not null and length(p_search) > 200 then
    raise exception 'INVALID_SEARCH' using errcode = '22023';
  end if;
  v_search := nullif(btrim(p_search), '');

  if p_country_code is not null and p_country_code !~ '^[A-Z]{2}$' then
    raise exception 'INVALID_COUNTRY_CODE' using errcode = '22023';
  end if;
  if p_currency_code is not null and p_currency_code !~ '^[A-Z]{3}$' then
    raise exception 'INVALID_CURRENCY_CODE' using errcode = '22023';
  end if;
  if p_plan_code is not null and p_plan_code not in ('STARTER', 'GROWTH', 'BUSINESS', 'ENTERPRISE') then
    raise exception 'INVALID_PLAN_CODE' using errcode = '22023';
  end if;
  if p_subscription_status is not null
     and p_subscription_status not in ('TRIALING', 'ACTIVE', 'PAST_DUE', 'CANCELED', 'EXPIRED', 'INCOMPLETE') then
    raise exception 'INVALID_SUBSCRIPTION_STATUS' using errcode = '22023';
  end if;

  v_sort := coalesce(p_sort, 'created_at');
  if v_sort not in ('name', 'created_at', 'member_count', 'branch_count') then
    raise exception 'INVALID_SORT' using errcode = '22023';
  end if;
  v_dir := lower(coalesce(p_dir, 'desc'));
  if v_dir not in ('asc', 'desc') then
    raise exception 'INVALID_SORT_DIRECTION' using errcode = '22023';
  end if;

  v_page := coalesce(p_page, 1);
  if v_page < 1 then
    raise exception 'INVALID_PAGE' using errcode = '22023';
  end if;
  v_page_size := coalesce(p_page_size, 25);
  if v_page_size < 1 or v_page_size > 100 then
    raise exception 'INVALID_PAGE_SIZE' using errcode = '22023';
  end if;
  v_offset := (v_page - 1) * v_page_size;

  return query
  with filtered as (
    select
      b.id, b.name, b.slug, b.status, b.country_code, b.currency_code, b.timezone, b.created_at,
      sp.code as plan_code, sp.name as plan_name, bs.status as subscription_status,
      bs.trial_ends_at, bs.current_period_ends_at, bs.cancel_at_period_end,
      coalesce(br.branch_count, 0) as branch_count,
      coalesce(br.active_branch_count, 0) as active_branch_count,
      coalesce(mb.member_count, 0) as member_count
    from public.businesses b
    left join public.business_subscriptions bs on bs.business_id = b.id
    left join public.subscription_plans sp on sp.id = bs.plan_id
    left join (
      select bb.business_id, count(*) as branch_count,
             count(*) filter (where bb.status = 'ACTIVE') as active_branch_count
      from public.business_branches bb
      group by bb.business_id
    ) br on br.business_id = b.id
    left join (
      select bm.business_id, count(*) as member_count
      from public.business_members bm
      where bm.status = 'active'
      group by bm.business_id
    ) mb on mb.business_id = b.id
    where
      (
        v_search is null
        -- % and _ are treated as LITERAL characters, never wildcards, in
        -- caller-supplied search text (escaped via ESCAPE '\') — the only
        -- wildcards this query itself introduces are the leading/trailing
        -- '%' it adds for a plain substring match.
        or b.name ilike ('%' || replace(replace(v_search, '%', '\%'), '_', '\_') || '%') escape '\'
        or b.slug ilike ('%' || replace(replace(v_search, '%', '\%'), '_', '\_') || '%') escape '\'
      )
      and (p_country_code is null or b.country_code = p_country_code)
      and (p_currency_code is null or b.currency_code = p_currency_code)
      and (p_plan_code is null or sp.code = p_plan_code)
      and (p_subscription_status is null or bs.status = p_subscription_status)
  ),
  counted as (
    select filtered.*, count(*) over () as total_count
    from filtered
  ),
  paged as (
    select *
    from counted
    order by
      case when v_sort = 'name' and v_dir = 'asc' then counted.name end asc,
      case when v_sort = 'name' and v_dir = 'desc' then counted.name end desc,
      case when v_sort = 'created_at' and v_dir = 'asc' then counted.created_at end asc,
      case when v_sort = 'created_at' and v_dir = 'desc' then counted.created_at end desc,
      case when v_sort = 'member_count' and v_dir = 'asc' then counted.member_count end asc,
      case when v_sort = 'member_count' and v_dir = 'desc' then counted.member_count end desc,
      case when v_sort = 'branch_count' and v_dir = 'asc' then counted.branch_count end asc,
      case when v_sort = 'branch_count' and v_dir = 'desc' then counted.branch_count end desc,
      -- Stable deterministic tie-breaker, always applied last.
      counted.id asc
    limit v_page_size
    offset v_offset
  )
  select
    paged.id, paged.name, paged.slug, paged.status, paged.country_code, paged.currency_code,
    paged.timezone, paged.created_at,
    private.get_business_owner_email(paged.id),
    paged.plan_code, paged.plan_name, paged.subscription_status,
    paged.trial_ends_at, paged.current_period_ends_at, paged.cancel_at_period_end,
    paged.branch_count, paged.active_branch_count, paged.member_count, paged.total_count
  from paged;
end;
$$;

grant create on schema public to private_platform_directory_reader;
alter function public.list_platform_businesses(text, text, text, text, text, text, text, integer, integer)
  owner to private_platform_directory_reader;
revoke create on schema public from private_platform_directory_reader;

revoke all on function public.list_platform_businesses(text, text, text, text, text, text, text, integer, integer)
  from public, anon;
grant execute on function public.list_platform_businesses(text, text, text, text, text, text, text, integer, integer)
  to authenticated;

-- ---------------------------------------------------------------------
-- 4. get_platform_business_detail — single-business read-only summary.
--    Returns null (never a partial row or a raw error) when the id does
--    not exist; the calling route layer maps both "not found" and
--    "found but caller lacks access" to the same 404, per the phase's
--    own no-enumeration convention (the permission check above already
--    denies before this point is ever reached for an unauthorized
--    caller, so this null branch is purely the "no such business" case).
-- ---------------------------------------------------------------------
create or replace function public.get_platform_business_detail(p_business_id uuid)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_result jsonb;
begin
  if private.current_uid() is null then
    raise exception 'authentication required' using errcode = '28000';
  end if;
  if not private.has_platform_permission('platform.businesses.view') then
    raise exception 'insufficient_privilege' using errcode = '42501';
  end if;
  if p_business_id is null then
    raise exception 'INVALID_BUSINESS_ID' using errcode = '22023';
  end if;

  select jsonb_build_object(
    'business_id', b.id,
    'business_name', b.name,
    'slug', b.slug,
    'status', b.status,
    'country_code', b.country_code,
    'currency_code', b.currency_code,
    'timezone', b.timezone,
    'created_at', b.created_at,
    'owner_email', private.get_business_owner_email(b.id),
    'subscription', (
      select jsonb_build_object(
        'plan_code', sp.code,
        'plan_name', sp.name,
        'status', bs.status,
        'trial_ends_at', bs.trial_ends_at,
        'current_period_ends_at', bs.current_period_ends_at,
        'cancel_at_period_end', bs.cancel_at_period_end
      )
      from public.business_subscriptions bs
      join public.subscription_plans sp on sp.id = bs.plan_id
      where bs.business_id = b.id
    ),
    'branch_count', (select count(*) from public.business_branches where business_id = b.id),
    'active_branch_count', (
      select count(*) from public.business_branches where business_id = b.id and status = 'ACTIVE'
    ),
    'member_count', (
      select count(*) from public.business_members where business_id = b.id and status = 'active'
    ),
    'branches', (
      select coalesce(jsonb_agg(jsonb_build_object(
        'branch_id', br.id, 'name', br.name, 'code', br.code,
        'status', br.status, 'created_at', br.created_at
      ) order by br.created_at asc), '[]'::jsonb)
      from public.business_branches br
      where br.business_id = b.id
    ),
    'members', (
      select coalesce(jsonb_agg(jsonb_build_object(
        'email', me.email,
        'role', r.name, 'status', bm.status,
        'primary_branch_name', bmb.branch_name
      ) order by bm.created_at asc), '[]'::jsonb)
      from public.business_members bm
      join public.roles r on r.id = bm.role_id
      left join private.get_business_member_emails(b.id) me on me.member_id = bm.id
      left join lateral (
        select bb.name as branch_name
        from public.business_member_branches mbr
        join public.business_branches bb on bb.id = mbr.branch_id
        where mbr.member_id = bm.id and mbr.is_primary = true
        limit 1
      ) bmb on true
      where bm.business_id = b.id
    )
  )
  into v_result
  from public.businesses b
  where b.id = p_business_id;

  return v_result;
end;
$$;

grant create on schema public to private_platform_directory_reader;
alter function public.get_platform_business_detail(uuid) owner to private_platform_directory_reader;
revoke create on schema public from private_platform_directory_reader;

revoke all on function public.get_platform_business_detail(uuid) from public, anon;
grant execute on function public.get_platform_business_detail(uuid) to authenticated;

-- ---------------------------------------------------------------------
-- 5. Index review (per phase instructions: reasoned, not blind).
--
-- businesses_created_at_idx: supports the default "newest first" sort
-- and created_at ordering generally. businesses_status_idx already
-- exists (create_businesses.sql). country_code/currency_code filters are
-- expected to run against a low-cardinality, launch-scale (thousands of
-- rows, six countries) table — a sequential scan under those two filters
-- remains cheap even at multi-thousand-row scale, so no dedicated index
-- is added for them in this phase; add one if/when EXPLAIN ANALYZE on a
-- production-sized table shows it is actually needed. Name/slug search
-- uses ILIKE with a leading wildcard (not a trailing-only prefix match),
-- which a plain btree index cannot support either way — a trigram
-- (pg_trgm) index would be the correct future addition if search
-- performance becomes a real problem at scale; not added speculatively
-- here.
-- ---------------------------------------------------------------------
create index if not exists businesses_created_at_idx on public.businesses (created_at desc);
