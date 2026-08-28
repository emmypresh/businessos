-- Phase 1F: business invitations.
--
-- All writes are RPC-only (business_invitation_rpcs.sql, next migration)
-- — no INSERT/UPDATE/DELETE policy for `authenticated` exists on either
-- table, ever. Listing/management requires staff.invite; acceptance works
-- through public.accept_business_invitation (a SECURITY DEFINER function
-- that does not depend on the invitee holding staff.invite or any SELECT
-- policy on this table at all) — see that function's own header comment.

create table public.business_invitations (
  id           uuid primary key default gen_random_uuid(),
  business_id  uuid not null references public.businesses (id) on delete cascade,
  -- Always stored trim+lowercase-normalized by the RPC that writes it —
  -- never provider-specific (Gmail dot/plus) normalization, matching the
  -- approved plan exactly.
  email        text not null
                 check (email ~* '^[^@[:space:]]+@[^@[:space:]]+\.[^@[:space:]]+$'),
  role_id      uuid not null references public.roles (id),
  status       text not null default 'PENDING'
                 check (status in ('PENDING', 'ACCEPTED', 'REVOKED', 'EXPIRED')),
  expires_at   timestamptz not null,
  invited_by   uuid not null references auth.users (id),
  accepted_by  uuid references auth.users (id),
  accepted_at  timestamptz,
  revoked_by   uuid references auth.users (id),
  revoked_at   timestamptz,
  -- Traceability only — NOT the idempotency arbiter
  -- (private.business_invitation_requests is), matching every other
  -- Phase 1D/1E creation_key column's own treatment exactly.
  creation_key uuid not null,
  created_at   timestamptz not null default now(),
  updated_at   timestamptz not null default now(),

  -- Codex adversarial review, Finding 5: the ORIGINAL version of this
  -- constraint set used two separate biconditionals — `(status =
  -- 'ACCEPTED') = (accepted_by is not null and accepted_at is not
  -- null)` and the equivalent for REVOKED — each of which correctly
  -- pins BOTH fields together for its OWN status, but for every OTHER
  -- status only proved "not BOTH set" (a disjunction: accepted_by null
  -- OR accepted_at null), not "BOTH null". That let a REVOKED row store
  -- a non-null accepted_by with a null accepted_at (or vice versa) — a
  -- structurally mixed, invalid audit state. Rewritten as one
  -- exhaustive, mutually exclusive check that pins ALL FOUR
  -- accepted_by/accepted_at/revoked_by/revoked_at fields for EVERY one
  -- of the four statuses explicitly — there is no status value, and no
  -- combination of the four fields, left unconstrained by this.
  check (
    (status = 'PENDING'
      and accepted_by is null and accepted_at is null
      and revoked_by is null and revoked_at is null)
    or (status = 'ACCEPTED'
      and accepted_by is not null and accepted_at is not null
      and revoked_by is null and revoked_at is null)
    or (status = 'REVOKED'
      and accepted_by is null and accepted_at is null
      and revoked_by is not null and revoked_at is not null)
    or (status = 'EXPIRED'
      and accepted_by is null and accepted_at is null
      and revoked_by is null and revoked_at is null)
  ),

  unique (id, business_id)
);

-- Only one EFFECTIVE pending invitation per business + normalized email —
-- a partial unique index scoped to status = 'PENDING' specifically, so an
-- EXPIRED or REVOKED row never blocks a fresh invitation to the same
-- address. See public.create_business_invitation's own comment for how
-- EXPIRED is materialized (lazily, opportunistically, inside that RPC and
-- the accept RPC — never a cron job).
create unique index business_invitations_pending_email_idx
  on public.business_invitations (business_id, email)
  where status = 'PENDING';

create index business_invitations_business_status_idx
  on public.business_invitations (business_id, status);

create trigger business_invitations_set_updated_at
  before update on public.business_invitations
  for each row
  execute function private.set_updated_at();

create table public.business_invitation_branches (
  id            uuid primary key default gen_random_uuid(),
  business_id   uuid not null references public.businesses (id) on delete cascade,
  invitation_id uuid not null,
  branch_id     uuid not null,
  is_primary    boolean not null default false,

  unique (invitation_id, branch_id),

  -- Same tenant-consistent composite-FK technique as business_member_branches
  -- — a cross-tenant invitation/branch pairing is structurally
  -- unrepresentable.
  foreign key (invitation_id, business_id)
    references public.business_invitations (id, business_id)
    on delete cascade,
  foreign key (branch_id, business_id)
    references public.business_branches (id, business_id)
    on delete no action deferrable initially deferred
);

create unique index business_invitation_branches_one_primary_idx
  on public.business_invitation_branches (invitation_id)
  where is_primary = true;

create index business_invitation_branches_business_idx
  on public.business_invitation_branches (business_id);

-- Row Level Security ---------------------------------------------------

alter table public.business_invitations enable row level security;
alter table public.business_invitations force row level security;
alter table public.business_invitation_branches enable row level security;
alter table public.business_invitation_branches force row level security;

-- staff.invite ONLY — deliberately NOT plain membership, unlike
-- business_members/business_member_branches' own broad "any active
-- member" visibility. Invitation email addresses are not general roster
-- data; every business member does not need to see who has been invited
-- and to what address. Neither `anon` nor an authenticated user without
-- staff.invite can enumerate invitations for any business, including
-- their own — the accept flow does not depend on this policy at all (see
-- accept_business_invitation's own header comment).
create policy business_invitations_select on public.business_invitations
  for select
  to authenticated
  using (private.has_permission(business_id, 'staff.invite'));

create policy business_invitation_branches_select on public.business_invitation_branches
  for select
  to authenticated
  using (private.has_permission(business_id, 'staff.invite'));

-- No INSERT/UPDATE/DELETE policy for `authenticated`, ever — fully
-- RPC-only (business_invitation_rpcs.sql).

revoke all on public.business_invitations from public, anon, authenticated, service_role;
revoke all on public.business_invitation_branches from public, anon, authenticated, service_role;

-- creation_key deliberately excluded — internal mutation-control
-- metadata, matching every other creation_key column's own SELECT-grant
-- exclusion.
grant select (
  id, business_id, email, role_id, status, expires_at, invited_by,
  accepted_by, accepted_at, revoked_by, revoked_at, created_at, updated_at
) on public.business_invitations to authenticated, service_role;

grant select (
  id, business_id, invitation_id, branch_id, is_primary
) on public.business_invitation_branches to authenticated, service_role;

revoke references, trigger, truncate
  on public.business_invitations, public.business_invitation_branches
  from anon, authenticated;
