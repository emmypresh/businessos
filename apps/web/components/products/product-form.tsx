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
import { getCurrencySymbol } from "@/lib/currency";

type Mode = "create" | "edit";

export function ProductForm({
  mode,
  businessId,
  product,
  canSeeCost,
  branches = [],
  primaryBranchId = null,
  currencyCode,
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
  // Phase 1Q-0C: the owning business's own currency, for the cost/selling
  // price label's currency indicator only (display-only, mirrors
  // ExpenseForm's currencyCode prop) — never submitted by this form.
  // Edit mode falls back to the product's own persisted currency_code
  // when this isn't explicitly passed.
  currencyCode?: string;
}) {
  // Phase 1Q-0C follow-up: never fabricate a currency. If neither the
  // authoritative business currency (create mode) nor the product's own
  // persisted currency_code (edit mode) is available, the label shows no
  // symbol rather than silently defaulting to NGN for a business that may
  // not even use NGN — see getCurrencySymbol's own "no fallback" contract.
  const symbolCurrency = currencyCode ?? product?.currency_code;
  const currencyLabel = symbolCurrency ? getCurrencySymbol(symbolCurrency) : "—";
  const action = mode === "create" ? createProduct : updateProduct;
  const [state, formAction] = useActionState(action, undefined);
  // Server Action validation failures re-render this client component. Keep
  // the last submitted scalar values locally so that a recoverable failure
  // never turns a carefully completed product form back into a blank form.
  // A confirmed success redirects away, so this draft is naturally discarded.
  const [submittedValues, setSubmittedValues] = useState<Record<string, string>>({});
  const submittedValue = (name: string, initial = "") => submittedValues[name] ?? initial;

  // Generated ONCE, at mount — never regenerated on re-render. Stable
  // across a failed submission (the component stays mounted, so a
  // corrected resubmission reuses the same key), fresh only when a new
  // instance of this form mounts (a genuinely new attempt). A rolled-back
  // attempt (any failure) never left a committed claim on this key, so a
  // corrected resubmission is safely treated as a fresh one, not a
  // conflict — see lib/products/actions.ts / the database's own design.
  const [creationKey] = useState(() => crypto.randomUUID());

  const [trackInventory, setTrackInventory] = useState(product?.track_inventory ?? true);
  // Phase 1Q-B: create-mode-only UI state — which mode is purely a
  // client-side rendering choice (whether the sku <Input> exists in the
  // DOM at all), never sent to the server itself. See the sku field's own
  // block below for why removing name="sku" from the DOM, rather than
  // submitting an empty string, is what triggers server-side generation.
  const [skuEntryMode, setSkuEntryMode] = useState<"auto" | "manual">("auto");
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
    <form
      action={formAction}
      data-testid="product-form"
      className="flex flex-col gap-6 max-w-2xl"
      onSubmit={(event) => {
        const formData = new FormData(event.currentTarget);
        const nextValues: Record<string, string> = {};
        for (const [key, value] of formData.entries()) {
          if (typeof value === "string") nextValues[key] = value;
        }
        setSubmittedValues(nextValues);
        // A manual value must remain visible after its validation error;
        // switching the radio back to auto would hide both the error and
        // the value the user needs to correct.
        if (formData.has("sku")) setSkuEntryMode("manual");
      }}
    >
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
            defaultValue={submittedValue("name", product?.name ?? "")}
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
          <Textarea
            id="description"
            name="description"
            defaultValue={submittedValue("description", product?.description ?? "")}
            rows={3}
          />
        </div>

        <div className="flex flex-col gap-2">
          <Label htmlFor="sku">SKU</Label>
          {mode === "create" ? (
            <>
              {/* Phase 1Q-B: low-tech default — a fresh product starts in
                  "auto" mode with no visible sku input at all, so the
                  field can be ignored entirely (phase instruction §25).
                  Switching to "I'll enter my own" reveals a plain input;
                  switching back removes name="sku" from the form again,
                  so the server never receives an empty string and falls
                  through to server-side generation exactly as if the
                  field had never existed. */}
              <div className="flex items-center gap-4 text-sm">
                <label className="flex items-center gap-1.5 font-normal">
                  <input
                    type="radio"
                    name="skuEntryMode"
                    value="auto"
                    checked={skuEntryMode === "auto"}
                    onChange={() => setSkuEntryMode("auto")}
                  />
                  Auto-generate
                </label>
                <label className="flex items-center gap-1.5 font-normal">
                  <input
                    type="radio"
                    name="skuEntryMode"
                    value="manual"
                    checked={skuEntryMode === "manual"}
                    onChange={() => setSkuEntryMode("manual")}
                  />
                  I&apos;ll enter my own
                </label>
              </div>
              {skuEntryMode === "manual" ? (
                <Input
                  id="sku"
                  name="sku"
                  defaultValue={submittedValue("sku")}
                  aria-invalid={!!state?.fieldErrors?.sku}
                  autoFocus
                />
              ) : trackInventory ? (
                <p className="text-xs text-muted-foreground">
                  A SKU will be generated automatically when this product is created.
                </p>
              ) : (
                // Phase 1Q-B remediation (Codex low finding): create_product
                // only ever generates a sku for a TRACKED product with an
                // omitted one (see 20261010080100_product_sku_generation.sql)
                // — a non-tracked (service) product's sku stays null
                // regardless of the business's sku_mode. The auto-generation
                // promise above would be false for this case; this copy
                // matches actual server behavior instead.
                <p className="text-xs text-muted-foreground">
                  SKU is optional for service items — leave it blank if you don&apos;t need one.
                </p>
              )}
            </>
          ) : (
            <>
              <Input
                id="sku"
                name="sku"
                defaultValue={submittedValue("sku", product?.sku ?? "")}
                aria-invalid={!!state?.fieldErrors?.sku}
              />
              <p className="text-xs text-muted-foreground">Changing the SKU is recorded in the audit trail.</p>
            </>
          )}
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
            defaultValue={submittedValue("barcode", product?.barcode ?? "")}
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
          <Input id="category" name="category" defaultValue={submittedValue("category", product?.category ?? "")} />
        </div>

        <div className="flex flex-col gap-2">
          <Label htmlFor="unit">Unit</Label>
          <Input id="unit" name="unit" defaultValue={submittedValue("unit", product?.unit ?? "unit")} />
        </div>

        {canSeeCost ? (
          <div className="flex flex-col gap-2">
            <Label htmlFor="costPrice">Cost price ({currencyLabel})</Label>
            <Input
              id="costPrice"
              name="costPrice"
              type="number"
              step="0.01"
              min="0"
              defaultValue={submittedValue("costPrice")}
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
          <Label htmlFor="sellingPrice">Selling price ({currencyLabel})</Label>
          <Input
            id="sellingPrice"
            name="sellingPrice"
            type="number"
            step="0.01"
            min="0"
            defaultValue={submittedValue("sellingPrice", String(product?.selling_price ?? 0))}
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
            defaultValue={submittedValue("lowStockThreshold", String(product?.low_stock_threshold ?? ""))}
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
