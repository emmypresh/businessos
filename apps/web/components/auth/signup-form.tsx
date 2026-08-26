"use client";

import { useActionState } from "react";
import Link from "next/link";
import { signUp } from "@/lib/auth/actions";
import { Label } from "@/components/ui/label";
import { Input } from "@/components/ui/input";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { SubmitButton } from "./submit-button";

export function SignUpForm() {
  const [state, action] = useActionState(signUp, undefined);

  if (state?.success) {
    return (
      <div className="flex flex-col gap-2">
        <h2 className="font-medium">Check your email</h2>
        <p className="text-muted-foreground">
          We sent a confirmation link to the address you signed up with.
          Follow it to finish setting up your account.
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
      <div className="flex flex-col gap-2">
        <Label htmlFor="password">Password</Label>
        <Input id="password" name="password" type="password" autoComplete="new-password" aria-invalid={!!state?.fieldErrors?.password} />
        {state?.fieldErrors?.password ? <p role="alert" className="text-sm text-destructive">{state.fieldErrors.password[0]}</p> : null}
      </div>
      <div className="flex flex-col gap-2">
        <Label htmlFor="confirmPassword">Confirm password</Label>
        <Input id="confirmPassword" name="confirmPassword" type="password" autoComplete="new-password" aria-invalid={!!state?.fieldErrors?.confirmPassword} />
        {state?.fieldErrors?.confirmPassword ? <p role="alert" className="text-sm text-destructive">{state.fieldErrors.confirmPassword[0]}</p> : null}
      </div>
      {state?.error ? (
        <Alert variant="destructive" role="alert"><AlertDescription>{state.error}</AlertDescription></Alert>
      ) : null}
      <SubmitButton>Sign up</SubmitButton>
      <p className="text-sm text-muted-foreground">
        Already have an account? <Link href="/login" className="underline underline-offset-4">Log in</Link>
      </p>
    </form>
  );
}
