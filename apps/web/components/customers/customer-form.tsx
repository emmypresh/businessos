"use client";

import { useActionState, useState } from "react";
import { createCustomer, updateCustomer } from "@/lib/customers/actions";
import { Label } from "@/components/ui/label";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { SubmitButton } from "@/components/auth/submit-button";
import type { CustomerRow } from "@/lib/customers/dal";

type Mode = "create" | "edit";

export function CustomerForm({
  mode,
  businessId,
  customer,
}: {
  mode: Mode;
  businessId: string;
  customer?: CustomerRow;
}) {
  const action = mode === "create" ? createCustomer : updateCustomer;
  const [state, formAction] = useActionState(action, undefined);

  // Generated ONCE, at mount — never regenerated on re-render. Stable
  // across a failed submission (the component stays mounted, so a
  // corrected resubmission reuses the same key), fresh only when a new
  // instance of this form mounts. Matches the approved Phase 1C
  // mounted-intent pattern exactly (components/products/product-form.tsx).
  const [creationKey] = useState(() => crypto.randomUUID());
  const [status, setStatus] = useState(customer?.status ?? "active");

  return (
    <form action={formAction} data-testid="customer-form" className="flex flex-col gap-6 max-w-2xl">
      <input type="hidden" name="businessId" value={businessId} />
      {mode === "create" ? (
        <input type="hidden" name="creationKey" value={creationKey} />
      ) : (
        <>
          <input type="hidden" name="customerId" value={customer!.id} />
          <input type="hidden" name="status" value={status} />
        </>
      )}

      <div className="grid gap-4 sm:grid-cols-2">
        <div className="flex flex-col gap-2 sm:col-span-2">
          <Label htmlFor="name">Name</Label>
          <Input
            id="name"
            name="name"
            defaultValue={customer?.name}
            aria-invalid={!!state?.fieldErrors?.name}
            required
          />
          {state?.fieldErrors?.name ? (
            <p role="alert" className="text-sm text-destructive">
              {state.fieldErrors.name[0]}
            </p>
          ) : null}
        </div>

        <div className="flex flex-col gap-2">
          <Label htmlFor="phone">Phone</Label>
          <Input
            id="phone"
            name="phone"
            type="tel"
            defaultValue={customer?.phone ?? ""}
            aria-invalid={!!state?.fieldErrors?.phone}
          />
          {state?.fieldErrors?.phone ? (
            <p role="alert" className="text-sm text-destructive">
              {state.fieldErrors.phone[0]}
            </p>
          ) : null}
        </div>

        <div className="flex flex-col gap-2">
          <Label htmlFor="email">Email</Label>
          <Input
            id="email"
            name="email"
            type="email"
            defaultValue={customer?.email ?? ""}
            aria-invalid={!!state?.fieldErrors?.email}
          />
          {state?.fieldErrors?.email ? (
            <p role="alert" className="text-sm text-destructive">
              {state.fieldErrors.email[0]}
            </p>
          ) : null}
        </div>

        <div className="flex flex-col gap-2 sm:col-span-2">
          <Label htmlFor="address">Address</Label>
          <Textarea
            id="address"
            name="address"
            defaultValue={customer?.address ?? ""}
            rows={2}
            aria-invalid={!!state?.fieldErrors?.address}
          />
          {state?.fieldErrors?.address ? (
            <p role="alert" className="text-sm text-destructive">
              {state.fieldErrors.address[0]}
            </p>
          ) : null}
        </div>

        <div className="flex flex-col gap-2 sm:col-span-2">
          <Label htmlFor="notes">Notes</Label>
          <Textarea
            id="notes"
            name="notes"
            defaultValue={customer?.notes ?? ""}
            rows={3}
            aria-invalid={!!state?.fieldErrors?.notes}
          />
          {state?.fieldErrors?.notes ? (
            <p role="alert" className="text-sm text-destructive">
              {state.fieldErrors.notes[0]}
            </p>
          ) : null}
        </div>

        {mode === "edit" ? (
          <div className="flex flex-col gap-2">
            <Label htmlFor="status">Status</Label>
            <Select value={status} onValueChange={(value) => setStatus(value ?? "active")}>
              <SelectTrigger id="status">
                <SelectValue placeholder="Status" />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="active">Active</SelectItem>
                <SelectItem value="inactive">Inactive</SelectItem>
                <SelectItem value="archived">Archived</SelectItem>
              </SelectContent>
            </Select>
          </div>
        ) : null}
      </div>

      {state?.error ? (
        <Alert variant="destructive" role="alert">
          <AlertDescription>{state.error}</AlertDescription>
        </Alert>
      ) : null}

      <SubmitButton>{mode === "create" ? "Create customer" : "Save changes"}</SubmitButton>
    </form>
  );
}
