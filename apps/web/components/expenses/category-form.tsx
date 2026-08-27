"use client";

import { useActionState } from "react";
import { createExpenseCategory, updateExpenseCategory } from "@/lib/expenses/actions";
import { Label } from "@/components/ui/label";
import { Input } from "@/components/ui/input";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { SubmitButton } from "@/components/auth/submit-button";

type Mode = "create" | "edit";

// Narrow client-facing shape — only `id` (for the hidden categoryId
// field) and `name` (the editable value) are ever needed by this Client
// Component. The full ExpenseCategoryRow the server holds also carries
// business_id/created_by/created_at/updated_at, none of which this form
// (or the RSC boundary serializing props into it) has any reason to
// receive (Codex adversarial review, Finding 6).
export type CategoryFormValue = { id: string; name: string };

export function CategoryForm({
  mode,
  businessId,
  category,
}: {
  mode: Mode;
  businessId: string;
  category?: CategoryFormValue;
}) {
  const action = mode === "create" ? createExpenseCategory : updateExpenseCategory;
  const [state, formAction] = useActionState(action, undefined);

  return (
    <form action={formAction} data-testid="category-form" className="flex flex-col gap-4">
      <input type="hidden" name="businessId" value={businessId} />
      {mode === "edit" ? <input type="hidden" name="categoryId" value={category!.id} /> : null}

      <div className="flex flex-col gap-2">
        <Label htmlFor="category-name">Name</Label>
        <Input
          id="category-name"
          name="name"
          defaultValue={category?.name}
          aria-invalid={!!state?.fieldErrors?.name}
          required
        />
        {state?.fieldErrors?.name ? (
          <p role="alert" className="text-sm text-destructive">
            {state.fieldErrors.name[0]}
          </p>
        ) : null}
      </div>

      {state?.error ? (
        <Alert variant="destructive" role="alert">
          <AlertDescription>{state.error}</AlertDescription>
        </Alert>
      ) : null}

      <SubmitButton>{mode === "create" ? "Create category" : "Save changes"}</SubmitButton>
    </form>
  );
}
