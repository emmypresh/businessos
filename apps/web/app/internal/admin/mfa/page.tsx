import { redirect } from "next/navigation";
import { getAssuranceLevel } from "@/lib/auth/dal";
import { listVerifiedTotpFactors } from "@/lib/auth/mfa";
import { MfaChallengeForm } from "@/components/auth/mfa-challenge-form";
import { MfaEnrollFlow } from "@/components/auth/mfa-enroll-flow";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";

// Reached only by an active platform admin — the layout above already
// proved that via requirePlatformAdmin(), the same gate an ordinary
// tenant user fails with a generic 404 before ever reaching this file.
// This page exists only to answer one question: is the current session
// AAL2 yet? If so there's nothing to do here, redirect into the console.
// If not, render a challenge (an already-verified TOTP factor exists) or
// an enrollment flow (it doesn't) — either way nothing under
// /internal/admin renders privileged content until Supabase itself
// reports aal2 on a subsequent request.
export default async function InternalAdminMfaPage() {
  const aal = await getAssuranceLevel();
  if (aal === "aal2") {
    redirect("/internal/admin");
  }

  const verifiedFactors = await listVerifiedTotpFactors();
  const factor = verifiedFactors[0];

  return (
    <Card className="mx-auto max-w-md">
      <CardHeader>
        <CardTitle>Verify it&apos;s you</CardTitle>
        <CardDescription>
          Platform administration requires a verified authenticator app code every session.
        </CardDescription>
      </CardHeader>
      <CardContent>
        {factor ? <MfaChallengeForm factorId={factor.id} /> : <MfaEnrollFlow />}
      </CardContent>
    </Card>
  );
}
