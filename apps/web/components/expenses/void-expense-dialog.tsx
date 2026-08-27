"use client";

import { useActionState } from "react";
import { voidExpense } from "@/lib/expenses/actions";
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
import { VOID_REASON_MAX_LENGTH } from "@/lib/expenses/constants";

export function VoidExpenseDialog({
  businessId,
  expenseId,
  expenseNumber,
}: {
  businessId: string;
  expenseId: string;
  expenseNumber: string;
}) {
  const [state, formAction] = useActionState(voidExpense, undefined);

  return (
    <Dialog>
      <DialogTrigger render={<Button variant="destructive" />}>Void expense</DialogTrigger>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Void &ldquo;{expenseNumber}&rdquo;?</DialogTitle>
          <DialogDescription>
            This does <strong>not</strong> delete the expense — the record stays visible in the
            expense history, permanently marked as voided. A voided expense stops counting toward
            current expense totals and the financial overview. This cannot be undone.
          </DialogDescription>
        </DialogHeader>
        <form action={formAction} className="flex flex-col gap-4">
          <input type="hidden" name="businessId" value={businessId} />
          <input type="hidden" name="expenseId" value={expenseId} />

          <div className="flex flex-col gap-2">
            <Label htmlFor="void-reason">Reason</Label>
            <Textarea
              id="void-reason"
              name="reason"
              rows={3}
              maxLength={VOID_REASON_MAX_LENGTH}
              aria-invalid={!!state?.fieldErrors?.reason}
              required
            />
            {state?.fieldErrors?.reason ? (
              <p role="alert" className="text-sm text-destructive">
                {state.fieldErrors.reason[0]}
              </p>
            ) : null}
          </div>

          {state?.error ? (
            <Alert variant="destructive" role="alert">
              <AlertDescription>{state.error}</AlertDescription>
            </Alert>
          ) : null}

          <DialogFooter>
            <SubmitButton>Void</SubmitButton>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
