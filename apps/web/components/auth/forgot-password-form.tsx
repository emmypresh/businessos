"use client";

import { useActionState } from "react";
import { requestPasswordReset } from "@/lib/auth/actions";
import { Label } from "@/components/ui/label";
import { Input } from "@/components/ui/input";
import { SubmitButton } from "./submit-button";

export function ForgotPasswordForm() {
  const [state, action] = useActionState(requestPasswordReset, undefined);

  if (state?.success) {
    return (
      <div className="flex flex-col gap-2">
        <h2 className="font-medium">Check your email</h2>
        <p className="text-muted-foreground">
          If an account exists for that address, we sent a link to reset your password.
        </p>
      </div>
    );
  }

  return (
    <form action={action} className="flex flex-col gap-4">
      <div className="flex flex-col gap-2">
        <Label htmlFor="email">Email</Label>
        <Input id="email" name="email" type="email" autoComplete="email" aria-invalid={!!state?.fieldErrors?.email} />
        {state?.fieldErrors?.email ? <p role="alert" className="text-sm text-destructive">{state.fieldErrors.email[0]}</p> : null}
      </div>
      <SubmitButton>Send reset link</SubmitButton>
    </form>
  );
}
