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
import type { OperationalBranchOption } from "@/lib/branches/dal";
import { resolveBranchSelectLabel } from "@/lib/branches/select-label";

export function StockAdjustmentForm({
  businessId,
  products,
  branches,
  primaryBranchId,
  initialProductId,
}: {
  businessId: string;
  products: { id: string; name: string; sku: string | null }[];
  branches: OperationalBranchOption[];
  primaryBranchId: string | null;
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
  // Phase 1G: the branch IS the location choice for the caller — each
  // branch has exactly one canonical (is_branch_default) operational
  // location in the current architecture, so this stays a single Branch
  // select rather than a separate branch-then-location picker (see
  // lib/inventory/actions.ts's own comment on where the canonical
  // location is resolved). Preselected the same way every other
  // operational form defaults: the caller's own active primary branch, or
  // the one accessible branch if there's only one.
  const [branchId, setBranchId] = useState(
    primaryBranchId ?? (branches.length === 1 ? branches[0].id : "")
  );

  return (
    <form action={formAction} className="flex flex-col gap-4 max-w-md">
      <input type="hidden" name="businessId" value={businessId} />
      <input type="hidden" name="idempotencyKey" value={idempotencyKey} />
      <input type="hidden" name="productId" value={productId} />
      <input type="hidden" name="branchId" value={branchId} />

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

      {/* min-w-0: lets this item shrink below a 100-character branch
          name's intrinsic width instead of forcing the form wider than
          the viewport. Codex adversarial review, application-layer round
          2, Blocker 6. */}
      <div className="flex min-w-0 flex-col gap-2">
        <Label htmlFor="branch">Branch</Label>
        <Select value={branchId} onValueChange={(value) => setBranchId(value ?? "")}>
          <SelectTrigger
            id="branch"
            className="w-full min-w-0"
            aria-invalid={!!state?.fieldErrors?.branchId}
            aria-describedby={state?.fieldErrors?.branchId ? "adjust-branch-error" : undefined}
          >
            <SelectValue placeholder="Choose a branch">
              {(value: string) => resolveBranchSelectLabel(value, branches, { placeholder: "Choose a branch" })}
            </SelectValue>
          </SelectTrigger>
          <SelectContent>
            {branches.map((branch) => (
              <SelectItem key={branch.id} value={branch.id} className="max-w-full">
                <span className="truncate">
                  {branch.name}
                  {branch.isPrimary ? " (Primary)" : ""}
                </span>
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        {state?.fieldErrors?.branchId ? (
          <p id="adjust-branch-error" role="alert" className="text-sm text-destructive">
            {state.fieldErrors.branchId[0]}
          </p>
        ) : null}
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

      <SubmitButton disabled={!branchId}>Record adjustment</SubmitButton>
    </form>
  );
}
