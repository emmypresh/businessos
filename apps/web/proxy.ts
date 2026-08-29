import { NextResponse, type NextRequest } from "next/server";
import { updateSession } from "@/lib/supabase/proxy";

// Codex adversarial review, application-layer round 3, Low 1: a malformed
// branchId/memberId (e.g. /businessId/branches/not-a-uuid) is already
// caught by lib/branches/dal.ts's/lib/staff/dal.ts's own UUID_PATTERN
// guard, which calls Next's notFound() — that part was never wrong. The
// bug is that the branch/staff detail (and branch edit) pages render
// beneath [businessId]/loading.tsx, which wraps every route below it in a
// <Suspense> boundary; per Next's own documented streaming behavior
// (node_modules/next/dist/docs/.../file-conventions/loading.md, "Status
// Codes"), the response headers — and therefore the HTTP 200 status —
// are already committed the moment that Suspense boundary is reached,
// before notFound() ever throws deeper inside. The fix is NOT to touch
// that shared loading.tsx (every route under a business depends on it,
// far outside this finding's scope) — it's to catch exactly the
// zero-database-lookup, URL-format-only case before Next starts
// rendering/streaming at all, exactly where Next's own docs point:
// "If you need a 404 status ... ensure the resource exists before the
// response body is streamed ... You can run this check in proxy." This
// does not replace or weaken the DAL's own guard (still the only thing
// standing between a malformed id and Postgres) — it duplicates just the
// format check, purely to let a true status code be set for it.
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// One entry per dynamic detail segment this applies to. `reserved` lists
// that segment's own STATIC sibling routes (e.g. branches/new,
// staff/invite) — names Next's own file-based router already resolves to
// a different, real page ahead of the `[branchId]`/`[memberId]` dynamic
// segment, so they must never be mistaken for a malformed id here.
const DETAIL_ROUTES: { pattern: RegExp; reserved: ReadonlySet<string> }[] = [
  { pattern: /^\/[^/]+\/branches\/([^/]+)(?:\/edit)?\/?$/, reserved: new Set(["new"]) },
  { pattern: /^\/[^/]+\/staff\/([^/]+)\/?$/, reserved: new Set(["invite", "invitations"]) },
];

function isMalformedDetailRoute(pathname: string): boolean {
  for (const { pattern, reserved } of DETAIL_ROUTES) {
    const match = pattern.exec(pathname);
    if (!match) continue;
    const id = match[1];
    return !reserved.has(id) && !UUID_PATTERN.test(id);
  }
  return false;
}

// Same copy as app/not-found.tsx — this is the one path in the app that
// can't reach that component (it runs before any React tree renders), so
// the wording is kept identical rather than inventing a second message.
const NOT_FOUND_HTML = `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="robots" content="noindex" />
    <title>Not found</title>
  </head>
  <body style="display:flex;min-height:100vh;margin:0;align-items:center;justify-content:center;padding:4rem;text-align:center;font-family:system-ui,-apple-system,sans-serif;">
    <div>
      <h1 style="font-size:1.25rem;font-weight:600;margin:0 0 0.75rem;">Not found</h1>
      <p style="color:#6b7280;margin:0 0 1.25rem;">This page doesn't exist, or you don't have access to it.</p>
      <a href="/" style="color:inherit;text-decoration:underline;">Go home</a>
    </div>
  </body>
</html>`;

export async function proxy(request: NextRequest) {
  const sessionResponse = await updateSession(request);

  // Only overrides an ordinary continuation — a redirect updateSession
  // already produced (signed-out -> /login, signed-in -> /) is returned
  // completely unchanged: a malformed id in the URL is not more urgent
  // to disclose than the existing authentication gate, and an auth
  // redirect's own Set-Cookie/Location must never be touched here.
  if (sessionResponse.status !== 200 || !isMalformedDetailRoute(request.nextUrl.pathname)) {
    return sessionResponse;
  }

  // Codex adversarial review, application-layer round 4: the previous
  // version of this branch returned a brand-new `NextResponse` with none
  // of sessionResponse's headers, silently discarding whatever
  // updateSession() had just done to the request's cookies — most
  // importantly a refreshed Supabase auth token's Set-Cookie, but
  // Cache-Control too (see lib/supabase/proxy.ts's own pendingHeaders
  // comment for why it sets one). This must return a true 404 status
  // (the whole point of this file) while still carrying every one of
  // those over.
  //
  // Cookies specifically go through NextResponse's own `.cookies`
  // accessor (a `ResponseCookies` instance), never raw Headers
  // iteration/joining: confirmed directly against this Next version's
  // own compiled implementation
  // (node_modules/next/dist/compiled/@edge-runtime/cookies/index.js) —
  // every `.set()` call does `headers.delete("set-cookie")` then
  // `headers.append("set-cookie", ...)` once per cookie in its internal
  // map, so N cookies remain N separate Set-Cookie header lines, never
  // collapsed into one comma-joined string the way naively copying
  // `Headers.get("set-cookie")` would. `.getAll()` on the SOURCE
  // response likewise parses however many Set-Cookie lines
  // sessionResponse actually carries (zero, one, or several) via that
  // same file's own `responseHeaders.getSetCookie?.() ??
  // responseHeaders.get("set-cookie")` fallback, so this round-trips
  // correctly regardless of how many updateSession happened to set.
  const notFoundResponse = new NextResponse(NOT_FOUND_HTML, {
    status: 404,
    headers: { "content-type": "text/html; charset=utf-8" },
  });

  for (const cookie of sessionResponse.cookies.getAll()) {
    notFoundResponse.cookies.set(cookie);
  }

  // Every other header updateSession set — Cache-Control chief among
  // them — is carried over too. set-cookie is excluded here (already
  // handled correctly above, via the cookies API, not this loop);
  // content-type/content-length are excluded because this response's
  // own body and type replace theirs, not extend them.
  sessionResponse.headers.forEach((value, key) => {
    const lower = key.toLowerCase();
    if (lower === "set-cookie" || lower === "content-type" || lower === "content-length") return;
    notFoundResponse.headers.set(key, value);
  });

  return notFoundResponse;
}

export const config = {
  matcher: [
    "/((?!_next/static|_next/image|favicon.ico|.*\\.(?:svg|png|jpg|jpeg|gif|webp)$).*)",
  ],
};
