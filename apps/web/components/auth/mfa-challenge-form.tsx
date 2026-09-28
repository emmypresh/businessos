"use client";

import { useActionState } from "react";
import { verifyMfaChallenge } from "@/lib/auth/mfa-actions";
import { Label } from "@/components/ui/label";
import { Input } from "@/components/ui/input";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { SubmitButton } from "./submit-button";

export function MfaChallengeForm({ factorId }: { factorId: string }) {
  const [state, action] = useActionState(verifyMfaChallenge, undefined);

  return (
    <form action={action} className="flex flex-col gap-4">
      <input type="hidden" name="factorId" value={factorId} />
      <div className="flex flex-col gap-2">
        <Label htmlFor="code">6-digit code</Label>
        <Input
          id="code"
          name="code"
          inputMode="numeric"
          autoComplete="one-time-code"
          maxLength={6}
          aria-invalid={!!state?.fieldErrors?.code}
        />
        {state?.fieldErrors?.code ? (
          <p role="alert" className="text-sm text-destructive">
            {state.fieldErrors.code[0]}
          </p>
        ) : null}
      </div>
      {state?.error ? (
        <Alert variant="destructive" role="alert">
          <AlertDescription>{state.error}</AlertDescription>
        </Alert>
      ) : null}
      <SubmitButton>Verify</SubmitButton>
    </form>
  );
}
