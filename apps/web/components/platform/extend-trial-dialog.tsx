"use client";

import { useActionState, useMemo, useState } from "react";
import { extendTrialAction } from "@/lib/platform/actions";
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
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { SubmitButton } from "@/components/auth/submit-button";
import { TRIAL_EXTENSION_MIN_DAYS, TRIAL_EXTENSION_MAX_DAYS } from "@/lib/validation/platform-actions";

function formatDateTime(value: Date): string {
  return value.toLocaleString(undefined, {
    year: "numeric",
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
  });
}

/**
 * Only rendered by the caller when the subscription is currently TRIALING
 * (the RPC itself also independently fails closed for every other state —
 * see platform_extend_trial's own header comment). Bounded days only, no
 * arbitrary date picker (phase instructions §33), and the new computed
 * trial end is shown BEFORE confirmation, computed client-side from the
 * same currentTrialEndsAt the server already trusts.
 */
export function ExtendTrialDialog({
  businessId,
  currentTrialEndsAt,
  idempotencyKey,
}: {
  businessId: string;
  currentTrialEndsAt: string;
  idempotencyKey: string;
}) {
  const [state, formAction] = useActionState(extendTrialAction, undefined);
  const [days, setDays] = useState(7);

  const currentEnd = useMemo(() => new Date(currentTrialEndsAt), [currentTrialEndsAt]);
  const newEnd = useMemo(
    () => new Date(currentEnd.getTime() + days * 24 * 60 * 60 * 1000),
    [currentEnd, days]
  );

  return (
    <Dialog>
      <DialogTrigger render={<Button variant="secondary" />}>Extend trial</DialogTrigger>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Extend trial</DialogTitle>
          <DialogDescription>
            Current trial ends {formatDateTime(currentEnd)}. This only extends the trial window —
            it does not change the plan, provider, or any other subscription state.
          </DialogDescription>
        </DialogHeader>
        <form action={formAction} className="flex flex-col gap-4">
          <input type="hidden" name="businessId" value={businessId} />
          <input type="hidden" name="idempotencyKey" value={idempotencyKey} />

          <div className="flex flex-col gap-2">
            <Label htmlFor="extend-trial-days">Days to add</Label>
            <Input
              id="extend-trial-days"
              name="days"
              type="number"
              min={TRIAL_EXTENSION_MIN_DAYS}
              max={TRIAL_EXTENSION_MAX_DAYS}
              step={1}
              required
              value={days}
              onChange={(event) => {
                const parsed = Number(event.target.value);
                setDays(Number.isFinite(parsed) ? parsed : 0);
              }}
              aria-invalid={!!state?.fieldErrors?.days}
              aria-describedby="extend-trial-preview"
            />
            {state?.fieldErrors?.days ? (
              <p role="alert" className="text-sm text-destructive">
                {state.fieldErrors.days[0]}
              </p>
            ) : null}
            <p id="extend-trial-preview" className="text-sm text-muted-foreground">
              New trial end: {formatDateTime(newEnd)}
            </p>
          </div>

          <div className="flex flex-col gap-2">
            <Label htmlFor="extend-trial-reason">Reason</Label>
            <Textarea
              id="extend-trial-reason"
              name="reason"
              required
              minLength={10}
              maxLength={500}
              placeholder="Why is this trial being extended? (10–500 characters)"
              aria-invalid={!!state?.fieldErrors?.reason}
              aria-describedby={state?.fieldErrors?.reason ? "extend-trial-reason-error" : undefined}
            />
            {state?.fieldErrors?.reason ? (
              <p id="extend-trial-reason-error" role="alert" className="text-sm text-destructive">
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
                Extended. See Platform Actions history below for the exact time and details.
              </AlertDescription>
            </Alert>
          ) : null}

          <DialogFooter>
            <SubmitButton>Extend trial</SubmitButton>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
