"use client";

import { useActionState } from "react";
import { voidInvoice } from "@/lib/invoices/actions";
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

export function VoidInvoiceDialog({
  businessId,
  invoiceId,
  invoiceNumber,
}: {
  businessId: string;
  invoiceId: string;
  invoiceNumber: string;
}) {
  const [state, formAction] = useActionState(voidInvoice, undefined);

  return (
    <Dialog>
      <DialogTrigger render={<Button variant="destructive" />}>Void invoice</DialogTrigger>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Void &ldquo;{invoiceNumber}&rdquo;?</DialogTitle>
          <DialogDescription>
            This does <strong>not</strong> delete the invoice — the record stays visible,
            permanently marked as voided. A voided invoice can never receive a payment. This is
            only available for an invoice with no payments recorded against it, and cannot be
            undone.
          </DialogDescription>
        </DialogHeader>
        <form action={formAction} className="flex flex-col gap-4">
          <input type="hidden" name="businessId" value={businessId} />
          <input type="hidden" name="invoiceId" value={invoiceId} />

          {state?.error ? (
            <Alert variant="destructive" role="alert">
              <AlertDescription>{state.error}</AlertDescription>
            </Alert>
          ) : null}

          <DialogFooter>
            <SubmitButton>Void invoice</SubmitButton>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
