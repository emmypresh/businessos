"use client";

import { useActionState } from "react";
import { useFormStatus } from "react-dom";
import { Loader2 } from "lucide-react";
import { suspendMember, reactivateMember } from "@/lib/staff/actions";
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

export function SuspendMemberDialog({ businessId, memberId }: { businessId: string; memberId: string }) {
  const [state, formAction] = useActionState(suspendMember, undefined);

  return (
    <Dialog>
      <DialogTrigger render={<Button variant="destructive" />}>Suspend</DialogTrigger>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Suspend this staff member?</DialogTitle>
          <DialogDescription>
            The staff member will lose access to BusinessOS for this business. Historical records
            remain intact, and this can be reversed at any time.
          </DialogDescription>
        </DialogHeader>
        <form action={formAction}>
          <input type="hidden" name="businessId" value={businessId} />
          <input type="hidden" name="memberId" value={memberId} />
          {state?.error ? (
            <Alert variant="destructive" role="alert" className="mb-4">
              <AlertDescription>{state.error}</AlertDescription>
            </Alert>
          ) : null}
          <DialogFooter>
            <SubmitButton>Suspend</SubmitButton>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

function ReactivateSubmit() {
  const { pending } = useFormStatus();
  return (
    <Button type="submit" variant="secondary" disabled={pending} aria-busy={pending}>
      {pending ? <Loader2 className="size-4 animate-spin" /> : "Reactivate"}
    </Button>
  );
}

// Non-destructive/restorative — no confirmation dialog, matching this
// app's own "destructive gets a confirm, restorative doesn't" convention
// (see components/branches/branch-actions.tsx's ReactivateBranchForm).
// Reactivating preserves the member's existing role and branch
// assignments untouched — reactivate_member's own RPC body never touches
// role_id or business_member_branches at all, only status.
export function ReactivateMemberForm({ businessId, memberId }: { businessId: string; memberId: string }) {
  const [state, formAction] = useActionState(reactivateMember, undefined);

  return (
    <form action={formAction} className="flex flex-col items-end gap-2">
      <input type="hidden" name="businessId" value={businessId} />
      <input type="hidden" name="memberId" value={memberId} />
      <ReactivateSubmit />
      {state?.error ? <p className="text-sm text-destructive">{state.error}</p> : null}
    </form>
  );
}
