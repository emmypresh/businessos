-- Phase 1K: per-user, per-business, per-notification-type preferences.
--
-- Orthogonal to notifications/notification_recipients — a preference row
-- is a standing USER SETTING ("do I want to see inventory.low_stock
-- notifications in-app for this business"), not tied to any one
-- notification instance, and is the ONE table in this phase's schema
-- where in-place mutation by the owning user is the primary, expected
-- operation (unlike notifications/notification_recipients' append-
-- oriented posture) — closer in spirit to a settings row than a
-- historical record.
--
-- CHANNEL DESIGN DECISION: a single `in_app_enabled` boolean column,
-- NOT a generic `channel` dimension (e.g. one row per
-- (business_id, user_id, notification_type, channel) with channel
-- constrained to 'IN_APP' today). The channel-dimension design was
-- considered and rejected for this phase: it adds real complexity
-- (multiple rows per logical preference, an aggregate read needed just
-- to answer "is in-app enabled") for zero present benefit, since IN-APP
-- is the only channel this phase builds — email/WhatsApp/SMS/push
-- delivery are explicitly out of scope per this phase's own
-- instructions. The chosen alternative is exactly this codebase's own
-- established pattern for "a feature will exist later, don't build it
-- yet, but don't block it either": add a new column later via a plain
-- additive migration (e.g. `alter table ... add column email_enabled
-- boolean not null default false`) when that channel is actually built
-- — mirrors, for example, how create_sale's own p_branch_id was added as
-- a new, additive, defaulted trailing parameter in a later phase rather
-- than reshaping an existing concept. No destructive migration is ever
-- required to add a channel this way.
--
-- NOTIFICATION_TYPE: same freeform, regex-validated convention as
-- notifications.notification_type (see that migration's header comment)
-- — a preference row's `notification_type` value need not correspond to
-- any type that has ever actually been emitted; an inert, never-matched
-- preference row is harmless. No registry/lookup table of "valid"
-- notification types is introduced, matching this schema's existing
-- avoidance of speculative structure with no concrete present need.

create table public.notification_preferences (
  id                uuid primary key default gen_random_uuid(),
  business_id       uuid not null references public.businesses (id) on delete cascade,
  user_id           uuid not null references auth.users (id) on delete cascade,
  notification_type text not null
                      check (notification_type ~ '^[a-z][a-z0-9_]*(\.[a-z0-9_]+)+$' and length(notification_type) <= 100),
  in_app_enabled    boolean not null default true,
  created_at        timestamptz not null default now(),
  updated_at        timestamptz not null default now(),

  -- One preference row per user per business per notification type —
  -- the writer (a plain RLS-gated upsert, no dedicated RPC needed; see
  -- the RLS section below) relies on this exact constraint for
  -- `on conflict (business_id, user_id, notification_type) do update`.
  unique (business_id, user_id, notification_type)
);

-- Preferences have no independent historical value once their owning
-- business is gone (unlike notifications/audit_events, this is a
-- settings table, not a record of what happened) — CASCADE is the
-- correct, simplest choice here, not a durability defect: there is
-- nothing left to preserve once the business itself is deleted, and no
-- future business-deletion path could ever be blocked by a leftover
-- preference row the way audit_events.business_id's RESTRICT
-- deliberately blocks one on purpose.
create index notification_preferences_user_idx
  on public.notification_preferences (user_id, business_id);

create trigger notification_preferences_set_updated_at
  before update on public.notification_preferences
  for each row
  execute function private.set_updated_at();

-- Row Level Security ---------------------------------------------------
--
-- "Users may only manage their own preferences within businesses where
-- they are legitimate active members. Do not trust client-supplied
-- membership claims." — private.is_business_member re-derives CURRENT
-- active membership from business_members directly on every check; a
-- client cannot satisfy it by merely supplying a business_id it is not
-- really an active member of, exactly like every other RLS policy in
-- this schema built on that helper.
--
-- A plain RLS-gated INSERT/UPDATE (no dedicated RPC) is deliberately
-- chosen here, mirroring businesses_update's own established precedent
-- for a self-service, low-risk, no-cross-table-invariant mutation: the
-- WITH CHECK clause makes `user_id` verified, not merely client-claimed,
-- so there is no meaningful extra safety an RPC wrapper would add for
-- this specific operation — "prefer the simplest secure model," per
-- this phase's own instruction for the related PERMISSIONS decision,
-- applies equally well here.

alter table public.notification_preferences enable row level security;
alter table public.notification_preferences force row level security;

create policy notification_preferences_select on public.notification_preferences
  for select
  to authenticated
  using (
    user_id = (select auth.uid())
    and private.is_business_member(business_id)
  );

create policy notification_preferences_insert on public.notification_preferences
  for insert
  to authenticated
  with check (
    user_id = (select auth.uid())
    and private.is_business_member(business_id)
  );

-- business_id, user_id, and notification_type ARE included in the
-- UPDATE column grant below, alongside in_app_enabled — NOT because
-- changing them is a meaningful operation (it isn't; a preference row's
-- natural identity is fixed at insert), but because PostgREST's own
-- upsert (`INSERT ... ON CONFLICT (business_id, user_id,
-- notification_type) DO UPDATE`) always re-sets every column present in
-- the payload, including the conflict-key columns themselves, even when
-- their values are unchanged — omitting them from the grant would break
-- the standard client-library upsert idiom entirely (discovered live: a
-- `.upsert(...)` from the postgrest-js client failed with "permission
-- denied ... GRANT UPDATE" until this was widened). Real safety here
-- comes from WITH CHECK below, not the column grant: it re-validates
-- `user_id = auth.uid()` and `is_business_member(business_id)` against
-- the NEW row on every UPDATE, including one arriving via upsert's own
-- DO UPDATE branch — so a caller can never retarget a row to another
-- user's id (rejected: new.user_id must equal their own auth.uid()) or
-- to a business they do not actively belong to (rejected: is_business_
-- member re-checked on the new value) — the only "identity change" WITH
-- CHECK actually permits is moving one of the caller's OWN existing
-- preference rows to ANOTHER business they are ALSO an active member
-- of, which affects no one else's data and is not a privilege
-- escalation, only a semantic curiosity this foundation does not need
-- to forbid. updated_at is maintained exclusively by the trigger above
-- and is never included in the grant, so it is never client-settable by
-- any path, upsert included.
create policy notification_preferences_update on public.notification_preferences
  for update
  to authenticated
  using (
    user_id = (select auth.uid())
    and private.is_business_member(business_id)
  )
  with check (
    user_id = (select auth.uid())
    and private.is_business_member(business_id)
  );

-- No DELETE policy: "resetting" a type is expressed by upserting
-- in_app_enabled back to its default (true) rather than removing the
-- row — deliberately simpler to test and reason about than two
-- different code paths (an explicit row vs. an absent one) meaning the
-- same default state.

revoke all on public.notification_preferences from public, anon, authenticated, service_role;
-- INSERT is granted to `authenticated` only, not `service_role` —
-- mirrors notification_recipients' own UPDATE grant reasoning exactly:
-- no legitimate internal/admin tool needs to write a preference row on
-- a user's behalf in this phase. `service_role` retains SELECT for
-- admin/support visibility, matching every other Phase 1C-1J table's
-- identical treatment.
grant select on public.notification_preferences to authenticated, service_role;
grant insert on public.notification_preferences to authenticated;
-- See the UPDATE policy's own comment above for why business_id,
-- user_id, and notification_type are included here (upsert support) and
-- why WITH CHECK, not this grant, is the real safety boundary.
-- updated_at is deliberately excluded — trigger-maintained only.
grant update (business_id, user_id, notification_type, in_app_enabled) on public.notification_preferences to authenticated;
revoke references, trigger, truncate on public.notification_preferences from anon, authenticated;
