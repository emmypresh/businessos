-- Final RLS policies for businesses and business_members, now that the
-- private.is_business_member / private.has_permission helpers exist.
-- Until this migration, both tables were fail-closed for `authenticated`
-- entirely — there has never been a businesses INSERT policy for
-- `authenticated` (see create_businesses.sql and create_business_rpc.sql
-- for why business creation is routed through public.create_business
-- instead, running under its own dedicated role).

-- Membership-based only. created_by is deliberately NOT an alternative
-- here, even though it looks convenient for a business's creator: created_by
-- never changes after insert (protected by its own trigger), so if the
-- creator is later removed from business_members — ownership transferred,
-- or they're removed outright — a created_by-based clause would still
-- match and let them go on reading a tenant they no longer belong to,
-- forever. business_members is the only thing allowed to represent
-- "currently has access"; created_by only ever meant "history: who made
-- this," and history must never double as an access grant.
create policy businesses_select on public.businesses
  for select
  to authenticated
  using (private.is_business_member(id));

-- UPDATE policies need both USING (which rows may be targeted) and WITH
-- CHECK (what the row may become) — without WITH CHECK, `authenticated`
-- could turn a business they're allowed to update into one that no longer
-- satisfies USING, or (more to the point here) the check would silently
-- not re-run permission on the new state at all.
create policy businesses_update on public.businesses
  for update
  to authenticated
  using (private.has_permission(id, 'business.manage'))
  with check (private.has_permission(id, 'business.manage'));

create policy businesses_delete on public.businesses
  for delete
  to authenticated
  using (private.has_permission(id, 'business.delete'));

-- Matching GRANTs for the policies just added (see create_businesses.sql
-- for why GRANT is needed at all). UPDATE is column-restricted to exclude
-- created_by — belt and suspenders alongside the immutability trigger,
-- since a GRANT-level restriction fails the statement before RLS or
-- triggers are even reached.
grant select, delete on public.businesses to authenticated;
grant update (name, slug, status) on public.businesses to authenticated;

-- A member sees their own membership row, and every membership row of any
-- business they actively belong to (so the app can render a member
-- roster). No INSERT/UPDATE/DELETE policy is added for `authenticated` —
-- see the create_business_members migration for why membership writes are
-- deliberately left to SECURITY DEFINER triggers/functions only.
create policy business_members_select on public.business_members
  for select
  to authenticated
  using (
    user_id = (select auth.uid())
    or private.is_business_member(business_id)
  );
