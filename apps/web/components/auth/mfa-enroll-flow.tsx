"use client";

import { useActionState } from "react";
import { enrollTotpFactor, verifyMfaChallenge, type MfaEnrollState } from "@/lib/auth/mfa-actions";
import { Label } from "@/components/ui/label";
import { Input } from "@/components/ui/input";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { SubmitButton } from "./submit-button";

// useActionState requires a (prevState, formData) function; enrollTotpFactor
// takes no arguments (there is nothing to submit — the whole point is that
// no factor exists yet). Typed to match useActionState's expected shape
// without declaring unused parameter names — JS permits calling a function
// with more arguments than it declares.
const startEnrollment: (
  prevState: MfaEnrollState,
  formData: FormData
) => Promise<MfaEnrollState> = async () => enrollTotpFactor();

// Minimal two-step flow per the 1O-A phase brief: this is deliberately not
// the polished internal-admin login redesign (that's a later phase) — a
// button to generate a QR code, then a single code input to verify it.
export function MfaEnrollFlow() {
  const [enrollState, enrollAction] = useActionState(startEnrollment, undefined);
  const [verifyState, verifyAction] = useActionState(verifyMfaChallenge, undefined);

  if (!enrollState || !("factorId" in enrollState) || !enrollState.factorId) {
    return (
      <form action={enrollAction} className="flex flex-col gap-4">
        <p className="text-sm text-muted-foreground">
          No authenticator app is set up yet. Generate a QR code to add one.
        </p>
        {enrollState?.error ? (
          <Alert variant="destructive" role="alert">
            <AlertDescription>{enrollState.error}</AlertDescription>
          </Alert>
        ) : null}
        <SubmitButton>Set up authenticator app</SubmitButton>
      </form>
    );
  }

  const { factorId, qrCode, secret } = enrollState;

  return (
    <form action={verifyAction} className="flex flex-col gap-4">
      <input type="hidden" name="factorId" value={factorId} />
      <p className="text-sm text-muted-foreground">
        Scan this QR code with your authenticator app, then enter the 6-digit code it shows.
      </p>
      {/* qrCode is an inline SVG data: URI from Supabase — rendered directly,
          never logged, never placed in a URL or query string. */}
      {/* eslint-disable-next-line @next/next/no-img-element */}
      <img src={qrCode} alt="Authenticator app QR code" className="mx-auto h-40 w-40" />
      <p className="text-center text-xs text-muted-foreground">
        Can&apos;t scan? Enter this key manually:{" "}
        <code className="rounded bg-muted px-1 py-0.5">{secret}</code>
      </p>
      <div className="flex flex-col gap-2">
        <Label htmlFor="code">6-digit code</Label>
        <Input
          id="code"
          name="code"
          inputMode="numeric"
          autoComplete="one-time-code"
          maxLength={6}
          aria-invalid={!!verifyState?.fieldErrors?.code}
        />
        {verifyState?.fieldErrors?.code ? (
          <p role="alert" className="text-sm text-destructive">
            {verifyState.fieldErrors.code[0]}
          </p>
        ) : null}
      </div>
      {verifyState?.error ? (
        <Alert variant="destructive" role="alert">
          <AlertDescription>{verifyState.error}</AlertDescription>
        </Alert>
      ) : null}
      <SubmitButton>Verify and enable</SubmitButton>
    </form>
  );
}
