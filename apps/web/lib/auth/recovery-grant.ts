import type { ReadonlyRequestCookies } from "next/dist/server/web/spec-extension/adapters/request-cookies";

// Shared between app/auth/confirm/route.ts (issues the grant cookie) and
// lib/auth/actions.ts's updatePassword and logOut (read/clear it). The
// cookie itself only ever carries an opaque grant id —
// private.password_recovery_grants (see the migration) is the actual
// source of truth for whether that id is still valid, unexpired, and
// unconsumed; the cookie's only job is getting the id from /auth/confirm
// to /reset-password.
export const RECOVERY_GRANT_COOKIE = "sb-recovery-grant";

// Matches the grant's own expiry (10 minutes) set in the migration —
// letting the cookie outlive the grant would be harmless (consume_recovery_grant
// checks expires_at server-side regardless), but keeping them equal avoids
// a stale cookie sitting around implying a capability that no longer exists.
export const RECOVERY_GRANT_MAX_AGE_SECONDS = 10 * 60;

/**
 * Deletes the recovery-grant cookie, using the exact same name and path it
 * was issued with (app/auth/confirm/route.ts's `cookieStore.set(...)`) —
 * a browser only overwrites/removes a cookie when the deleting Set-Cookie
 * matches both. This is cleanup, not a security boundary: the grant row
 * itself (single-use, expiring, session-bound) is what actually prevents
 * reuse; this only stops a stale/rejected/already-consumed id from
 * lingering in the browser and being resubmitted needlessly. Called from
 * every rejection path in updatePassword, from the success path, and from
 * logOut — never skipped just because a caller "probably" doesn't have
 * the cookie set, since deleting an absent cookie is a harmless no-op.
 */
export function clearRecoveryGrantCookie(cookieStore: ReadonlyRequestCookies) {
  cookieStore.delete({ name: RECOVERY_GRANT_COOKIE, path: "/" });
}
