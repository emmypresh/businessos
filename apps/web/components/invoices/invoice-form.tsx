"use client";

import { useActionState, useEffect, useState } from "react";
import { Search, X } from "lucide-react";
import {
  createInvoice,
  searchProductsForInvoiceAction,
  type InvoiceCustomerOption,
  type InvoiceProductOption,
} from "@/lib/invoices/actions";
import { CustomerPicker } from "@/components/invoices/customer-picker";
import { Label } from "@/components/ui/label";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Button } from "@/components/ui/button";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { SubmitButton } from "@/components/auth/submit-button";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { resolveBranchSelectLabel } from "@/lib/branches/select-label";
import { formatMoney } from "@/lib/currency";
import type { InvoiceBranchOption } from "@/lib/invoices/dal";
import { NoActiveBranchState } from "@/components/branches/no-active-branch-state";

// unitPrice is kept as a STRING end-to-end, exactly like quantity already
// was — never coerced to a JS `number` before submission. Codex
// adversarial review, remediation round 1, Medium 1 (application-layer
// half): a custom line's price used to be `Number(customUnitPrice)`
// immediately on entry, which can silently misrepresent a value with more
// than 2 decimal places (JS float multiplication/coercion is not exact
// decimal arithmetic) before MONEY_PATTERN below ever gets a chance to
// reject it. The RPC's own round-trip check
// (create_invoice_rpc.sql) remains the actual authority regardless.
type LineItem = {
  key: string;
  productId: string | null;
  description: string;
  sku: string | null;
  unitPrice: string;
  quantity: string;
};

const QUANTITY_PATTERN = /^\d+(\.\d{1,3})?$/;
const MONEY_PATTERN = /^\d+(\.\d{1,2})?$/;

export function InvoiceForm({
  businessId,
  branches,
  primaryBranchId,
}: {
  businessId: string;
  branches: InvoiceBranchOption[];
  primaryBranchId: string | null;
}) {
  const [state, formAction] = useActionState(createInvoice, undefined);

  // Stable across a failed-submission retry, fresh only on a genuine
  // remount — matches every other Phase 1D-1H creation form's own
  // creationKey treatment exactly.
  const [creationKey] = useState(() => crypto.randomUUID());

  const [branchId, setBranchId] = useState<string>(
    primaryBranchId ?? (branches.length === 1 ? branches[0].id : "")
  );
  const [customer, setCustomer] = useState<InvoiceCustomerOption | null>(null);
  const [dueDate, setDueDate] = useState("");
  const [notes, setNotes] = useState("");
  const [items, setItems] = useState<LineItem[]>([]);

  const [productQuery, setProductQuery] = useState("");
  const [productResults, setProductResults] = useState<InvoiceProductOption[]>([]);
  const [searching, setSearching] = useState(false);

  const [customLineOpen, setCustomLineOpen] = useState(false);
  const [customDescription, setCustomDescription] = useState("");
  const [customUnitPrice, setCustomUnitPrice] = useState("");
  // Codex adversarial review, remediation round 2, Low 4: addCustomLine
  // used to silently no-op on an invalid description/price — a click on
  // "Add line" produced no visible feedback at all. These track the
  // fields' own validity ONLY after a submission attempt (never eagerly,
  // so an empty field isn't flagged invalid before the user has done
  // anything), each rendered as its own field-level, aria-associated
  // error, mirroring every other field in this form.
  const [customDescriptionError, setCustomDescriptionError] = useState<string | null>(null);
  const [customUnitPriceError, setCustomUnitPriceError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    const timer = setTimeout(() => {
      if (!productQuery) {
        setProductResults([]);
        return;
      }
      setSearching(true);
      searchProductsForInvoiceAction(businessId, productQuery)
        .then((rows) => {
          if (!cancelled) setProductResults(rows);
        })
        .finally(() => {
          if (!cancelled) setSearching(false);
        });
    }, 250);
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [businessId, productQuery]);

  function addProductLine(product: InvoiceProductOption) {
    setItems((prev) => {
      if (prev.some((i) => i.productId === product.id)) return prev; // mirrors create_invoice's own DUPLICATE_PRODUCT_LINE rule
      return [
        ...prev,
        {
          key: crypto.randomUUID(),
          productId: product.id,
          description: product.name,
          sku: product.sku,
          // .toFixed(2): product.sellingPrice is a server-sourced
          // numeric(14,2) value display-formatted back into the same
          // string shape a custom line's own price takes — never
          // submitted for a product line regardless (see rpcItems' own
          // comment in lib/invoices/actions.ts: a product-linked line
          // never sends unit_price at all).
          unitPrice: product.sellingPrice.toFixed(2),
          quantity: "1",
        },
      ];
    });
    setProductQuery("");
    setProductResults([]);
  }

  function addCustomLine() {
    const trimmedDescription = customDescription.trim();
    const trimmedPrice = customUnitPrice.trim();

    const descriptionError = trimmedDescription ? null : "Enter a description.";
    const unitPriceError = MONEY_PATTERN.test(trimmedPrice)
      ? null
      : "Enter a price with up to 2 decimal places.";
    setCustomDescriptionError(descriptionError);
    setCustomUnitPriceError(unitPriceError);
    if (descriptionError || unitPriceError) return;

    setItems((prev) => [
      ...prev,
      {
        key: crypto.randomUUID(),
        productId: null,
        description: trimmedDescription,
        sku: null,
        unitPrice: trimmedPrice,
        quantity: "1",
      },
    ]);
    setCustomDescription("");
    setCustomUnitPrice("");
    setCustomDescriptionError(null);
    setCustomUnitPriceError(null);
    setCustomLineOpen(false);
  }

  function updateQuantity(key: string, quantity: string) {
    setItems((prev) => prev.map((i) => (i.key === key ? { ...i, quantity } : i)));
  }

  function removeItem(key: string) {
    setItems((prev) => prev.filter((i) => i.key !== key));
  }

  const totalEstimate = items.reduce((sum, item) => {
    const qty = Number(item.quantity);
    const price = Number(item.unitPrice);
    return sum + (Number.isFinite(qty) ? qty : 0) * (Number.isFinite(price) ? price : 0);
  }, 0);
  const hasInvalidQuantity = items.some((item) => !QUANTITY_PATTERN.test(item.quantity.trim()));

  const itemsPayload = JSON.stringify(
    items.map((item) =>
      item.productId
        ? { productId: item.productId, quantity: item.quantity }
        : { description: item.description, quantity: item.quantity, unitPrice: item.unitPrice }
    )
  );

  return (
    <form action={formAction} data-testid="invoice-form" className="flex flex-col gap-6 max-w-3xl">
      <input type="hidden" name="businessId" value={businessId} />
      <input type="hidden" name="creationKey" value={creationKey} />
      <input type="hidden" name="items" value={itemsPayload} />
      <input type="hidden" name="branchId" value={branchId} />
      <input type="hidden" name="customerId" value={customer?.id ?? ""} />

      <CustomerPicker
        businessId={businessId}
        selected={customer}
        onSelect={setCustomer}
        invalid={!!state?.fieldErrors?.customerId}
        errorId={state?.fieldErrors?.customerId ? "customer-error" : undefined}
      />
      {state?.fieldErrors?.customerId ? (
        <p id="customer-error" role="alert" className="text-sm text-destructive">
          {state.fieldErrors.customerId[0]}
        </p>
      ) : null}

      {/* min-w-0: lets this item shrink below a long branch name's own
          intrinsic width instead of forcing the form wider than the
          viewport. Codex adversarial review, application-layer round 2,
          Blocker 6 / round 3, Medium 2. */}
      <div className="flex min-w-0 flex-col gap-2">
        <Label htmlFor="branch">Branch</Label>
        {branches.length === 0 ? (
          <NoActiveBranchState action="creating an invoice" />
        ) : (
          <Select value={branchId} onValueChange={(v) => setBranchId(v ?? "")}>
            <SelectTrigger
              id="branch"
              className="w-full min-w-0"
              aria-invalid={!!state?.fieldErrors?.branchId}
              aria-describedby={state?.fieldErrors?.branchId ? "branch-error" : undefined}
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
        )}
        {state?.fieldErrors?.branchId ? (
          <p id="branch-error" role="alert" className="text-sm text-destructive">
            {state.fieldErrors.branchId[0]}
          </p>
        ) : null}
      </div>

      <div className="flex flex-col gap-2">
        <Label htmlFor="dueDate">Due date (optional)</Label>
        <Input
          id="dueDate"
          type="date"
          value={dueDate}
          onChange={(e) => setDueDate(e.target.value)}
          name="dueDate"
          aria-invalid={!!state?.fieldErrors?.dueDate}
          aria-describedby={state?.fieldErrors?.dueDate ? "dueDate-error" : undefined}
        />
        {state?.fieldErrors?.dueDate ? (
          <p id="dueDate-error" role="alert" className="text-sm text-destructive">
            {state.fieldErrors.dueDate[0]}
          </p>
        ) : null}
      </div>

      <div className="flex flex-col gap-3">
        <Label>Items</Label>
        <div className="relative">
          <Search className="pointer-events-none absolute left-2.5 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" />
          <Input
            aria-label="Search products"
            placeholder="Search products by name or SKU"
            value={productQuery}
            onChange={(e) => setProductQuery(e.target.value)}
            className="pl-8"
          />
        </div>
        {productQuery ? (
          <div className="flex flex-col gap-1 rounded-md border bg-card p-1" data-testid="invoice-product-results">
            {searching ? (
              <p className="p-2 text-sm text-muted-foreground">Searching…</p>
            ) : productResults.length === 0 ? (
              <p className="p-2 text-sm text-muted-foreground">No matching active products.</p>
            ) : (
              productResults.map((product) => (
                <button
                  key={product.id}
                  type="button"
                  onClick={() => addProductLine(product)}
                  className="flex items-center justify-between gap-3 rounded-md px-2 py-1.5 text-left text-sm hover:bg-accent"
                >
                  <span>{product.name}</span>
                  <span className="text-muted-foreground">{formatMoney(product.sellingPrice, "NGN")}</span>
                </button>
              ))
            )}
          </div>
        ) : null}

        {customLineOpen ? (
          <div className="flex flex-col gap-2 rounded-md border p-3 sm:flex-row sm:items-end">
            <div className="flex flex-1 flex-col gap-1">
              <Label htmlFor="customDescription">Description</Label>
              <Input
                id="customDescription"
                value={customDescription}
                onChange={(e) => {
                  setCustomDescription(e.target.value);
                  if (customDescriptionError) setCustomDescriptionError(null);
                }}
                placeholder="e.g. Delivery fee"
                aria-invalid={!!customDescriptionError}
                aria-describedby={customDescriptionError ? "customDescription-error" : undefined}
              />
              {customDescriptionError ? (
                <p id="customDescription-error" role="alert" className="text-xs text-destructive">
                  {customDescriptionError}
                </p>
              ) : null}
            </div>
            <div className="flex flex-col gap-1">
              <Label htmlFor="customUnitPrice">Unit price</Label>
              <Input
                id="customUnitPrice"
                type="number"
                min="0"
                step="0.01"
                value={customUnitPrice}
                onChange={(e) => {
                  setCustomUnitPrice(e.target.value);
                  if (customUnitPriceError) setCustomUnitPriceError(null);
                }}
                className="w-32"
                aria-invalid={!!customUnitPriceError}
                aria-describedby={customUnitPriceError ? "customUnitPrice-error" : undefined}
              />
              {customUnitPriceError ? (
                <p id="customUnitPrice-error" role="alert" className="text-xs text-destructive">
                  {customUnitPriceError}
                </p>
              ) : null}
            </div>
            <Button type="button" onClick={addCustomLine}>
              Add line
            </Button>
            <Button
              type="button"
              variant="ghost"
              onClick={() => {
                setCustomLineOpen(false);
                setCustomDescriptionError(null);
                setCustomUnitPriceError(null);
              }}
            >
              Cancel
            </Button>
          </div>
        ) : (
          <Button type="button" variant="outline" className="w-fit" onClick={() => setCustomLineOpen(true)}>
            Add custom line
          </Button>
        )}

        {items.length > 0 ? (
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Item</TableHead>
                <TableHead>Quantity</TableHead>
                <TableHead>Unit price</TableHead>
                <TableHead>Line total (est.)</TableHead>
                <TableHead />
              </TableRow>
            </TableHeader>
            <TableBody>
              {items.map((item) => {
                const qty = Number(item.quantity);
                const price = Number(item.unitPrice);
                const lineTotal = Number.isFinite(qty) && Number.isFinite(price) ? qty * price : 0;
                const invalid = !QUANTITY_PATTERN.test(item.quantity.trim());
                return (
                  <TableRow key={item.key}>
                    <TableCell>
                      <p className="font-medium">{item.description}</p>
                      {item.sku ? <p className="text-xs text-muted-foreground">{item.sku}</p> : null}
                    </TableCell>
                    <TableCell>
                      <Input
                        aria-label={`Quantity for ${item.description}`}
                        value={item.quantity}
                        onChange={(e) => updateQuantity(item.key, e.target.value)}
                        inputMode="decimal"
                        className="w-24"
                        aria-invalid={invalid}
                        aria-describedby={invalid ? `quantity-error-${item.key}` : undefined}
                      />
                      {invalid ? (
                        <p id={`quantity-error-${item.key}`} role="alert" className="mt-1 text-xs text-destructive">
                          Up to 3 decimal places.
                        </p>
                      ) : null}
                    </TableCell>
                    <TableCell>{formatMoney(price, "NGN")}</TableCell>
                    <TableCell>{formatMoney(lineTotal, "NGN")}</TableCell>
                    <TableCell>
                      <Button
                        type="button"
                        variant="ghost"
                        size="icon-sm"
                        aria-label={`Remove ${item.description}`}
                        onClick={() => removeItem(item.key)}
                      >
                        <X className="size-4" />
                      </Button>
                    </TableCell>
                  </TableRow>
                );
              })}
            </TableBody>
          </Table>
        ) : (
          <p className="text-sm text-muted-foreground">No items added yet.</p>
        )}
        {state?.fieldErrors?.items ? (
          <p role="alert" className="text-sm text-destructive">
            {state.fieldErrors.items[0]}
          </p>
        ) : null}
      </div>

      <div className="flex flex-col gap-2">
        <Label htmlFor="notes">Notes (optional)</Label>
        <Textarea
          id="notes"
          name="notes"
          value={notes}
          onChange={(e) => setNotes(e.target.value)}
          rows={2}
          aria-invalid={!!state?.fieldErrors?.notes}
          aria-describedby={state?.fieldErrors?.notes ? "notes-error" : undefined}
        />
        {state?.fieldErrors?.notes ? (
          <p id="notes-error" role="alert" className="text-sm text-destructive">
            {state.fieldErrors.notes[0]}
          </p>
        ) : null}
      </div>

      <div className="rounded-lg border bg-muted/30 p-4 text-sm" data-testid="invoice-review">
        <p className="mb-2 font-medium">Review (estimated — the database confirms the exact total)</p>
        <dl className="grid grid-cols-2 gap-y-1">
          <dt className="font-medium">Total</dt>
          <dd className="text-right font-medium">{formatMoney(totalEstimate, "NGN")}</dd>
        </dl>
      </div>

      {state?.error ? (
        <Alert variant="destructive" role="alert">
          <AlertDescription>{state.error}</AlertDescription>
        </Alert>
      ) : null}

      <SubmitButton disabled={items.length === 0 || hasInvalidQuantity || !customer || !branchId}>
        Create invoice
      </SubmitButton>
    </form>
  );
}
