"use client";

import { useActionState } from "react";
import { cancelSubscriptionAction } from "@/lib/billing/actions";
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
import { Alert, AlertDescription } from "@/components/ui/alert";
import { SubmitButton } from "@/components/auth/submit-button";

export function CancelSubscriptionDialog({ businessId }: { businessId: string }) {
  const [state, formAction] = useActionState(cancelSubscriptionAction, undefined);

  return (
    <Dialog>
      <DialogTrigger render={<Button variant="destructive" size="sm" />}>Cancel subscription</DialogTrigger>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Cancel subscription?</DialogTitle>
          <DialogDescription>
            Your business keeps full access until the end of the current trial/billing period shown
            above — this does <strong>not</strong> end access immediately, and no data is ever
            deleted or hidden.
          </DialogDescription>
        </DialogHeader>
        <form action={formAction} className="flex flex-col gap-4">
          <input type="hidden" name="businessId" value={businessId} />
          {state?.error ? (
            <Alert variant="destructive" role="alert">
              <AlertDescription>{state.error}</AlertDescription>
            </Alert>
          ) : null}
          <DialogFooter>
            <SubmitButton>Schedule cancellation</SubmitButton>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
