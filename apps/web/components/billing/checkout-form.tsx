"use client";

import { useActionState } from "react";
import { initCheckoutAction } from "@/lib/billing/actions";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { SubmitButton } from "@/components/auth/submit-button";

// Each price this business is eligible for renders as its own tiny form
// — a plain POST to a Server Action that itself redirects the browser to
// Paystack's hosted checkout page on success (see lib/billing/actions.ts).
// No client-side fetch, no checkout URL ever held in React state.
export function CheckoutForm({
  businessId,
  priceId,
  label,
}: {
  businessId: string;
  priceId: string;
  label: string;
}) {
  const [state, formAction] = useActionState(initCheckoutAction, undefined);

  return (
    <form action={formAction} className="flex flex-col gap-2 rounded-lg border p-4">
      <input type="hidden" name="businessId" value={businessId} />
      <input type="hidden" name="priceId" value={priceId} />
      <div className="flex items-center justify-between gap-4">
        <span className="text-sm font-medium">{label}</span>
        <SubmitButton>Subscribe</SubmitButton>
      </div>
      {state?.error ? (
        <Alert variant="destructive" role="alert">
          <AlertDescription>{state.error}</AlertDescription>
        </Alert>
      ) : null}
    </form>
  );
}
