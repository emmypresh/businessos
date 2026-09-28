-- Phase 1O-A follow-up — require AAL2 for platform-permission resolution.
--
-- has_platform_permission (private + public) now additionally requires the
-- CURRENT authenticated session to be at AAL2 (a second factor actually
-- verified this session — not merely an enrolled factor). Defense in
-- depth: the Next.js route guard (lib/platform/dal.ts requirePlatformPermission)
-- already enforces AAL2 before calling this RPC, but that is application
-- code, not a database boundary. Anything that could ever call this RPC
-- directly (a future admin tool, a script, a bug that skips the route
-- guard) must not be able to get a privileged "true" back from an AAL1
-- session.
--
-- get_my_platform_role() is deliberately left AAL-unaware: it is the
-- signal app/internal/admin/mfa/page.tsx (and requirePlatformAdmin in
-- lib/platform/dal.ts) uses to decide "is this caller a platform admin at
-- all", which must stay answerable at AAL1 so a legitimate admin who
-- hasn't elevated yet can be routed to the MFA challenge instead of a flat
-- 404. It was never the authorization boundary itself — has_platform_
-- permission is — so widening what it requires would not change what a
-- caller can actually do without AAL2.
--
-- AAL is read from the trusted, PostgREST-verified JWT claims
-- (request.jwt.claims), the exact same source private.current_uid() above
-- already reads identity from — never a function parameter (a p_aal or
-- p_user_id argument would let a caller simply assert AAL2). Fails closed:
-- missing claims, a missing/null aal, "aal1", or any value other than the
-- literal string "aal2" all deny.

create or replace function private.has_platform_permission(p_permission_key text)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select exists (
    select 1
    from public.platform_admins pa
    join public.platform_role_permissions prp on prp.role = pa.role
    where pa.user_id = private.current_uid()
      and pa.is_active = true
      and prp.permission_key = p_permission_key
      and coalesce(
            (nullif(current_setting('request.jwt.claims', true), '')::jsonb ->> 'aal'),
            ''
          ) = 'aal2'
  );
$$;

-- Grants are unchanged from the original migration (EXECUTE to
-- authenticated only, never anon/PUBLIC) — CREATE OR REPLACE preserves the
-- function's existing ACL, so no revoke/grant is required here. Restated
-- anyway for auditability: a future reader of this file alone should not
-- have to cross-reference the earlier migration to know the ACL is narrow.
revoke all on function private.has_platform_permission(text) from public, anon, authenticated;
grant execute on function private.has_platform_permission(text) to authenticated;

revoke all on function public.has_platform_permission(text) from public, anon;
grant execute on function public.has_platform_permission(text) to authenticated;
