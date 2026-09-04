"use client";

import { useActionState } from "react";
import { useFormStatus } from "react-dom";
import { CheckCheck, Loader2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { markAllNotificationsReadAction } from "@/lib/notifications/actions";

function SubmitButton() {
  const { pending } = useFormStatus();
  return (
    <Button type="submit" variant="outline" size="sm" disabled={pending} aria-busy={pending} data-testid="mark-all-read">
      {pending ? <Loader2 className="size-4 animate-spin" /> : <CheckCheck className="size-4" />}
      Mark all read
    </Button>
  );
}

// Business/user-scoped server-side (RLS + explicit business_id filter —
// see the action's own header comment) — this form never needs to know
// or pass a user id, and cannot affect another business the caller also
// belongs to.
export function MarkAllReadButton({ businessId }: { businessId: string }) {
  const [, formAction] = useActionState(markAllNotificationsReadAction, undefined);

  return (
    <form action={formAction}>
      <input type="hidden" name="businessId" value={businessId} />
      <SubmitButton />
    </form>
  );
}
