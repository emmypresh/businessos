"use client";

import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { CategoryForm, type CategoryFormValue } from "@/components/expenses/category-form";

export function RenameCategoryDialog({
  businessId,
  category,
}: {
  businessId: string;
  // Narrow shape only — {id, name} — never the full ExpenseCategoryRow
  // (business_id/created_by/created_at/updated_at have no UI use here
  // and are never serialized across the RSC boundary into this Client
  // Component; Codex adversarial review, Finding 6).
  category: CategoryFormValue;
}) {
  return (
    <Dialog>
      <DialogTrigger render={<Button variant="outline" size="sm" />}>Rename</DialogTrigger>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Rename &ldquo;{category.name}&rdquo;</DialogTitle>
        </DialogHeader>
        <CategoryForm mode="edit" businessId={businessId} category={category} />
      </DialogContent>
    </Dialog>
  );
}
