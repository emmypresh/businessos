"use client";

import { useActionState, useState } from "react";
import { inviteStaff } from "@/lib/staff/actions";
import { Label } from "@/components/ui/label";
import { Input } from "@/components/ui/input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { SubmitButton } from "@/components/auth/submit-button";
import { BranchAssignmentFields, type BranchPickerOption } from "@/components/staff/branch-assignment-fields";
import { ASSIGNABLE_ROLES } from "@/lib/staff/constants";

export function InviteStaffForm({ businessId, branches }: { businessId: string; branches: BranchPickerOption[] }) {
  const [state, formAction] = useActionState(inviteStaff, undefined);

  // Same mounted-intent pattern as every other Phase 1C–1F creation form
  // — generated ONCE at mount, stable across a corrected resubmission.
  const [creationKey] = useState(() => crypto.randomUUID());
  const [role, setRole] = useState<string>(ASSIGNABLE_ROLES[ASSIGNABLE_ROLES.length - 1]);

  return (
    <form action={formAction} data-testid="invite-staff-form" className="flex flex-col gap-6 max-w-2xl">
      <input type="hidden" name="businessId" value={businessId} />
      <input type="hidden" name="creationKey" value={creationKey} />
      <input type="hidden" name="role" value={role} />

      <div className="flex flex-col gap-2">
        <Label htmlFor="email">Email</Label>
        <Input
          id="email"
          name="email"
          type="email"
          placeholder="name@example.com"
          aria-invalid={!!state?.fieldErrors?.email}
          required
        />
        {state?.fieldErrors?.email ? (
          <p role="alert" className="text-sm text-destructive">
            {state.fieldErrors.email[0]}
          </p>
        ) : null}
      </div>

      <div className="flex flex-col gap-2">
        <Label htmlFor="role-select">Role</Label>
        <Select value={role} onValueChange={(value) => setRole(value ?? role)}>
          <SelectTrigger id="role-select" aria-invalid={!!state?.fieldErrors?.role}>
            <SelectValue placeholder="Choose a role" />
          </SelectTrigger>
          <SelectContent>
            {ASSIGNABLE_ROLES.map((r) => (
              <SelectItem key={r} value={r}>
                {r.charAt(0) + r.slice(1).toLowerCase()}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        {state?.fieldErrors?.role ? (
          <p role="alert" className="text-sm text-destructive">
            {state.fieldErrors.role[0]}
          </p>
        ) : null}
      </div>

      <BranchAssignmentFields
        branches={branches}
        error={state?.fieldErrors?.branchIds?.[0] ?? state?.fieldErrors?.primaryBranchId?.[0]}
      />

      {state?.error ? (
        <Alert variant="destructive" role="alert">
          <AlertDescription>{state.error}</AlertDescription>
        </Alert>
      ) : null}

      <SubmitButton>Send invitation</SubmitButton>
    </form>
  );
}
