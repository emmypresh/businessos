"use client";

import { useActionState, useEffect, useRef, useState, type FormEvent } from "react";
import { X } from "lucide-react";
import { createSale, getSaleProductAvailabilityAction } from "@/lib/sales/actions";
import { Label } from "@/components/ui/label";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Button } from "@/components/ui/button";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { SubmitButton } from "@/components/auth/submit-button";
import { ProductPicker } from "@/components/sales/product-picker";
import { PAYMENT_METHOD_LABEL, type PaymentMethod, type PaymentStatus } from "@/lib/sales/constants";
import { isPartialPaymentInvalid } from "@/lib/validation/sales";
import type { SaleProductOption } from "@/lib/sales/dal";
import type { OperationalBranchOption } from "@/lib/branches/dal";
import { resolveBranchSelectLabel } from "@/lib/branches/select-label";

type LineItem = {
  productId: string;
  name: string;
  sku: string | null;
  sellingPrice: number;
  currencyCode: string;
  trackInventory: boolean;
  availableQuantity: number;
  quantity: string; // kept as a STRING throughout — never coerced to a
  // JS number for display/state until submit, so the exact decimal text
  // the user typed is what's shown back to them, never a float-rounded
  // echo of it.
};

const QUANTITY_PATTERN = /^\d+(\.\d{1,3})?$/;

export function SaleForm({
  businessId,
  customers,
  branches,
  primaryBranchId,
}: {
  businessId: string;
  customers: { id: string; name: string }[];
  branches: OperationalBranchOption[];
  primaryBranchId: string | null;
}) {
  const [state, formAction] = useActionState(createSale, undefined);

  // Generated ONCE, at mount — never regenerated on every submit, never
  // exposed anywhere in the rendered UI. Stable across a failed
  // submission (controlled validation OR database failure): the
  // component stays mounted, so a corrected resubmission reuses the same
  // key. Success redirects (see lib/sales/actions.ts), which is what
  // guarantees a mounted form can never perform two independent sales
  // under one key.
  const [creationKey] = useState(() => crypto.randomUUID());

  const [items, setItems] = useState<LineItem[]>([]);
  // Preselected: the caller's own active primary branch, or — when they
  // have no primary but exactly one accessible branch — that one branch.
  // With two or more accessible, non-primary branches, this starts empty
  // so the caller makes an explicit choice rather than silently defaulting
  // to an arbitrary one.
  const [branchId, setBranchId] = useState<string>(
    primaryBranchId ?? (branches.length === 1 ? branches[0].id : "")
  );
  const [customerId, setCustomerId] = useState<string>("");
  const [discount, setDiscount] = useState("0");
  const [paymentStatus, setPaymentStatus] = useState<PaymentStatus>("UNPAID");
  const [paymentMethod, setPaymentMethod] = useState<PaymentMethod | "">("");
  const [amountPaid, setAmountPaid] = useState("");
  const [notes, setNotes] = useState("");

  function addProduct(product: SaleProductOption) {
    setItems((prev) => {
      const existingIndex = prev.findIndex((i) => i.productId === product.id);
      if (existingIndex !== -1) {
        // Duplicate product UX (§11): merge into the existing row by
        // incrementing its quantity, rather than adding a second visible
        // line — the server remains defensive (DUPLICATE_PRODUCT_LINE)
        // regardless, this is purely the UX guard.
        const next = [...prev];
        const current = Number(next[existingIndex].quantity) || 0;
        next[existingIndex] = { ...next[existingIndex], quantity: String(current + 1) };
        return next;
      }
      return [
        ...prev,
        {
          productId: product.id,
          name: product.name,
          sku: product.sku,
          sellingPrice: product.sellingPrice,
          currencyCode: product.currencyCode,
          trackInventory: product.trackInventory,
          availableQuantity: product.quantity,
          quantity: "1",
        },
      ];
    });
  }

  function updateQuantity(productId: string, quantity: string) {
    setItems((prev) => prev.map((i) => (i.productId === productId ? { ...i, quantity } : i)));
  }

  // Codex adversarial review, application-layer round 3, Medium 1: a line
  // already added to the cart captured its availableQuantity at ADD time
  // and never refreshed it — switching branches left every existing line
  // showing its old branch's stock, even though ProductPicker's own live
  // search correctly reflected the new one. This re-fetches every
  // CURRENT line's availability for the newly selected branch in one
  // batched request (getSaleProductAvailabilityAction) whenever branchId
  // changes, and merges the fresh quantities back in — quantities/prices/
  // other line fields are untouched, the cart itself is never cleared.
  //
  // itemsRef (not `items` in the dependency array) intentionally: this
  // effect must fire ONLY on a branch change, never merely because a line
  // was added/removed/edited (adding a product already captures its
  // correct current-branch availability via ProductPicker's own
  // branch-aware search) — reading the latest cart through a ref avoids
  // both an infinite effect loop (this effect itself calls setItems) and
  // a stale closure over an old `items` array.
  const itemsRef = useRef(items);
  useEffect(() => {
    itemsRef.current = items;
  }, [items]);

  useEffect(() => {
    const currentItems = itemsRef.current;
    if (currentItems.length === 0) return;
    // Race safety: a `cancelled` flag scoped to THIS effect run, flipped
    // by its own cleanup — if branchId changes again (A -> B -> C) before
    // B's response arrives, React runs B's cleanup before starting C's
    // effect, so B's now-stale response is discarded and never overwrites
    // C's state. Mirrors ProductPicker's own identical debounce/cancel
    // pattern — no additional state-management framework needed.
    let cancelled = false;
    const productIds = currentItems.map((item) => item.productId);
    getSaleProductAvailabilityAction(businessId, productIds, branchId).then((rows) => {
      if (cancelled) return;
      // Codex adversarial review, application-layer round 3, Low 2: every
      // product THIS refresh asked about must land in a definitive
      // post-refresh state — never left at its OLD, pre-refresh figure.
      // The DAL can genuinely omit a requested product (it becomes
      // archived/inactive between the line being added and this refresh
      // running — searchProductsForSale only ever returns ACTIVE
      // products), and a stale "5 available" surviving that is exactly
      // as misleading as a stale figure from a stock branch change. A
      // missing row is treated as zero availability, never as "no
      // change" — this also means the existing "Exceeds available
      // stock" warning recalculates automatically on the next render,
      // with no separate flag needed. `.map` over `prev` (the state at
      // the moment this response is applied), never a fresh array built
      // from `rows` — a line the user already removed while this
      // request was in flight is simply absent from `prev` and can never
      // be recreated by an in-flight response that still mentions it.
      setItems((prev) =>
        prev.map((item) => {
          const match = rows.find((r) => r.id === item.productId);
          return { ...item, availableQuantity: match ? match.quantity : 0 };
        })
      );
    });
    return () => {
      cancelled = true;
    };
  }, [branchId, businessId]);

  function removeItem(productId: string) {
    setItems((prev) => prev.filter((i) => i.productId !== productId));
  }

  // Display estimates ONLY — the database recomputes every one of these
  // authoritatively from the locked product rows at completion time; a
  // stale price, a since-edited product, or simple arithmetic drift here
  // never becomes what's actually charged.
  const subtotalEstimate = items.reduce((sum, item) => {
    const qty = Number(item.quantity);
    return sum + (Number.isFinite(qty) ? qty : 0) * item.sellingPrice;
  }, 0);
  const discountValue = Number(discount) || 0;
  const totalEstimate = Math.max(0, subtotalEstimate - discountValue);
  const currencyCode = items[0]?.currencyCode ?? "NGN";

  const itemsPayload = JSON.stringify(
    items.map((item) => ({ productId: item.productId, quantity: item.quantity }))
  );

  const hasInvalidQuantity = items.some((item) => !QUANTITY_PATTERN.test(item.quantity.trim()));

  // Non-authoritative pre-submit guard (lib/validation/sales.ts's
  // isPartialPaymentInvalid — see its own doc comment) — create_sale's
  // own payment invariants remain the actual authority and are
  // re-checked from the locked, server-computed total regardless of what
  // this shows or blocks. `totalEstimate` is a JS display estimate only
  // (see comment above) and is never sent to create_sale — only
  // amountPaid itself is (and only while PARTIALLY_PAID, per the hidden
  // input below). `amountPaidTooHigh` is only used to choose which of
  // two messages to display below, never to decide blocking itself.
  const partialPaymentInvalid = isPartialPaymentInvalid(paymentStatus, amountPaid, totalEstimate);
  const amountPaidTooHigh = paymentStatus === "PARTIALLY_PAID" && Number(amountPaid) >= totalEstimate;

  // Defense-in-depth alongside the disabled submit button below: even a
  // programmatic form.requestSubmit() (bypassing the disabled attribute,
  // the same technique the double-click-idempotency E2E tests already use
  // deliberately) is refused here while the partial-payment guard is
  // invalid. This never replaces server-side validation — create_sale
  // still enforces the real invariant from the locked total.
  function handleSubmit(e: FormEvent<HTMLFormElement>) {
    if (partialPaymentInvalid) {
      e.preventDefault();
    }
  }

  return (
    <form
      action={formAction}
      onSubmit={handleSubmit}
      data-testid="sale-form"
      className="flex flex-col gap-6 max-w-3xl"
    >
      <input type="hidden" name="businessId" value={businessId} />
      <input type="hidden" name="creationKey" value={creationKey} />
      <input type="hidden" name="items" value={itemsPayload} />
      <input type="hidden" name="customerId" value={customerId} />
      <input type="hidden" name="discount" value={discount} />
      <input type="hidden" name="paymentStatus" value={paymentStatus} />
      <input type="hidden" name="paymentMethod" value={paymentStatus === "UNPAID" ? "" : paymentMethod} />
      <input type="hidden" name="amountPaid" value={paymentStatus === "PARTIALLY_PAID" ? amountPaid : ""} />
      <input type="hidden" name="notes" value={notes} />
      <input type="hidden" name="branchId" value={branchId} />

      {/* min-w-0: lets this item shrink below a 100-character branch
          name's intrinsic width instead of forcing the form wider than
          the viewport. Codex adversarial review, application-layer round
          2, Blocker 6. */}
      <div className="flex min-w-0 flex-col gap-2">
        <Label htmlFor="branch">Branch</Label>
        <Select value={branchId} onValueChange={(v) => setBranchId(v ?? "")}>
          {/* w-full overrides SelectTrigger's own default w-fit — this,
              combined with the parent's min-w-0, is what lets a long
              selected value truncate (via the trigger's own
              line-clamp-1) instead of overflowing. */}
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
        {state?.fieldErrors?.branchId ? (
          <p id="branch-error" role="alert" className="text-sm text-destructive">
            {state.fieldErrors.branchId[0]}
          </p>
        ) : null}
      </div>

      <div className="flex flex-col gap-2">
        <Label htmlFor="customer">Customer (optional)</Label>
        <Select value={customerId || "walk-in"} onValueChange={(v) => setCustomerId(v === "walk-in" ? "" : (v ?? ""))}>
          <SelectTrigger id="customer">
            <SelectValue placeholder="Walk-in customer" />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="walk-in">Walk-in customer</SelectItem>
            {customers.map((customer) => (
              <SelectItem key={customer.id} value={customer.id}>
                {customer.name}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </div>

      <div className="flex flex-col gap-2">
        <Label>Products</Label>
        <ProductPicker businessId={businessId} branchId={branchId} onAdd={addProduct} />
      </div>

      {items.length > 0 ? (
        <div className="flex flex-col gap-2">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Product</TableHead>
                <TableHead>Quantity</TableHead>
                <TableHead>Price</TableHead>
                <TableHead>Line total (est.)</TableHead>
                <TableHead />
              </TableRow>
            </TableHeader>
            <TableBody>
              {items.map((item) => {
                const qty = Number(item.quantity);
                const lineTotal = Number.isFinite(qty) ? qty * item.sellingPrice : 0;
                const invalid = !QUANTITY_PATTERN.test(item.quantity.trim());
                const exceedsStock = item.trackInventory && Number.isFinite(qty) && qty > item.availableQuantity;
                return (
                  <TableRow key={item.productId}>
                    <TableCell>
                      <p className="font-medium">{item.name}</p>
                      <p className="text-xs text-muted-foreground">
                        {item.sku ?? "No SKU"} ·{" "}
                        {item.trackInventory ? `${item.availableQuantity} available` : "Not tracked"}
                      </p>
                    </TableCell>
                    <TableCell>
                      <Input
                        aria-label={`Quantity for ${item.name}`}
                        value={item.quantity}
                        onChange={(e) => updateQuantity(item.productId, e.target.value)}
                        inputMode="decimal"
                        className="w-24"
                        aria-invalid={invalid}
                      />
                      {invalid ? (
                        <p role="alert" className="mt-1 text-xs text-destructive">
                          Up to 3 decimal places.
                        </p>
                      ) : exceedsStock ? (
                        <p className="mt-1 text-xs text-amber-600">Exceeds available stock.</p>
                      ) : null}
                    </TableCell>
                    <TableCell>
                      {item.currencyCode} {item.sellingPrice.toFixed(2)}
                    </TableCell>
                    <TableCell>
                      {item.currencyCode} {lineTotal.toFixed(2)}
                    </TableCell>
                    <TableCell>
                      <Button
                        type="button"
                        variant="ghost"
                        size="icon-sm"
                        aria-label={`Remove ${item.name}`}
                        onClick={() => removeItem(item.productId)}
                      >
                        <X className="size-4" />
                      </Button>
                    </TableCell>
                  </TableRow>
                );
              })}
            </TableBody>
          </Table>
          {state?.fieldErrors?.items ? (
            <p role="alert" className="text-sm text-destructive">
              {state.fieldErrors.items[0]}
            </p>
          ) : null}
        </div>
      ) : (
        <p className="text-sm text-muted-foreground">No products added yet.</p>
      )}

      <div className="grid gap-4 sm:grid-cols-2">
        <div className="flex flex-col gap-2">
          <Label htmlFor="discount">Discount</Label>
          <Input
            id="discount"
            value={discount}
            onChange={(e) => setDiscount(e.target.value)}
            inputMode="decimal"
            aria-invalid={!!state?.fieldErrors?.discount}
          />
          {state?.fieldErrors?.discount ? (
            <p role="alert" className="text-sm text-destructive">
              {state.fieldErrors.discount[0]}
            </p>
          ) : null}
        </div>

        <div className="flex flex-col gap-2">
          <Label htmlFor="paymentStatus">Payment status</Label>
          <Select
            value={paymentStatus}
            onValueChange={(v) => {
              const next = (v ?? "UNPAID") as PaymentStatus;
              setPaymentStatus(next);
              if (next === "UNPAID") {
                setPaymentMethod("");
                setAmountPaid("");
              }
            }}
          >
            <SelectTrigger id="paymentStatus">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="UNPAID">Unpaid</SelectItem>
              <SelectItem value="PARTIALLY_PAID">Partially paid</SelectItem>
              <SelectItem value="PAID">Paid</SelectItem>
            </SelectContent>
          </Select>
        </div>

        {paymentStatus !== "UNPAID" ? (
          <div className="flex flex-col gap-2">
            <Label htmlFor="paymentMethod">Payment method</Label>
            <Select value={paymentMethod} onValueChange={(v) => setPaymentMethod((v ?? "") as PaymentMethod)}>
              <SelectTrigger id="paymentMethod">
                <SelectValue placeholder="Choose a method" />
              </SelectTrigger>
              <SelectContent>
                {Object.entries(PAYMENT_METHOD_LABEL).map(([value, label]) => (
                  <SelectItem key={value} value={value}>
                    {label}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            {state?.fieldErrors?.paymentMethod ? (
              <p role="alert" className="text-sm text-destructive">
                {state.fieldErrors.paymentMethod[0]}
              </p>
            ) : null}
          </div>
        ) : null}

        {paymentStatus === "PARTIALLY_PAID" ? (
          <div className="flex flex-col gap-2">
            <Label htmlFor="amountPaid">Amount paid</Label>
            <Input
              id="amountPaid"
              value={amountPaid}
              onChange={(e) => setAmountPaid(e.target.value)}
              inputMode="decimal"
              aria-invalid={partialPaymentInvalid || !!state?.fieldErrors?.amountPaid}
            />
            {partialPaymentInvalid ? (
              <p role="alert" className="text-xs text-destructive">
                {amountPaidTooHigh
                  ? "Partial payment must be less than the estimated total."
                  : "Enter an amount greater than zero."}
              </p>
            ) : (
              <p className="text-xs text-muted-foreground">
                Must be less than the total (estimated {currencyCode} {totalEstimate.toFixed(2)}).
              </p>
            )}
            {state?.fieldErrors?.amountPaid ? (
              <p role="alert" className="text-sm text-destructive">
                {state.fieldErrors.amountPaid[0]}
              </p>
            ) : null}
          </div>
        ) : null}
      </div>

      <div className="flex flex-col gap-2">
        <Label htmlFor="notes">Notes (optional)</Label>
        <Textarea id="notes" value={notes} onChange={(e) => setNotes(e.target.value)} rows={2} />
      </div>

      <div className="rounded-lg border bg-muted/30 p-4 text-sm" data-testid="sale-review">
        <p className="mb-2 font-medium">Review (estimated — the database confirms the exact amounts)</p>
        <dl className="grid grid-cols-2 gap-y-1">
          <dt className="text-muted-foreground">Subtotal</dt>
          <dd className="text-right">
            {currencyCode} {subtotalEstimate.toFixed(2)}
          </dd>
          <dt className="text-muted-foreground">Discount</dt>
          <dd className="text-right">
            {currencyCode} {discountValue.toFixed(2)}
          </dd>
          <dt className="font-medium">Total</dt>
          <dd className="text-right font-medium">
            {currencyCode} {totalEstimate.toFixed(2)}
          </dd>
        </dl>
      </div>

      {state?.error ? (
        <Alert variant="destructive" role="alert">
          <AlertDescription>{state.error}</AlertDescription>
        </Alert>
      ) : null}

      <SubmitButton disabled={partialPaymentInvalid || !branchId}>
        {items.length === 0 || hasInvalidQuantity ? "Complete sale" : `Complete sale · ${currencyCode} ${totalEstimate.toFixed(2)}`}
      </SubmitButton>
    </form>
  );
}
