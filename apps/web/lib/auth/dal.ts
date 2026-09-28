import "server-only";
import { cache } from "react";
import { redirect } from "next/navigation";
import { createClient } from "@/lib/supabase/server";
import type { User } from "@supabase/supabase-js";

// getUser(), not getClaims(): this is the DAL — the layer every real
// data-access decision runs through — so it gets the strongest available
// guarantee (a live Auth-server round trip), not just local JWT validation.
// proxy.ts's fast/optimistic getClaims() check is deliberately kept
// separate from this authoritative one.
export const getAuthUser = cache(async (): Promise<User | null> => {
  const supabase = await createClient();
  const { data, error } = await supabase.auth.getUser();
  if (error || !data.user) return null;
  return data.user;
});

export async function requireUser(): Promise<User> {
  const user = await getAuthUser();
  if (!user) {
    redirect("/login");
  }
  return user;
}

export type AssuranceLevel = "aal1" | "aal2";

// getClaims() (not getUser(), not a manual JWT decode): it verifies the
// access token's signature every call — the same mechanism proxy.ts's
// session check already relies on — and returns Supabase's standard claim
// set, which includes `aal`. A raw decode of the token payload would trust
// an unverified string; this trusts only what signature verification
// confirmed. Identity itself still goes through getUser()/requireUser()
// above — this is purely the assurance-level signal layered on top.
export const getAssuranceLevel = cache(
  async (): Promise<AssuranceLevel | null> => {
    const supabase = await createClient();
    const { data, error } = await supabase.auth.getClaims();
    if (error || !data?.claims) return null;

    const aal = (data.claims as { aal?: unknown }).aal;
    return aal === "aal1" || aal === "aal2" ? aal : null;
  }
);
