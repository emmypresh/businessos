"use client";

import { useActionState, useState } from "react";
import { adjustStock } from "@/lib/inventory/actions";
import { Label } from "@/components/ui/label";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { RadioGroup, RadioGroupItem } from "@/components/ui/radio-group";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { SubmitButton } from "@/components/auth/submit-button";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";

export function StockAdjustmentForm({
  businessId,
  products,
  defaultLocationName,
  initialProductId,
}: {
  businessId: string;
  products: { id: string; name: string; sku: string | null }[];
  defaultLocationName: string;
  initialProductId?: string;
}) {
  const [state, formAction] = useActionState(adjustStock, undefined);

  // Generated once at mount, stable across a failed-submission retry,
  // fresh only when this component remounts (which a successful
  // adjustment guarantees, via the Server Action's redirect() — see
  // lib/inventory/actions.ts's own comment on why a redirect, not an
  // in-place reset, is what makes "one mounted form can never perform
  // two independent adjustments under one key" hold).
  const [idempotencyKey] = useState(() => crypto.randomUUID());
  const [productId, setProductId] = useState(initialProductId ?? "");

  return (
    <form action={formAction} className="flex flex-col gap-4 max-w-md">
      <input type="hidden" name="businessId" value={businessId} />
      <input type="hidden" name="idempotencyKey" value={idempotencyKey} />
      <input type="hidden" name="productId" value={productId} />

      <div className="flex flex-col gap-2">
        <Label htmlFor="product">Product</Label>
        <Select value={productId} onValueChange={(value) => setProductId(value ?? "")}>
          <SelectTrigger id="product">
            <SelectValue placeholder="Select a product" />
          </SelectTrigger>
          <SelectContent>
            {products.map((product) => (
              <SelectItem key={product.id} value={product.id}>
                {product.name}
                {product.sku ? ` (${product.sku})` : ""}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        {state?.fieldErrors?.productId ? (
          <p role="alert" className="text-sm text-destructive">
            {state.fieldErrors.productId[0]}
          </p>
        ) : null}
      </div>

      <div className="flex flex-col gap-2">
        <Label>Location</Label>
        {/* Static, not a picker — Phase 1C has one implicit default
            location per business; this becomes a real Select once a
            multi-location phase exists. */}
        <p className="text-sm text-muted-foreground">{defaultLocationName}</p>
      </div>

      <div className="flex flex-col gap-2">
        <Label>Direction</Label>
        <RadioGroup name="direction" defaultValue="increase" className="flex gap-4">
          <div className="flex items-center gap-2">
            <RadioGroupItem value="increase" id="increase" />
            <Label htmlFor="increase" className="font-normal">
              Increase stock
            </Label>
          </div>
          <div className="flex items-center gap-2">
            <RadioGroupItem value="decrease" id="decrease" />
            <Label htmlFor="decrease" className="font-normal">
              Decrease stock
            </Label>
          </div>
        </RadioGroup>
      </div>

      <div className="flex flex-col gap-2">
        <Label htmlFor="quantity">Quantity</Label>
        <Input
          id="quantity"
          name="quantity"
          type="number"
          step="0.001"
          min="0"
          aria-invalid={!!state?.fieldErrors?.quantity}
          required
        />
        {state?.fieldErrors?.quantity ? (
          <p role="alert" className="text-sm text-destructive">
            {state.fieldErrors.quantity[0]}
          </p>
        ) : null}
      </div>

      <div className="flex flex-col gap-2">
        <Label htmlFor="reason">Reason</Label>
        <Input id="reason" name="reason" aria-invalid={!!state?.fieldErrors?.reason} required />
        {state?.fieldErrors?.reason ? (
          <p role="alert" className="text-sm text-destructive">
            {state.fieldErrors.reason[0]}
          </p>
        ) : null}
      </div>

      <div className="flex flex-col gap-2">
        <Label htmlFor="note">Note (optional)</Label>
        <Textarea id="note" name="note" rows={2} />
      </div>

      {state?.error ? (
        <Alert variant="destructive" role="alert">
          <AlertDescription>{state.error}</AlertDescription>
        </Alert>
      ) : null}

      <SubmitButton>Record adjustment</SubmitButton>
    </form>
  );
}
