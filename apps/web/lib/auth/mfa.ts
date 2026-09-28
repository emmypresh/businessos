import "server-only";
import { createClient } from "@/lib/supabase/server";
import { requireUser } from "./dal";

export type VerifiedTotpFactor = { id: string };

// Read-only: which of the current user's TOTP factors are already
// verified (i.e. usable for a challenge), for the MFA page to decide
// between rendering a challenge form and an enrollment flow. Never
// returns an unverified factor's id here — a stale unverified factor from
// an abandoned enrollment attempt is not something app/internal/admin/mfa
// should try to challenge against (it has no secret the user still has
// unless they saved it, and Supabase itself won't complete a challenge
// against it as AAL2 either way).
export async function listVerifiedTotpFactors(): Promise<VerifiedTotpFactor[]> {
  await requireUser();
  const supabase = await createClient();

  const { data, error } = await supabase.auth.mfa.listFactors();
  if (error || !data) return [];

  return data.totp
    .filter((factor) => factor.status === "verified")
    .map((factor) => ({ id: factor.id }));
}
