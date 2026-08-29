"use client";

import { useActionState } from "react";
import { useFormStatus } from "react-dom";
import { Loader2 } from "lucide-react";
import { setDefaultBranch, deactivateBranch, reactivateBranch } from "@/lib/branches/actions";
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

export function SetDefaultBranchDialog({ businessId, branchId, branchName }: { businessId: string; branchId: string; branchName: string }) {
  const [state, formAction] = useActionState(setDefaultBranch, undefined);

  return (
    <Dialog>
      <DialogTrigger render={<Button variant="secondary" />}>Set as default</DialogTrigger>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Set &ldquo;{branchName}&rdquo; as the default branch?</DialogTitle>
          <DialogDescription>
            The current default branch will no longer be marked as default. This does not affect
            existing staff branch assignments.
          </DialogDescription>
        </DialogHeader>
        <form action={formAction}>
          <input type="hidden" name="businessId" value={businessId} />
          <input type="hidden" name="branchId" value={branchId} />
          {state?.error ? (
            <Alert variant="destructive" role="alert" className="mb-4">
              <AlertDescription>{state.error}</AlertDescription>
            </Alert>
          ) : null}
          <DialogFooter>
            <SubmitButton>Set as default</SubmitButton>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

export function DeactivateBranchDialog({ businessId, branchId, branchName }: { businessId: string; branchId: string; branchName: string }) {
  const [state, formAction] = useActionState(deactivateBranch, undefined);

  return (
    <Dialog>
      <DialogTrigger render={<Button variant="destructive" />}>Deactivate</DialogTrigger>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Deactivate &ldquo;{branchName}&rdquo;?</DialogTitle>
          <DialogDescription>
            Staff can no longer be assigned to this branch while it&rsquo;s inactive. Existing
            assignments and historical records remain intact, and this can be reversed later.
          </DialogDescription>
        </DialogHeader>
        <form action={formAction}>
          <input type="hidden" name="businessId" value={businessId} />
          <input type="hidden" name="branchId" value={branchId} />
          {state?.error ? (
            <Alert variant="destructive" role="alert" className="mb-4">
              <AlertDescription>{state.error}</AlertDescription>
            </Alert>
          ) : null}
          <DialogFooter>
            <SubmitButton>Deactivate</SubmitButton>
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

// Reactivating is non-destructive (reversible instantly by deactivating
// again) and has no downstream consequence to warn about, unlike
// deactivation — a plain form action, no confirmation dialog, matching
// this app's own "destructive actions get a confirm, restorative ones
// don't" convention (e.g. reactivate_business_branch's own RPC-level
// header comment: "already active: no-op, not an error").
export function ReactivateBranchForm({ businessId, branchId }: { businessId: string; branchId: string }) {
  const [state, formAction] = useActionState(reactivateBranch, undefined);

  return (
    <form action={formAction} className="flex flex-col items-end gap-2">
      <input type="hidden" name="businessId" value={businessId} />
      <input type="hidden" name="branchId" value={branchId} />
      <ReactivateSubmit />
      {state?.error ? <p className="text-sm text-destructive">{state.error}</p> : null}
    </form>
  );
}
