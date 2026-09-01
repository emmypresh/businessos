"use client";

import { useActionState, useState } from "react";
import { recordInvoicePayment } from "@/lib/invoices/actions";
import {
  Sheet,
  SheetTrigger,
  SheetContent,
  SheetHeader,
  SheetTitle,
  SheetDescription,
  SheetFooter,
} from "@/components/ui/sheet";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { SubmitButton } from "@/components/auth/submit-button";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { formatMoney } from "@/lib/currency";
import { PAYMENT_METHOD, PAYMENT_METHOD_LABEL, type PaymentMethod } from "@/lib/invoices/constants";

function toLocalDatetimeInputValue(date: Date): string {
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}T${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

export function PaymentForm({
  businessId,
  invoiceId,
  balance,
}: {
  businessId: string;
  invoiceId: string;
  balance: number;
}) {
  const [state, formAction] = useActionState(recordInvoicePayment, undefined);
  const [creationKey] = useState(() => crypto.randomUUID());
  // Defaults to the FULL remaining balance — the common case (a customer
  // paying off what they owe) — but is a plain editable input, never
  // locked to that value; the server validates whatever the caller
  // actually submits regardless of this default.
  const [amount, setAmount] = useState(balance.toFixed(2));
  const [paymentMethod, setPaymentMethod] = useState<PaymentMethod>(PAYMENT_METHOD.CASH);
  const [paidAtLocal, setPaidAtLocal] = useState(() => toLocalDatetimeInputValue(new Date()));

  const amountNumber = Number(amount);
  const previewBalance = Number.isFinite(amountNumber) ? Math.max(0, balance - amountNumber) : balance;

  // The browser's OWN local-to-UTC conversion, computed here client-side
  // from the visible datetime-local value — mirrors
  // components/expenses/expense-form.tsx's own identical incurredAtIso
  // pattern exactly. Codex adversarial review, remediation round 1,
  // Medium 5: this used to be deferred to the SERVER
  // (`new Date(parsed.data.paidAt).toISOString()` in
  // lib/invoices/actions.ts), which parses a bare datetime-local value
  // against the SERVER's own runtime timezone, not the submitting user's
  // — silently shifting the recorded instant whenever the two differ
  // (e.g. a Lagos-based user, a UTC-deployed server). Converting here,
  // in the browser, uses the ACTUAL local timezone the user is sitting
  // in (whatever that is — this generalizes correctly to any timezone,
  // DST included, unlike a hardcoded fixed-offset conversion), and the
  // resulting ISO string (carrying an explicit `Z`) is what's actually
  // submitted as `paidAt` — the server never re-parses or re-derives it.
  const paidAtIso =
    paidAtLocal && !Number.isNaN(new Date(paidAtLocal).getTime()) ? new Date(paidAtLocal).toISOString() : "";

  return (
    <Sheet>
      <SheetTrigger render={<Button />}>Record payment</SheetTrigger>
      <SheetContent>
        <SheetHeader>
          <SheetTitle>Record payment</SheetTitle>
          <SheetDescription>
            Outstanding balance: <strong>{formatMoney(balance, "NGN")}</strong>
          </SheetDescription>
        </SheetHeader>
        <form action={formAction} className="flex flex-col gap-4 px-4">
          <input type="hidden" name="businessId" value={businessId} />
          <input type="hidden" name="invoiceId" value={invoiceId} />
          <input type="hidden" name="creationKey" value={creationKey} />
          <input type="hidden" name="paidAt" value={paidAtIso} />

          <div className="flex flex-col gap-2">
            <Label htmlFor="amount">Amount</Label>
            <Input
              id="amount"
              name="amount"
              inputMode="decimal"
              value={amount}
              onChange={(e) => setAmount(e.target.value)}
              aria-invalid={!!state?.fieldErrors?.amount}
              // Codex adversarial review, remediation round 1, Low 3: this
              // was a static "amount-preview" reference regardless of
              // whether an error was present — an error, when shown,
              // must ALSO be in the describedby chain, not silently
              // dropped in favor of the preview hint.
              aria-describedby={state?.fieldErrors?.amount ? "amount-preview amount-error" : "amount-preview"}
              required
            />
            <p id="amount-preview" className="text-xs text-muted-foreground">
              Balance after this payment: {formatMoney(previewBalance, "NGN")} (estimated)
            </p>
            {state?.fieldErrors?.amount ? (
              <p id="amount-error" role="alert" className="text-sm text-destructive">
                {state.fieldErrors.amount[0]}
              </p>
            ) : null}
          </div>

          <div className="flex flex-col gap-2">
            <Label htmlFor="paymentMethod">Method</Label>
            <Select value={paymentMethod} onValueChange={(v) => setPaymentMethod((v ?? PAYMENT_METHOD.CASH) as PaymentMethod)}>
              <SelectTrigger
                id="paymentMethod"
                className="w-full"
                aria-invalid={!!state?.fieldErrors?.paymentMethod}
                aria-describedby={state?.fieldErrors?.paymentMethod ? "paymentMethod-error" : undefined}
              >
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {Object.entries(PAYMENT_METHOD_LABEL).map(([value, label]) => (
                  <SelectItem key={value} value={value}>
                    {label}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            <input type="hidden" name="paymentMethod" value={paymentMethod} />
            {state?.fieldErrors?.paymentMethod ? (
              <p id="paymentMethod-error" role="alert" className="text-sm text-destructive">
                {state.fieldErrors.paymentMethod[0]}
              </p>
            ) : null}
          </div>

          <div className="flex flex-col gap-2">
            <Label htmlFor="paidAt">Paid at</Label>
            <Input
              id="paidAt"
              type="datetime-local"
              value={paidAtLocal}
              onChange={(e) => setPaidAtLocal(e.target.value)}
              max={toLocalDatetimeInputValue(new Date())}
              aria-invalid={!!state?.fieldErrors?.paidAt}
              aria-describedby={state?.fieldErrors?.paidAt ? "paidAt-error" : undefined}
              required
            />
            {state?.fieldErrors?.paidAt ? (
              <p id="paidAt-error" role="alert" className="text-sm text-destructive">
                {state.fieldErrors.paidAt[0]}
              </p>
            ) : null}
          </div>

          <div className="flex flex-col gap-2">
            <Label htmlFor="reference">Reference (optional)</Label>
            <Input
              id="reference"
              name="reference"
              aria-invalid={!!state?.fieldErrors?.reference}
              aria-describedby={state?.fieldErrors?.reference ? "reference-error" : undefined}
            />
            {state?.fieldErrors?.reference ? (
              <p id="reference-error" role="alert" className="text-sm text-destructive">
                {state.fieldErrors.reference[0]}
              </p>
            ) : null}
          </div>

          <div className="flex flex-col gap-2">
            <Label htmlFor="note">Note (optional)</Label>
            <Textarea
              id="note"
              name="note"
              rows={2}
              aria-invalid={!!state?.fieldErrors?.note}
              aria-describedby={state?.fieldErrors?.note ? "note-error" : undefined}
            />
            {state?.fieldErrors?.note ? (
              <p id="note-error" role="alert" className="text-sm text-destructive">
                {state.fieldErrors.note[0]}
              </p>
            ) : null}
          </div>

          {state?.error ? (
            <Alert variant="destructive" role="alert">
              <AlertDescription>{state.error}</AlertDescription>
            </Alert>
          ) : null}

          <SheetFooter className="px-0">
            <SubmitButton>Confirm payment</SubmitButton>
          </SheetFooter>
        </form>
      </SheetContent>
    </Sheet>
  );
}
