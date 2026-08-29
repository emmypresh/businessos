"use client";

import { useActionState } from "react";
import { acceptInvitation } from "@/lib/staff/actions";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { SubmitButton } from "@/components/auth/submit-button";

export function AcceptInvitationForm({ invitationId }: { invitationId: string }) {
  const [state, formAction] = useActionState(acceptInvitation, undefined);

  return (
    <form action={formAction} data-testid="accept-invitation-form" className="flex flex-col gap-4">
      <input type="hidden" name="invitationId" value={invitationId} />
      {state?.error ? (
        <Alert variant="destructive" role="alert">
          <AlertDescription>{state.error}</AlertDescription>
        </Alert>
      ) : null}
      <SubmitButton>Accept invitation</SubmitButton>
    </form>
  );
}
