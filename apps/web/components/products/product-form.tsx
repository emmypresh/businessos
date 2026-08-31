"use client";

import { useActionState, useState } from "react";
import { createProduct, updateProduct } from "@/lib/products/actions";
import { Label } from "@/components/ui/label";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { SubmitButton } from "@/components/auth/submit-button";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import type { ProductRow } from "@/lib/products/dal";
import type { OperationalBranchOption } from "@/lib/branches/dal";
import { resolveBranchSelectLabel } from "@/lib/branches/select-label";
import { NoActiveBranchState } from "@/components/branches/no-active-branch-state";

type Mode = "create" | "edit";

export function ProductForm({
  mode,
  businessId,
  product,
  canSeeCost,
  branches = [],
  primaryBranchId = null,
}: {
  mode: Mode;
  businessId: string;
  product?: ProductRow;
  canSeeCost: boolean;
  // Create mode only — an opening-stock branch selector has no meaning
  // when editing an already-existing product (opening stock is a
  // one-time, creation-only concept; see create_product's own comment).
  branches?: OperationalBranchOption[];
  primaryBranchId?: string | null;
}) {
  const action = mode === "create" ? createProduct : updateProduct;
  const [state, formAction] = useActionState(action, undefined);

  // Generated ONCE, at mount — never regenerated on re-render. Stable
  // across a failed submission (the component stays mounted, so a
  // corrected resubmission reuses the same key), fresh only when a new
  // instance of this form mounts (a genuinely new attempt). A rolled-back
  // attempt (any failure) never left a committed claim on this key, so a
  // corrected resubmission is safely treated as a fresh one, not a
  // conflict — see lib/products/actions.ts / the database's own design.
  const [creationKey] = useState(() => crypto.randomUUID());

  const [trackInventory, setTrackInventory] = useState(product?.track_inventory ?? true);
  // Phase 1G: opening stock is branch-aware — the branch selector only
  // ever appears once a POSITIVE quantity is entered (a zero/empty opening
  // quantity requires no branch/location at all, matching create_product's
  // own "opening only bundles a movement when p_opening_quantity > 0"
  // behavior exactly — see lib/products/actions.ts). Kept as a live-typed
  // string, mirroring every other numeric form field in this app.
  const [openingQuantity, setOpeningQuantity] = useState("");
  const [branchId, setBranchId] = useState(
    primaryBranchId ?? (branches.length === 1 ? branches[0].id : "")
  );
  const needsBranch = trackInventory && Number(openingQuantity) > 0;

  return (
    <form action={formAction} data-testid="product-form" className="flex flex-col gap-6 max-w-2xl">
      <input type="hidden" name="businessId" value={businessId} />
      {mode === "create" ? (
        <input type="hidden" name="creationKey" value={creationKey} />
      ) : (
        <input type="hidden" name="productId" value={product!.id} />
      )}

      <div className="grid gap-4 sm:grid-cols-2">
        <div className="flex flex-col gap-2 sm:col-span-2">
          <Label htmlFor="name">Name</Label>
          <Input
            id="name"
            name="name"
            defaultValue={product?.name}
            aria-invalid={!!state?.fieldErrors?.name}
            required
          />
          {state?.fieldErrors?.name ? (
            <p role="alert" className="text-sm text-destructive">
              {state.fieldErrors.name[0]}
            </p>
          ) : null}
        </div>

        <div className="flex flex-col gap-2 sm:col-span-2">
          <Label htmlFor="description">Description</Label>
          <Textarea id="description" name="description" defaultValue={product?.description ?? ""} rows={3} />
        </div>

        <div className="flex flex-col gap-2">
          <Label htmlFor="sku">SKU {trackInventory ? <span className="text-destructive">*</span> : null}</Label>
          <Input
            id="sku"
            name="sku"
            defaultValue={product?.sku ?? ""}
            aria-invalid={!!state?.fieldErrors?.sku}
          />
          {state?.fieldErrors?.sku ? (
            <p role="alert" className="text-sm text-destructive">
              {state.fieldErrors.sku[0]}
            </p>
          ) : null}
        </div>

        <div className="flex flex-col gap-2">
          <Label htmlFor="barcode">Barcode</Label>
          <Input
            id="barcode"
            name="barcode"
            defaultValue={product?.barcode ?? ""}
            aria-invalid={!!state?.fieldErrors?.barcode}
          />
          {state?.fieldErrors?.barcode ? (
            <p role="alert" className="text-sm text-destructive">
              {state.fieldErrors.barcode[0]}
            </p>
          ) : null}
        </div>

        <div className="flex flex-col gap-2">
          <Label htmlFor="category">Category</Label>
          <Input id="category" name="category" defaultValue={product?.category ?? ""} />
        </div>

        <div className="flex flex-col gap-2">
          <Label htmlFor="unit">Unit</Label>
          <Input id="unit" name="unit" defaultValue={product?.unit ?? "unit"} />
        </div>

        {canSeeCost ? (
          <div className="flex flex-col gap-2">
            <Label htmlFor="costPrice">Cost price</Label>
            <Input
              id="costPrice"
              name="costPrice"
              type="number"
              step="0.01"
              min="0"
              defaultValue={product ? undefined : undefined}
              aria-invalid={!!state?.fieldErrors?.costPrice}
            />
            {state?.fieldErrors?.costPrice ? (
              <p role="alert" className="text-sm text-destructive">
                {state.fieldErrors.costPrice[0]}
              </p>
            ) : null}
          </div>
        ) : null}

        <div className="flex flex-col gap-2">
          <Label htmlFor="sellingPrice">Selling price</Label>
          <Input
            id="sellingPrice"
            name="sellingPrice"
            type="number"
            step="0.01"
            min="0"
            defaultValue={product?.selling_price ?? 0}
            aria-invalid={!!state?.fieldErrors?.sellingPrice}
          />
          {state?.fieldErrors?.sellingPrice ? (
            <p role="alert" className="text-sm text-destructive">
              {state.fieldErrors.sellingPrice[0]}
            </p>
          ) : null}
        </div>

        <div className="flex flex-col gap-2">
          <Label htmlFor="lowStockThreshold">Low stock threshold</Label>
          <Input
            id="lowStockThreshold"
            name="lowStockThreshold"
            type="number"
            step="0.001"
            min="0"
            defaultValue={product?.low_stock_threshold ?? ""}
          />
        </div>

        {mode === "create" ? (
          <>
            <div className="flex items-center gap-2 sm:col-span-2">
              <input
                id="trackInventory"
                name="trackInventory"
                type="checkbox"
                checked={trackInventory}
                onChange={(e) => setTrackInventory(e.target.checked)}
                className="size-4"
              />
              <Label htmlFor="trackInventory" className="font-normal">
                Track inventory for this product
              </Label>
            </div>

            {trackInventory ? (
              <div className="flex flex-col gap-2">
                <Label htmlFor="openingQuantity">Opening stock</Label>
                <Input
                  id="openingQuantity"
                  name="openingQuantity"
                  type="number"
                  step="0.001"
                  min="0"
                  placeholder="0"
                  value={openingQuantity}
                  onChange={(e) => setOpeningQuantity(e.target.value)}
                />
              </div>
            ) : null}

            {needsBranch && branches.length === 0 ? (
              <div className="sm:col-span-2">
                <NoActiveBranchState action="adding opening stock" />
              </div>
            ) : null}

            {needsBranch && branches.length > 0 ? (
              // min-w-0: without it, a grid item's default min-width:auto
              // refuses to shrink below its content's intrinsic width — a
              // 100-character branch name inside the Select below would
              // otherwise force this whole grid track (and the form)
              // wider than the viewport. Codex adversarial review,
              // application-layer round 2, Blocker 6.
              <div className="flex min-w-0 flex-col gap-2">
                <Label htmlFor="branch">Branch</Label>
                <input type="hidden" name="branchId" value={branchId} />
                <Select value={branchId} onValueChange={(v) => setBranchId(v ?? "")}>
                  {/* w-full overrides the trigger's own default w-fit —
                      combined with the parent's min-w-0 above, this is
                      what actually lets a long selected value truncate
                      (via the trigger's own line-clamp-1) instead of
                      forcing the trigger, and the page, wider. */}
                  <SelectTrigger
                    id="branch"
                    className="w-full min-w-0"
                    aria-invalid={!!state?.fieldErrors?.branchId}
                    aria-describedby={
                      state?.fieldErrors?.branchId ? "branch-helper branch-error" : "branch-helper"
                    }
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
                <p id="branch-helper" className="text-xs text-muted-foreground">
                  Opening stock is added to this branch&apos;s own inventory location.
                </p>
                {state?.fieldErrors?.branchId ? (
                  <p id="branch-error" role="alert" className="text-sm text-destructive">
                    {state.fieldErrors.branchId[0]}
                  </p>
                ) : null}
              </div>
            ) : null}
          </>
        ) : null}
      </div>

      {state?.error ? (
        <Alert variant="destructive" role="alert">
          <AlertDescription>{state.error}</AlertDescription>
        </Alert>
      ) : null}

      <SubmitButton disabled={needsBranch && !branchId}>
        {mode === "create" ? "Create product" : "Save changes"}
      </SubmitButton>
    </form>
  );
}
