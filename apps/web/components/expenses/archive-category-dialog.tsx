"use client";

import { useActionState } from "react";
import { archiveExpenseCategory } from "@/lib/expenses/actions";
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

export function ArchiveCategoryDialog({
  businessId,
  categoryId,
  categoryName,
}: {
  businessId: string;
  categoryId: string;
  categoryName: string;
}) {
  const [state, formAction] = useActionState(archiveExpenseCategory, undefined);

  return (
    <Dialog>
      <DialogTrigger render={<Button variant="destructive" size="sm" />}>Archive category</DialogTrigger>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Archive &ldquo;{categoryName}&rdquo;?</DialogTitle>
          <DialogDescription>
            Archived categories no longer appear when recording a new expense. Existing expenses
            that already use this category are unaffected — their category label never changes.
            This does not delete the category; it remains visible here as archived.
          </DialogDescription>
        </DialogHeader>
        <form action={formAction}>
          <input type="hidden" name="businessId" value={businessId} />
          <input type="hidden" name="categoryId" value={categoryId} />
          {state?.error ? (
            <Alert variant="destructive" role="alert" className="mb-4">
              <AlertDescription>{state.error}</AlertDescription>
            </Alert>
          ) : null}
          <DialogFooter>
            <SubmitButton>Archive</SubmitButton>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
