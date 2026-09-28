"use server";

import { redirect } from "next/navigation";
import { createClient } from "@/lib/supabase/server";
import { requireUser } from "@/lib/auth/dal";
import { requirePlatformAdmin } from "@/lib/platform/dal";
import { MfaVerifySchema } from "@/lib/validation/auth";

// Both actions gate on requirePlatformAdmin(), not just requireUser(): this
// flow exists to elevate a platform admin's own session to AAL2. An
// ordinary tenant user calling either action directly (bypassing the UI)
// gets exactly the same notFound() as visiting /internal/admin/mfa itself
// — no distinguishable response reveals whether they're "signed in but
// not an admin" vs. "not signed in", matching every other platform gate's
// fail-closed convention. MFA enrollment/verification is not itself
// privileged (any authenticated user could safely enroll a factor on
// their own account — see the phase brief's "MFA is not platform
// authority" note), but scoping these actions to admins avoids exposing
// a general-purpose MFA management endpoint before this app has any
// tenant-facing MFA feature that would need one.

export type MfaEnrollState =
  | { error: string; factorId?: undefined }
  | { factorId: string; qrCode: string; secret: string; error?: undefined }
  | undefined;

export async function enrollTotpFactor(): Promise<MfaEnrollState> {
  await requireUser();
  await requirePlatformAdmin();

  const supabase = await createClient();
  const { data, error } = await supabase.auth.mfa.enroll({ factorType: "totp" });

  // Never log `error` or `data` here: a failed enroll's error message and
  // a successful enroll's secret are both sensitive, and console output on
  // a server is still a log.
  if (error || !data) {
    return { error: "Could not start authenticator app setup. Try again." };
  }

  return {
    factorId: data.id,
    qrCode: data.totp.qr_code,
    secret: data.totp.secret,
  };
}

export type MfaVerifyState =
  | { error?: string; fieldErrors?: Record<string, string[] | undefined> }
  | undefined;

export async function verifyMfaChallenge(
  _prevState: MfaVerifyState,
  formData: FormData
): Promise<MfaVerifyState> {
  await requireUser();
  await requirePlatformAdmin();

  const parsed = MfaVerifySchema.safeParse({
    factorId: formData.get("factorId"),
    code: formData.get("code"),
  });
  if (!parsed.success) {
    return { fieldErrors: parsed.error.flatten().fieldErrors };
  }

  const supabase = await createClient();
  const { error } = await supabase.auth.mfa.challengeAndVerify({
    factorId: parsed.data.factorId,
    code: parsed.data.code,
  });

  if (error) {
    // Supabase's own message here never echoes the submitted code or any
    // factor secret. Never log the submitted code.
    return { error: "That code didn't verify. Check your authenticator app and try again." };
  }

  // challengeAndVerify(), called through the SSR-configured client
  // (lib/supabase/server.ts), mints a new AAL2 session and persists it via
  // the same cookie-writing path every other auth action in this app
  // uses. By the time this redirect fires, the elevated session is
  // already what the next request will see — requirePlatformPermission
  // (lib/platform/dal.ts) re-reads AAL from getClaims() on that next
  // request, so there is nothing further to check before redirecting.
  redirect("/internal/admin");
}
