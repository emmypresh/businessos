-- Phase 1K: per-user notification targeting and presentation state.
--
-- One row per (notification, recipient user) — see the previous
-- migration's header comment for why this is a separate table rather
-- than folded into notifications itself. This table is the ONLY place a
-- specific user's read/unread and seen/unseen state for a specific
-- notification lives; notifications.* itself carries no per-user state
-- of any kind.
--
-- RECIPIENT IDENTITY IS SERVER-AUTHORITATIVE: every row here is created
-- exclusively by private.create_notification (next migration), from a
-- recipient list that function itself validates against LIVE, active
-- business_members rows — never from a client-supplied claim. There is
-- no INSERT policy or INSERT grant for `authenticated` on this table at
-- all; an authenticated user cannot create a recipient row for
-- themselves OR for anyone else, under any circumstance.

create table public.notification_recipients (
  id              uuid primary key default gen_random_uuid(),
  notification_id uuid not null,
  -- Denormalized copy of notifications.business_id — "if helpful for
  -- RLS/indexing" per this phase's own ARCHITECTURE section: without it,
  -- both the SELECT policy below and every feed/unread-count query would
  -- need to join back to notifications just to know which business a
  -- row belongs to. Kept consistent with the parent via the composite FK
  -- below, exactly like every other Phase 1C-1J child table's identical
  -- denormalized tenant key.
  business_id     uuid not null,
  user_id         uuid not null references auth.users (id),
  -- READ/UNREAD: null = unread. Client-settable (see the UPDATE policy
  -- and column grant below) — this is ordinary presentation state, not a
  -- security-relevant fact, so allowing a user to set OR clear their own
  -- read_at (mark read, then mark unread again) is safe and matches
  -- normal inbox UX; no monotonicity is enforced.
  read_at         timestamptz,
  -- SEEN/UNSEEN — justified as a genuinely distinct concept from
  -- read_at: "seen" answers "has this at least been rendered somewhere
  -- the user looked" (e.g. a notification bell/dropdown was opened),
  -- which is what a future unseen-count BADGE should be driven by,
  -- while "read" answers the stronger "the user explicitly opened/
  -- dismissed this specific item" — a user may glance at a dropdown
  -- (seen becomes non-null for everything currently listed) without
  -- having individually read every item in it. Both are independent,
  -- client-settable timestamps; neither implies the other structurally.
  seen_at         timestamptz,
  created_at      timestamptz not null default now(),

  -- A user can never be targeted twice by the same notification — the
  -- writer's own ON CONFLICT DO NOTHING (next migration) relies on this
  -- exact constraint to make recipient fan-out itself idempotent,
  -- independent of the notification-level dedup_key mechanism.
  unique (notification_id, user_id),

  -- Tenant-consistent composite FK: notification_id must resolve to a
  -- notifications row in THIS SAME business_id — a cross-tenant
  -- recipient row (a notification from business A with a recipient row
  -- claiming business B) is structurally unrepresentable, not merely
  -- RPC-checked. ON DELETE CASCADE here is a DIFFERENT relationship than
  -- notifications.business_id's own RESTRICT: a recipient row has no
  -- independent historical meaning once its OWN parent notification is
  -- gone (there is no code path that deletes a notification today, and
  -- none is added by this round, but if one ever exists, an orphaned
  -- recipient row referencing a nonexistent notification would be
  -- meaningless, unlike a whole BUSINESS's notification history being
  -- silently erased by an unrelated cascade, which is what
  -- notifications.business_id's own RESTRICT specifically guards
  -- against).
  foreign key (notification_id, business_id)
    references public.notifications (id, business_id)
    on delete cascade
);

-- INDEXING — "user's unread feed" and "user's chronological feed",
-- scoped per-business (every notification-consuming surface in this app
-- is business-scoped, matching the `/[businessId]/...` routing
-- convention throughout). The unique (notification_id, user_id)
-- constraint above already serves "all recipients of a given
-- notification" lookups (notification_id leads it), so no separate
-- index is added solely for that.
create index notification_recipients_user_feed_idx
  on public.notification_recipients (user_id, business_id, created_at desc, notification_id desc);
create index notification_recipients_user_unread_idx
  on public.notification_recipients (user_id, business_id, created_at desc)
  where read_at is null;

-- Row Level Security ---------------------------------------------------
--
-- "A user may only read notifications addressed to that user" +
-- "may only mutate the allowed presentation state of their own recipient
-- record" (this phase's own RECIPIENTS section) — both re-derive CURRENT
-- active membership on every access, never trusting the recipient row's
-- own mere existence as sufficient (a user removed or suspended from a
-- business afterward loses visibility into that business's notification
-- feed immediately, exactly like every other Phase 1F-1J
-- access-control decision in this schema re-derives from live state
-- rather than a historical/immutable snapshot).

alter table public.notification_recipients enable row level security;
alter table public.notification_recipients force row level security;

create policy notification_recipients_select on public.notification_recipients
  for select
  to authenticated
  using (
    user_id = (select auth.uid())
    and private.is_business_member(business_id)
  );

-- UPDATE: USING governs which rows may be targeted, WITH CHECK governs
-- what the row may become — both required (see businesses_update's own
-- identical two-clause pattern in 20260825202828_business_membership_
-- policies.sql), otherwise a client could satisfy USING once and then
-- write a new state that no longer would. notification_id, business_id,
-- and user_id are excluded from the column grant below, so no UPDATE
-- statement naming any of them can even reach RLS evaluation at all —
-- the column-level grant is the PRIMARY defense (fails the whole
-- statement before RLS or triggers ever run), the RLS clauses are
-- defense-in-depth on top of it, mirroring this codebase's established
-- belt-and-suspenders convention for every other client-writable column
-- set (e.g. businesses_update excluding created_by).
create policy notification_recipients_update on public.notification_recipients
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

-- No INSERT policy (recipient rows are writer-only — see
-- private.create_notification) and no DELETE policy (append-oriented:
-- "dismissing" a notification is a future presentation-state concept,
-- not a deletion, so historical delivery is never lost to a user's own
-- action — deliberately deferred to the Phase 1K application layer, not
-- built here).

revoke all on public.notification_recipients from public, anon, authenticated, service_role;
grant select (
  id, notification_id, business_id, user_id, read_at, seen_at, created_at
) on public.notification_recipients to authenticated, service_role;
-- Column-restricted UPDATE grant to `authenticated` ONLY — read_at and
-- seen_at are the only columns any UPDATE statement may name; every
-- other column (notification ownership/target/business_id/notification_id/
-- user_id) is therefore structurally immutable to a client, regardless
-- of RLS. Deliberately NOT granted to `service_role`: no legitimate
-- internal/admin tool needs to mark another user's notification as read
-- on their behalf in this phase — mirrors businesses_update's own
-- identical choice to grant UPDATE to `authenticated` only.
grant update (read_at, seen_at) on public.notification_recipients to authenticated;
revoke references, trigger, truncate on public.notification_recipients from anon, authenticated;

-- notifications_select (deferred from 20260903080000_create_notifications.sql)
-- ---------------------------------------------------------------------
--
-- Lives here, not in the notifications migration itself, purely because
-- it must reference this table, which did not exist yet at that point
-- in the migration sequence — see that migration's own note at the same
-- location. Functionally, this is notifications' own read policy: a
-- notification is visible to a caller who is BOTH (a) a recipient of it
-- (a row exists for them right here in notification_recipients) and (b)
-- a currently active member of the business it belongs to — see that
-- migration's fuller "READ MODEL" comment for the complete rationale.
create policy notifications_select on public.notifications
  for select
  to authenticated
  using (
    private.is_business_member(business_id)
    and exists (
      select 1 from public.notification_recipients nr
      where nr.notification_id = notifications.id
        and nr.user_id = (select auth.uid())
    )
  );
