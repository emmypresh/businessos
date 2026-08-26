"use client";

import { useActionState } from "react";
import { updatePassword } from "@/lib/auth/actions";
import { Label } from "@/components/ui/label";
import { Input } from "@/components/ui/input";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { SubmitButton } from "./submit-button";

export function ResetPasswordForm() {
  const [state, action] = useActionState(updatePassword, undefined);

  return (
    <form action={action} className="flex flex-col gap-4">
      <div className="flex flex-col gap-2">
        <Label htmlFor="password">New password</Label>
        <Input id="password" name="password" type="password" autoComplete="new-password" aria-invalid={!!state?.fieldErrors?.password} />
        {state?.fieldErrors?.password ? <p role="alert" className="text-sm text-destructive">{state.fieldErrors.password[0]}</p> : null}
      </div>
      <div className="flex flex-col gap-2">
        <Label htmlFor="confirmPassword">Confirm new password</Label>
        <Input id="confirmPassword" name="confirmPassword" type="password" autoComplete="new-password" aria-invalid={!!state?.fieldErrors?.confirmPassword} />
        {state?.fieldErrors?.confirmPassword ? <p role="alert" className="text-sm text-destructive">{state.fieldErrors.confirmPassword[0]}</p> : null}
      </div>
      {state?.error ? (
        <Alert variant="destructive" role="alert"><AlertDescription>{state.error}</AlertDescription></Alert>
      ) : null}
      <SubmitButton>Update password</SubmitButton>
    </form>
  );
}
