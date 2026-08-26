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
