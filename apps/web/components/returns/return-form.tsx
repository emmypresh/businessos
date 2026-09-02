"use client";

import { useActionState, useEffect, useMemo, useState } from "react";
import { createSaleReturn, getReturnableSaleItemsAction, type ReturnableSaleOption, type ReturnableSaleItem } from "@/lib/returns/actions";
import { SalePicker } from "@/components/returns/sale-picker";
import { Label } from "@/components/ui/label";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Checkbox } from "@/components/ui/checkbox";
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
import { formatMoney } from "@/lib/currency";
import { REFUND_METHOD_LABEL, RETURN_REASON_LABEL } from "@/lib/returns/constants";

const QUANTITY_PATTERN = /^\d+(\.\d{1,3})?$/;
const MONEY_PATTERN = /^\d+(\.\d{1,2})?$/;

type LineState = {
  included: boolean;
  quantity: string;
  restock: boolean;
};

export function ReturnForm({ businessId }: { businessId: string }) {
  const [state, formAction] = useActionState(createSaleReturn, undefined);

  // Stable across a failed-submission retry, fresh only on a genuine
  // remount — matches every other Phase 1D-1H creation form's own
  // creationKey treatment exactly. A deliberate NEW return (a different
  // sale, or "start over") gets a fresh key by remounting this component
  // (the parent page keys it by sale selection reset) — never generated
  // on every render, and never regenerated merely because a network
  // request timed out.
  const [creationKey] = useState(() => crypto.randomUUID());

  const [sale, setSale] = useState<ReturnableSaleOption | null>(null);
  const [items, setItems] = useState<ReturnableSaleItem[]>([]);
  const [itemsLoading, setItemsLoading] = useState(false);
  const [itemsError, setItemsError] = useState<string | null>(null);
  const [lines, setLines] = useState<Record<string, LineState>>({});

  const [refundAmount, setRefundAmount] = useState("0");
  const [refundMethod, setRefundMethod] = useState<string>("");
  const [reason, setReason] = useState<string>("");
  const [notes, setNotes] = useState("");

  // Resetting items/lines on deselect happens in selectSale below, never
  // here — an effect body must synchronize with the EXTERNAL system
  // (fetching this sale's own returnable items), not perform a plain,
  // synchronous state reset that setting `sale` to null could just as
  // well trigger directly.
  function selectSale(next: ReturnableSaleOption | null) {
    setSale(next);
    if (!next) {
      setItems([]);
      setLines({});
      setItemsError(null);
    }
  }

  useEffect(() => {
    if (!sale) return;
    let cancelled = false;
    // Deferred one tick, mirroring components/invoices/invoice-form.tsx's
    // own product-search effect exactly: the loading/error state resets
    // happen inside this callback, past the async boundary, never
    // synchronously in the effect body itself.
    const timer = setTimeout(() => {
      setItemsLoading(true);
      setItemsError(null);
      getReturnableSaleItemsAction(businessId, sale.id).then((result) => {
        if (cancelled) return;
        setItemsLoading(false);
        if (!result.ok) {
          setItemsError(result.error);
          setItems([]);
          setLines({});
          return;
        }
        setItems(result.items);
        setLines(
          Object.fromEntries(
            result.items.map((item) => [item.saleItemId, { included: false, quantity: "", restock: true }])
          )
        );
      });
    }, 0);
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [businessId, sale]);

  function updateLine(saleItemId: string, patch: Partial<LineState>) {
    setLines((prev) => ({ ...prev, [saleItemId]: { ...prev[saleItemId], ...patch } }));
  }

  const includedLines = useMemo(
    () =>
      items
        .map((item) => ({ item, line: lines[item.saleItemId] }))
        .filter((entry): entry is { item: ReturnableSaleItem; line: LineState } => Boolean(entry.line?.included)),
    [items, lines]
  );

  const hasInvalidQuantity = includedLines.some(({ item, line }) => {
    const trimmed = line.quantity.trim();
    if (!QUANTITY_PATTERN.test(trimmed)) return true;
    const qty = Number(trimmed);
    return qty <= 0 || qty > item.remaining;
  });

  // CLIENT ESTIMATE ONLY — sum(selected quantity × original sale price).
  // The server independently recomputes this from the LOCKED sale_item
  // row and remains the sole authority; this estimate exists purely so
  // the person filling the form can see a plausible refund ceiling before
  // submitting.
  const returnValueEstimate = includedLines.reduce((sum, { item, line }) => {
    const qty = Number(line.quantity);
    return sum + (Number.isFinite(qty) ? qty : 0) * item.unitPrice;
  }, 0);

  // Advisory ceiling only — min(estimated return value, the sale's own
  // amount_paid). A prior return's own refund already reduces what's
  // truly refundable further still; the DATABASE is what enforces the
  // real cumulative ceiling (RETURN_REFUND_EXCEEDED) — this is never more
  // than a helpful, non-authoritative hint before that round trip.
  const refundCeiling = sale ? Math.min(returnValueEstimate, sale.amountPaid) : 0;
  const refundAmountNumber = Number(refundAmount);
  const hasInvalidRefund =
    !MONEY_PATTERN.test(refundAmount.trim()) || refundAmountNumber < 0 || refundAmountNumber > refundCeiling + 0.001;
  const refundMethodRequired = refundAmountNumber > 0;
  const refundMethodMissing = refundMethodRequired && !refundMethod;

  const itemsPayload = JSON.stringify(
    includedLines.map(({ item, line }) => ({
      saleItemId: item.saleItemId,
      quantity: line.quantity,
      restock: line.restock,
    }))
  );

  const canSubmit =
    !!sale && includedLines.length > 0 && !hasInvalidQuantity && !hasInvalidRefund && !refundMethodMissing;

  return (
    <form action={formAction} data-testid="return-form" className="flex flex-col gap-6 max-w-3xl">
      <input type="hidden" name="businessId" value={businessId} />
      <input type="hidden" name="creationKey" value={creationKey} />
      <input type="hidden" name="saleId" value={sale?.id ?? ""} />
      <input type="hidden" name="items" value={itemsPayload} />
      <input type="hidden" name="refundAmount" value={refundAmount} />
      <input type="hidden" name="refundMethod" value={refundAmountNumber > 0 ? refundMethod : ""} />
      <input type="hidden" name="reason" value={reason} />

      <div className="flex flex-col gap-2">
        <SalePicker
          businessId={businessId}
          selected={sale}
          onSelect={selectSale}
          invalid={!!state?.fieldErrors?.saleId}
          errorId={state?.fieldErrors?.saleId ? "sale-error" : undefined}
        />
        {state?.fieldErrors?.saleId ? (
          <p id="sale-error" role="alert" className="text-sm text-destructive">
            {state.fieldErrors.saleId[0]}
          </p>
        ) : null}
      </div>

      {sale ? (
        <div className="flex flex-col gap-3">
          <Label>Items to return</Label>
          {itemsLoading ? (
            <p className="text-sm text-muted-foreground">Loading items…</p>
          ) : itemsError ? (
            <Alert variant="destructive" role="alert">
              <AlertDescription>{itemsError}</AlertDescription>
            </Alert>
          ) : items.length === 0 ? (
            <p className="text-sm text-muted-foreground">This sale has no items.</p>
          ) : (
            <div className="overflow-x-auto">
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead className="w-10" />
                    <TableHead>Item</TableHead>
                    <TableHead>Remaining</TableHead>
                    <TableHead>Quantity to return</TableHead>
                    <TableHead>Restock</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {items.map((item) => {
                    const line = lines[item.saleItemId] ?? { included: false, quantity: "", restock: true };
                    const fullyReturned = item.remaining <= 0;
                    const trimmedQty = line.quantity.trim();
                    const qtyInvalid =
                      line.included &&
                      (!QUANTITY_PATTERN.test(trimmedQty) ||
                        Number(trimmedQty) <= 0 ||
                        Number(trimmedQty) > item.remaining);
                    return (
                      <TableRow key={item.saleItemId} data-testid={`return-line-${item.saleItemId}`}>
                        <TableCell>
                          <Checkbox
                            aria-label={`Include ${item.productName}`}
                            checked={line.included}
                            disabled={fullyReturned}
                            onCheckedChange={(checked) =>
                              updateLine(item.saleItemId, {
                                included: checked === true,
                                quantity: checked === true && !line.quantity ? String(item.remaining) : line.quantity,
                              })
                            }
                          />
                        </TableCell>
                        <TableCell>
                          <p className="font-medium">{item.productName}</p>
                          {item.sku ? <p className="text-xs text-muted-foreground">{item.sku}</p> : null}
                          {fullyReturned ? (
                            <p className="text-xs text-muted-foreground">Fully returned</p>
                          ) : null}
                        </TableCell>
                        <TableCell>{item.remaining}</TableCell>
                        <TableCell>
                          <Input
                            aria-label={`Quantity to return for ${item.productName}`}
                            value={line.quantity}
                            disabled={!line.included}
                            onChange={(e) => updateLine(item.saleItemId, { quantity: e.target.value })}
                            inputMode="decimal"
                            className="w-24"
                            aria-invalid={qtyInvalid}
                            aria-describedby={qtyInvalid ? `qty-error-${item.saleItemId}` : undefined}
                          />
                          {qtyInvalid ? (
                            <p id={`qty-error-${item.saleItemId}`} role="alert" className="mt-1 text-xs text-destructive">
                              Up to 3 decimal places, no more than {item.remaining}.
                            </p>
                          ) : null}
                        </TableCell>
                        <TableCell>
                          <div className="flex items-center gap-2">
                            <Checkbox
                              aria-label={`Restock ${item.productName}`}
                              checked={line.restock}
                              disabled={!line.included}
                              onCheckedChange={(checked) => updateLine(item.saleItemId, { restock: checked === true })}
                            />
                            <span className="text-sm text-muted-foreground">
                              {line.restock ? "Restocked" : "Not restocked"}
                            </span>
                          </div>
                        </TableCell>
                      </TableRow>
                    );
                  })}
                </TableBody>
              </Table>
              {/* A user picking DAMAGED/DEFECTIVE isn't forced into
                  restock=false — they may still want to inspect/repackage
                  and restock — but a subtle hint is shown so the choice is
                  informed, never overridden. */}
              {(reason === "DAMAGED" || reason === "DEFECTIVE") && includedLines.some((l) => l.line.restock) ? (
                <p className="text-xs text-muted-foreground">
                  Some selected items are marked as damaged or defective but will still be restocked — confirm this is
                  intentional.
                </p>
              ) : null}
            </div>
          )}
          {state?.fieldErrors?.items ? (
            <p role="alert" className="text-sm text-destructive">
              {state.fieldErrors.items[0]}
            </p>
          ) : null}
        </div>
      ) : null}

      {sale && items.length > 0 ? (
        <>
          <div className="grid gap-4 sm:grid-cols-2">
            <div className="flex flex-col gap-2">
              <Label htmlFor="refundAmountInput">Refund amount</Label>
              <Input
                id="refundAmountInput"
                inputMode="decimal"
                value={refundAmount}
                onChange={(e) => setRefundAmount(e.target.value)}
                aria-invalid={hasInvalidRefund || !!state?.fieldErrors?.refundAmount}
                aria-describedby="refund-amount-help"
              />
              <p id="refund-amount-help" className="text-xs text-muted-foreground">
                Return value (estimate): {formatMoney(returnValueEstimate, "NGN")}. The database confirms the exact
                refundable amount.
              </p>
              {state?.fieldErrors?.refundAmount ? (
                <p role="alert" className="text-sm text-destructive">
                  {state.fieldErrors.refundAmount[0]}
                </p>
              ) : null}
            </div>

            <div className="flex flex-col gap-2">
              <Label htmlFor="refundMethodSelect">Refund method</Label>
              <Select
                value={refundMethod}
                onValueChange={(value) => setRefundMethod(value ?? "")}
                disabled={!refundMethodRequired}
              >
                <SelectTrigger
                  id="refundMethodSelect"
                  className="w-full"
                  aria-invalid={refundMethodMissing || !!state?.fieldErrors?.refundMethod}
                >
                  <SelectValue placeholder={refundMethodRequired ? "Choose a method" : "Not needed (no refund)"} />
                </SelectTrigger>
                <SelectContent>
                  {Object.entries(REFUND_METHOD_LABEL).map(([value, label]) => (
                    <SelectItem key={value} value={value}>
                      {label}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
              {state?.fieldErrors?.refundMethod ? (
                <p role="alert" className="text-sm text-destructive">
                  {state.fieldErrors.refundMethod[0]}
                </p>
              ) : null}
            </div>
          </div>

          <div className="grid gap-4 sm:grid-cols-2">
            <div className="flex flex-col gap-2">
              <Label htmlFor="reasonSelect">Reason (optional)</Label>
              <Select value={reason} onValueChange={(value) => setReason(value ?? "")}>
                <SelectTrigger id="reasonSelect" className="w-full">
                  <SelectValue placeholder="Choose a reason" />
                </SelectTrigger>
                <SelectContent>
                  {Object.entries(RETURN_REASON_LABEL).map(([value, label]) => (
                    <SelectItem key={value} value={value}>
                      {label}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
              {state?.fieldErrors?.reason ? (
                <p role="alert" className="text-sm text-destructive">
                  {state.fieldErrors.reason[0]}
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
          </div>

          <div className="rounded-lg border bg-muted/30 p-4 text-sm" data-testid="return-review">
            <p className="mb-2 font-medium">Review (estimated — the database confirms the exact amounts)</p>
            <dl className="grid grid-cols-2 gap-y-1">
              <dt>Items selected</dt>
              <dd className="text-right">{includedLines.length}</dd>
              <dt>Return value (est.)</dt>
              <dd className="text-right">{formatMoney(returnValueEstimate, "NGN")}</dd>
              <dt className="font-medium">Refund amount</dt>
              <dd className="text-right font-medium">{formatMoney(refundAmountNumber || 0, "NGN")}</dd>
            </dl>
          </div>
        </>
      ) : null}

      {state?.error ? (
        <Alert variant="destructive" role="alert">
          <AlertDescription>{state.error}</AlertDescription>
        </Alert>
      ) : null}

      <SubmitButton disabled={!canSubmit}>Create return</SubmitButton>
    </form>
  );
}
