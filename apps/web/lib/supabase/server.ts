import { createServerClient } from "@supabase/ssr";
import { cookies } from "next/headers";
import type { Database } from "./database.types";

export async function createClient() {
  const cookieStore = await cookies();

  return createServerClient<Database>(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY!,
    {
      cookies: {
        getAll() {
          return cookieStore.getAll();
        },
        setAll(cookiesToSet, headers) {
          // @supabase/ssr also passes anti-caching response headers here
          // (Cache-Control/Expires/Pragma) whenever it writes auth cookies.
          // Server Components can't apply them — Next's `headers()` is
          // read-only there — so this matches Supabase's own canonical
          // Next.js `server.ts` example, which takes the same second
          // parameter and leaves it unused. `lib/supabase/proxy.ts` is
          // where these headers are actually applied, to the NextResponse
          // it owns.
          void headers;
          try {
            cookiesToSet.forEach(({ name, value, options }) => {
              cookieStore.set(name, value, options);
            });
          } catch {
            // Server Components cannot always write cookies.
            // proxy.ts refreshes the session on every request instead.
          }
        },
      },
    }
  );
}