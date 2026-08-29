"use client";

import { useActionState, useState } from "react";
import { changeMemberRole } from "@/lib/staff/actions";
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
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { SubmitButton } from "@/components/auth/submit-button";
import { ASSIGNABLE_ROLES } from "@/lib/staff/constants";

// Uses the exact same fixed role list every other Phase 1F role picker
// does (ASSIGNABLE_ROLES) — no custom role management exists or is
// invented here. The backend's own hierarchy checks
// (CANNOT_MANAGE_OWNER/CANNOT_ASSIGN_OWNER_ROLE/CANNOT_MANAGE_SELF/
// LAST_OWNER_REQUIRED) remain the final authority; this dialog does not
// try to predict or pre-empt them beyond the caller-visible convenience
// of not rendering the dialog trigger at all for a target the page
// already knows is impossible (see the staff detail page's own use of
// this component).
export function ChangeRoleDialog({
  businessId,
  memberId,
  currentRole,
}: {
  businessId: string;
  memberId: string;
  currentRole: string;
}) {
  const [state, formAction] = useActionState(changeMemberRole, undefined);
  const [role, setRole] = useState(currentRole);

  return (
    <Dialog>
      <DialogTrigger render={<Button variant="secondary" />}>Change role</DialogTrigger>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Change role</DialogTitle>
          <DialogDescription>Choose the new role for this staff member.</DialogDescription>
        </DialogHeader>
        <form action={formAction} className="flex flex-col gap-4">
          <input type="hidden" name="businessId" value={businessId} />
          <input type="hidden" name="memberId" value={memberId} />
          <input type="hidden" name="role" value={role} />

          <Select value={role} onValueChange={(value) => setRole(value ?? role)}>
            <SelectTrigger aria-invalid={!!state?.fieldErrors?.role} aria-describedby={state?.fieldErrors?.role ? "role-error" : undefined}>
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
          {/* Codex adversarial review, application-layer round 2, Low 4:
              CANNOT_ASSIGN_OWNER_ROLE (and any other role-scoped mapping)
              produces fieldErrors.role, not a top-level error — this was
              previously never rendered anywhere, so aria-invalid was set
              on the Select with no accompanying visible or accessible
              explanation of what was actually wrong. */}
          {state?.fieldErrors?.role ? (
            <p id="role-error" role="alert" className="text-sm text-destructive">
              {state.fieldErrors.role[0]}
            </p>
          ) : null}

          {state?.error ? (
            <Alert variant="destructive" role="alert">
              <AlertDescription>{state.error}</AlertDescription>
            </Alert>
          ) : null}

          <DialogFooter>
            <SubmitButton>Save role</SubmitButton>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
