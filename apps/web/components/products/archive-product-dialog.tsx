"use client";

import { useActionState } from "react";
import { archiveProduct } from "@/lib/products/actions";
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

export function ArchiveProductDialog({
  businessId,
  productId,
  productName,
}: {
  businessId: string;
  productId: string;
  productName: string;
}) {
  const [state, formAction] = useActionState(archiveProduct, undefined);

  return (
    <Dialog>
      <DialogTrigger render={<Button variant="destructive" />}>Archive product</DialogTrigger>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Archive &ldquo;{productName}&rdquo;?</DialogTitle>
          <DialogDescription>
            Archived products no longer appear in active listings and cannot be adjusted. This can
            be reversed later by editing the product&rsquo;s status.
          </DialogDescription>
        </DialogHeader>
        <form action={formAction}>
          <input type="hidden" name="businessId" value={businessId} />
          <input type="hidden" name="productId" value={productId} />
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
