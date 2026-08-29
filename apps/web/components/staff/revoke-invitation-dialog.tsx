"use client";

import { useActionState } from "react";
import { revokeInvitation } from "@/lib/staff/actions";
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

export function RevokeInvitationDialog({ businessId, invitationId }: { businessId: string; invitationId: string }) {
  const [state, formAction] = useActionState(revokeInvitation, undefined);

  return (
    <Dialog>
      <DialogTrigger render={<Button variant="ghost" size="sm" />}>Revoke</DialogTrigger>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Revoke invitation?</DialogTitle>
          <DialogDescription>This person will no longer be able to join using this invitation.</DialogDescription>
        </DialogHeader>
        <form action={formAction}>
          <input type="hidden" name="businessId" value={businessId} />
          <input type="hidden" name="invitationId" value={invitationId} />
          {state?.error ? (
            <Alert variant="destructive" role="alert" className="mb-4">
              <AlertDescription>{state.error}</AlertDescription>
            </Alert>
          ) : null}
          <DialogFooter>
            <SubmitButton>Revoke</SubmitButton>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
