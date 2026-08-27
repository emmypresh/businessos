"use client";

import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { CategoryForm } from "@/components/expenses/category-form";

export function CreateCategoryDialog({ businessId }: { businessId: string }) {
  return (
    <Dialog>
      <DialogTrigger render={<Button />}>New category</DialogTrigger>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>New expense category</DialogTitle>
        </DialogHeader>
        <CategoryForm mode="create" businessId={businessId} />
      </DialogContent>
    </Dialog>
  );
}
