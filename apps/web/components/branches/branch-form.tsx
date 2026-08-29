"use client";

import { useActionState, useState } from "react";
import { createBranch, updateBranch } from "@/lib/branches/actions";
import { Label } from "@/components/ui/label";
import { Input } from "@/components/ui/input";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { SubmitButton } from "@/components/auth/submit-button";
import type { BranchEditValues } from "@/lib/branches/dal";
import type { ActionState } from "@/lib/auth/actions";

type Mode = "create" | "edit";

// Codex adversarial review, application-layer round 2, Low 4: every field
// that can receive a Zod/RPC field error must actually render it —
// city/state/addressLine1/addressLine2 previously had no aria-invalid, no
// aria-describedby, and no visible error text at all, so an overlong
// address or a RPC-mapped INVALID_BRANCH_ADDRESS was silently invisible.
// One small helper keeps every field's error markup identical (id,
// role="alert", aria-describedby wiring) rather than four subtly
// different copies.
function FieldError({ id, message }: { id: string; message?: string }) {
  if (!message) return null;
  return (
    <p id={id} role="alert" className="text-sm text-destructive">
      {message}
    </p>
  );
}

function errorProps(state: ActionState, field: string) {
  const message = state?.fieldErrors?.[field]?.[0];
  const errorId = `${field}-error`;
  return {
    "aria-invalid": !!message,
    "aria-describedby": message ? errorId : undefined,
    message,
    errorId,
  };
}

export function BranchForm({
  mode,
  businessId,
  branch,
}: {
  mode: Mode;
  businessId: string;
  branch?: BranchEditValues;
}) {
  const action = mode === "create" ? createBranch : updateBranch;
  const [state, formAction] = useActionState(action, undefined);

  // Same mounted-intent pattern as ProductForm/ExpenseForm — generated
  // ONCE at mount, stable across a corrected resubmission, never
  // regenerated on re-render.
  const [creationKey] = useState(() => crypto.randomUUID());

  const name = errorProps(state, "name");
  const code = errorProps(state, "code");
  const phone = errorProps(state, "phone");
  const addressLine1 = errorProps(state, "addressLine1");
  const addressLine2 = errorProps(state, "addressLine2");
  const city = errorProps(state, "city");
  const state_ = errorProps(state, "state");
  const countryCode = errorProps(state, "countryCode");

  return (
    <form action={formAction} data-testid="branch-form" className="flex flex-col gap-6 max-w-2xl">
      <input type="hidden" name="businessId" value={businessId} />
      {mode === "create" ? (
        <input type="hidden" name="creationKey" value={creationKey} />
      ) : (
        <input type="hidden" name="branchId" value={branch!.id} />
      )}

      <div className="grid gap-4 sm:grid-cols-2">
        <div className="flex flex-col gap-2 sm:col-span-2">
          <Label htmlFor="name">Branch name</Label>
          <Input
            id="name"
            name="name"
            defaultValue={branch?.name}
            aria-invalid={name["aria-invalid"]}
            aria-describedby={name["aria-describedby"]}
            required
          />
          <FieldError id={name.errorId} message={name.message} />
        </div>

        <div className="flex flex-col gap-2">
          <Label htmlFor="code">Code (optional)</Label>
          <Input
            id="code"
            name="code"
            placeholder="e.g. BR-01"
            defaultValue={branch?.code ?? ""}
            aria-invalid={code["aria-invalid"]}
            aria-describedby={code["aria-describedby"]}
          />
          <FieldError id={code.errorId} message={code.message} />
        </div>

        <div className="flex flex-col gap-2">
          <Label htmlFor="phone">Phone (optional)</Label>
          <Input
            id="phone"
            name="phone"
            defaultValue={branch?.phone ?? ""}
            aria-invalid={phone["aria-invalid"]}
            aria-describedby={phone["aria-describedby"]}
          />
          <FieldError id={phone.errorId} message={phone.message} />
        </div>

        <div className="flex flex-col gap-2 sm:col-span-2">
          <Label htmlFor="addressLine1">Address line 1</Label>
          <Input
            id="addressLine1"
            name="addressLine1"
            defaultValue={branch?.address_line1 ?? ""}
            aria-invalid={addressLine1["aria-invalid"]}
            aria-describedby={addressLine1["aria-describedby"]}
          />
          <FieldError id={addressLine1.errorId} message={addressLine1.message} />
        </div>

        <div className="flex flex-col gap-2 sm:col-span-2">
          <Label htmlFor="addressLine2">Address line 2</Label>
          <Input
            id="addressLine2"
            name="addressLine2"
            defaultValue={branch?.address_line2 ?? ""}
            aria-invalid={addressLine2["aria-invalid"]}
            aria-describedby={addressLine2["aria-describedby"]}
          />
          <FieldError id={addressLine2.errorId} message={addressLine2.message} />
        </div>

        <div className="flex flex-col gap-2">
          <Label htmlFor="city">City</Label>
          <Input
            id="city"
            name="city"
            defaultValue={branch?.city ?? ""}
            aria-invalid={city["aria-invalid"]}
            aria-describedby={city["aria-describedby"]}
          />
          <FieldError id={city.errorId} message={city.message} />
        </div>

        <div className="flex flex-col gap-2">
          <Label htmlFor="state">State</Label>
          <Input
            id="state"
            name="state"
            defaultValue={branch?.state ?? ""}
            aria-invalid={state_["aria-invalid"]}
            aria-describedby={state_["aria-describedby"]}
          />
          <FieldError id={state_.errorId} message={state_.message} />
        </div>

        <div className="flex flex-col gap-2">
          <Label htmlFor="countryCode">Country code</Label>
          <Input
            id="countryCode"
            name="countryCode"
            maxLength={2}
            placeholder="NG"
            defaultValue={branch?.country_code ?? "NG"}
            aria-invalid={countryCode["aria-invalid"]}
            aria-describedby={countryCode["aria-describedby"]}
            className="uppercase"
          />
          <FieldError id={countryCode.errorId} message={countryCode.message} />
        </div>
      </div>

      {state?.error ? (
        <Alert variant="destructive" role="alert">
          <AlertDescription>{state.error}</AlertDescription>
        </Alert>
      ) : null}

      <SubmitButton>{mode === "create" ? "Create branch" : "Save changes"}</SubmitButton>
    </form>
  );
}
