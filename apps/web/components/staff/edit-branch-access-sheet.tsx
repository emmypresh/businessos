"use client";

import { useActionState, useState } from "react";
import { useFormStatus } from "react-dom";
import { Loader2 } from "lucide-react";
import { replaceMemberBranches } from "@/lib/staff/actions";
import { Button } from "@/components/ui/button";
import {
  Sheet,
  SheetContent,
  SheetHeader,
  SheetTitle,
  SheetDescription,
  SheetFooter,
  SheetTrigger,
  SheetClose,
} from "@/components/ui/sheet";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { BranchAssignmentFields, type BranchPickerOption } from "@/components/staff/branch-assignment-fields";
import type { BranchAssignment } from "@/lib/staff/dal";

// Not components/auth/submit-button.tsx's SubmitButton — that one is
// hardcoded w-full, which reads oddly paired with a "Cancel" button in a
// two-button footer row like this one.
function SaveButton() {
  const { pending } = useFormStatus();
  return (
    <Button type="submit" disabled={pending} aria-busy={pending}>
      {pending ? <Loader2 className="size-4 animate-spin" /> : "Save access"}
    </Button>
  );
}

export function EditBranchAccessSheet({
  businessId,
  memberId,
  branches,
  currentAssignments,
}: {
  businessId: string;
  memberId: string;
  branches: BranchPickerOption[];
  currentAssignments: BranchAssignment[];
}) {
  const [state, formAction] = useActionState(replaceMemberBranches, undefined);
  const [open, setOpen] = useState(false);

  return (
    <Sheet open={open} onOpenChange={setOpen}>
      <SheetTrigger render={<Button variant="secondary" />}>Edit branch access</SheetTrigger>
      <SheetContent side="right" className="w-full max-w-md overflow-y-auto p-6">
        <SheetHeader className="px-0">
          <SheetTitle>Edit branch access</SheetTitle>
          <SheetDescription>
            Choose which branches this staff member can operate at, and which one is their primary.
          </SheetDescription>
        </SheetHeader>
        <form action={formAction} className="flex flex-col gap-6 pt-4">
          <input type="hidden" name="businessId" value={businessId} />
          <input type="hidden" name="memberId" value={memberId} />

          <BranchAssignmentFields
            branches={branches}
            defaultSelectedIds={currentAssignments.map((a) => a.branch_id)}
            defaultPrimaryId={currentAssignments.find((a) => a.is_primary)?.branch_id}
            error={state?.fieldErrors?.branchIds?.[0] ?? state?.fieldErrors?.primaryBranchId?.[0]}
          />

          {state?.error ? (
            <Alert variant="destructive" role="alert">
              <AlertDescription>{state.error}</AlertDescription>
            </Alert>
          ) : null}

          <SheetFooter className="flex-row justify-end gap-2 px-0">
            <SheetClose render={<Button type="button" variant="outline" />}>Cancel</SheetClose>
            <SaveButton />
          </SheetFooter>
        </form>
      </SheetContent>
    </Sheet>
  );
}
