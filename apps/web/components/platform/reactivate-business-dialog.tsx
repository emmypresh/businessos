"use client";

import { useActionState } from "react";
import { reactivateBusinessAction } from "@/lib/platform/actions";
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
 * Less destructive than suspend, but still requires a reason and explicit
 * confirmation (phase instructions §32). Reverses ONLY the suspension
 * flag — never touches subscription, roles, plan, or owner.
 */
export function ReactivateBusinessDialog({
  businessId,
  businessName,
  idempotencyKey,
}: {
  businessId: string;
  businessName: string;
  idempotencyKey: string;
}) {
  const [state, formAction] = useActionState(reactivateBusinessAction, undefined);

  return (
    <Dialog>
      <DialogTrigger render={<Button variant="secondary" />}>Reactivate business</DialogTrigger>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Reactivate &ldquo;{businessName}&rdquo;?</DialogTitle>
          <DialogDescription>
            This restores tenant member access. It does not reset the subscription, roles, plan,
            or owner — only the suspension itself is reversed.
          </DialogDescription>
        </DialogHeader>
        <form action={formAction} className="flex flex-col gap-4">
          <input type="hidden" name="businessId" value={businessId} />
          <input type="hidden" name="idempotencyKey" value={idempotencyKey} />

          <div className="flex flex-col gap-2">
            <Label htmlFor="reactivate-reason">Reason</Label>
            <Textarea
              id="reactivate-reason"
              name="reason"
              required
              minLength={10}
              maxLength={500}
              placeholder="Why is this business being reactivated? (10–500 characters)"
              aria-invalid={!!state?.fieldErrors?.reason}
              aria-describedby={state?.fieldErrors?.reason ? "reactivate-reason-error" : undefined}
            />
            {state?.fieldErrors?.reason ? (
              <p id="reactivate-reason-error" role="alert" className="text-sm text-destructive">
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
                Reactivated. See Platform Actions history below for the exact time and details.
              </AlertDescription>
            </Alert>
          ) : null}

          <DialogFooter>
            <SubmitButton>Reactivate business</SubmitButton>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
