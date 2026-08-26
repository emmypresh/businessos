"use client";

import { useActionState } from "react";
import Link from "next/link";
import { logIn } from "@/lib/auth/actions";
import { Label } from "@/components/ui/label";
import { Input } from "@/components/ui/input";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { SubmitButton } from "./submit-button";

export function LoginForm({ next }: { next: string }) {
  const [state, action] = useActionState(logIn, undefined);

  return (
    <form action={action} className="flex flex-col gap-4">
      <input type="hidden" name="next" value={next} />
      <div className="flex flex-col gap-2">
        <Label htmlFor="email">Email</Label>
        <Input id="email" name="email" type="email" autoComplete="email" aria-invalid={!!state?.fieldErrors?.email} />
        {state?.fieldErrors?.email ? <p role="alert" className="text-sm text-destructive">{state.fieldErrors.email[0]}</p> : null}
      </div>
      <div className="flex flex-col gap-2">
        <Label htmlFor="password">Password</Label>
        <Input id="password" name="password" type="password" autoComplete="current-password" aria-invalid={!!state?.fieldErrors?.password} />
        {state?.fieldErrors?.password ? <p role="alert" className="text-sm text-destructive">{state.fieldErrors.password[0]}</p> : null}
      </div>
      {state?.error ? (
        <Alert variant="destructive" role="alert"><AlertDescription>{state.error}</AlertDescription></Alert>
      ) : null}
      <SubmitButton>Log in</SubmitButton>
      <p className="flex justify-between text-sm text-muted-foreground">
        <Link href="/signup" className="underline underline-offset-4">Create an account</Link>
        <Link href="/forgot-password" className="underline underline-offset-4">Forgot password?</Link>
      </p>
    </form>
  );
}
