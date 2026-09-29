"use client";

import { useActionState } from "react";
import { suspendBusinessAction } from "@/lib/platform/actions";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { SubmitButton } from "@/components/auth/submit-button";

/**
 * Destructive-style confirmation, per phase instructions §31: explicit
 * confirmation, the target business's own name visible, a required reason,
 * and a clear, specific statement of effect (never a vague "are you
 * sure?"). idempotencyKey is generated server-side once per page render
 * (the business detail page) and carried as a hidden field — a double
 * submit of this SAME rendered form resubmits the SAME key, which the RPC
 * treats as a safe replay rather than a second suspension.
 */
export function SuspendBusinessDialog({
  businessId,
  businessName,
  idempotencyKey,
}: {
  businessId: string;
  businessName: string;
  idempotencyKey: string;
}) {
  const [state, formAction] = useActionState(suspendBusinessAction, undefined);

  return (
    <Dialog>
      <DialogTrigger render={<Button variant="destructive" />}>Suspend business</DialogTrigger>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Suspend &ldquo;{businessName}&rdquo;?</DialogTitle>
          <DialogDescription>
            This immediately blocks every tenant member&apos;s access to this business — they will
            not be able to sign in to it or use any feature until it is reactivated. No data is
            deleted. Billing records and platform support access are unaffected; you and other
            authorized platform staff can continue to inspect this business while it is suspended.
            If this user belongs to other businesses, those remain fully accessible.
          </DialogDescription>
        </DialogHeader>
        <form action={formAction} className="flex flex-col gap-4">
          <input type="hidden" name="businessId" value={businessId} />
          <input type="hidden" name="idempotencyKey" value={idempotencyKey} />

          <div className="flex flex-col gap-2">
            <Label htmlFor="suspend-reason">Reason</Label>
            <Textarea
              id="suspend-reason"
              name="reason"
              required
              minLength={10}
              maxLength={500}
              placeholder="Why is this business being suspended? (10–500 characters)"
              aria-invalid={!!state?.fieldErrors?.reason}
              aria-describedby={state?.fieldErrors?.reason ? "suspend-reason-error" : undefined}
            />
            {state?.fieldErrors?.reason ? (
              <p id="suspend-reason-error" role="alert" className="text-sm text-destructive">
                {state.fieldErrors.reason[0]}
              </p>
            ) : null}
          </div>

          {state?.error ? (
            <Alert variant="destructive" role="alert">
              <AlertDescription>{state.error}</AlertDescription>
            </Alert>
          ) : null}
          {state?.success ? (
            <Alert role="status">
              <AlertDescription>
                Suspended. See Platform Actions history below for the exact time and details.
              </AlertDescription>
            </Alert>
          ) : null}

          <DialogFooter>
            <SubmitButton>Suspend business</SubmitButton>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
