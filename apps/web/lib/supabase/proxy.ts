import { createServerClient, type CookieOptions } from "@supabase/ssr";
import { NextResponse, type NextRequest } from "next/server";
import type { Database } from "./database.types";

// Routes a signed-in visitor is redirected away from (back to "/"). Does
// NOT include /reset-password — see the design note below.
const AUTH_ONLY_ROUTES = ["/login", "/signup", "/forgot-password"];

// Routes proxy never redirects, in either auth state.
//  - /auth/confirm: an unauthenticated visitor must reach it (that's how
//    they become authenticated); an already-authenticated visitor must
//    also reach it unredirected (confirming an email change while signed
//    in, or re-clicking a recovery link mid-session). Its Route Handler
//    (Task 8) does its own redirect once verifyOtp succeeds or fails.
//  - /reset-password: reachable by a freshly-recovery-authenticated
//    session (the expected case) without being bounced by the
//    signed-in-redirect rule below. updatePassword (Task 6) — not proxy —
//    is what actually verifies the session is legitimate and
//    recovery-derived before allowing a password change.
const ALWAYS_ALLOWED_ROUTES = ["/auth/confirm", "/reset-password"];

type PendingCookie = { name: string; value: string; options: CookieOptions };

export async function updateSession(request: NextRequest) {
  // Accumulated here instead of being written straight onto a `response`
  // variable that setAll() used to reconstruct on every call: a redirect
  // decision below (signed-out -> /login, signed-in -> /) previously
  // returned a *brand new* NextResponse.redirect(...) that never received
  // any of this, silently dropping a just-refreshed session's cookies (and
  // now, the anti-caching headers) whenever a refresh and a redirect
  // happened on the same request. `finalize()` applies both to whichever
  // response actually gets returned, on every exit path, exactly once.
  const pendingCookies: PendingCookie[] = [];
  let pendingHeaders: Record<string, string> = {};

  // With Fluid compute, don't put this client in a global environment
  // variable. Always create a new one on each request.
  const supabase = createServerClient<Database>(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY!,
    {
      cookies: {
        getAll() {
          return request.cookies.getAll();
        },
        setAll(cookiesToSet, headers) {
          cookiesToSet.forEach(({ name, value }) =>
            request.cookies.set(name, value)
          );
          pendingCookies.push(...cookiesToSet);
          // @supabase/ssr passes Cache-Control/Expires/Pragma here whenever
          // it writes auth cookies, so a CDN/reverse proxy never caches a
          // response carrying one user's session token for another user.
          pendingHeaders = { ...pendingHeaders, ...headers };
        },
      },
    }
  );

  function finalize(response: NextResponse): NextResponse {
    pendingCookies.forEach(({ name, value, options }) =>
      response.cookies.set(name, value, options)
    );
    Object.entries(pendingHeaders).forEach(([key, value]) =>
      response.headers.set(key, value)
    );
    return response;
  }

  // Do not run code between createServerClient and getClaims(): a simple
  // mistake here could make it very hard to debug users being randomly
  // logged out. getClaims() validates the JWT signature every time —
  // getSession() is never used here per Global Constraints.
  const { data } = await supabase.auth.getClaims();
  const claims = data?.claims ?? null;

  const pathname = request.nextUrl.pathname;

  if (ALWAYS_ALLOWED_ROUTES.some((route) => pathname.startsWith(route))) {
    return finalize(NextResponse.next({ request }));
  }

  const isAuthOnlyRoute = AUTH_ONLY_ROUTES.some((route) =>
    pathname.startsWith(route)
  );

  if (!claims && !isAuthOnlyRoute && pathname !== "/") {
    const loginUrl = new URL("/login", request.url);
    // pathname always starts with "/" by construction (it's
    // request.nextUrl.pathname), so this is already a safe redirect
    // target; the logIn action re-validates it anyway via
    // isSafeRedirectPath before consuming it, since a query param is
    // untrusted input the moment it round-trips through a URL a user can
    // edit.
    loginUrl.searchParams.set("next", pathname);
    return finalize(NextResponse.redirect(loginUrl));
  }

  if (claims && isAuthOnlyRoute) {
    return finalize(NextResponse.redirect(new URL("/", request.url)));
  }

  return finalize(NextResponse.next({ request }));
}
