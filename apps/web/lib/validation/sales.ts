import { z } from "zod";
import { MAX_SALE_ITEMS } from "@/lib/sales/constants";

/**
 * Client-side feedback only — create_sale's own validation is the actual
 * authority (supabase/migrations/20260826090500_create_sale_creation_requests_and_rpc.sql).
 * Every bound here mirrors that RPC's exact contract: money fields cap at
 * numeric(14,2)'s representable maximum (SALE_AMOUNT_OUT_OF_RANGE),
 * quantity accepts AT MOST 3 decimal places and is REJECTED (never
 * rounded) beyond that, and the item count caps at MAX_SALE_ITEMS
 * (TOO_MANY_SALE_ITEMS). No arithmetic performed here is ever
 * authoritative — every total this app displays before submission is a
 * display estimate; the database computes and returns the real numbers.
 */

// numeric(14,2)'s exact maximum representable value (12 digits before
// the decimal point, 2 after) — mirrors create_sale's own v_max_money.
const MAX_MONEY = 999_999_999_999.99;

const money = z
  .coerce
  .number({ error: "Enter a valid amount." })
  .min(0, { error: "Amount cannot be negative." })
  .max(MAX_MONEY, { error: "Amount is too large." });

// Quantity is validated as a STRING first — regex-checked for at most 3
// decimal places BEFORE any numeric coercion — so excess precision is
// REJECTED with a clear message, never silently rounded by a float
// conversion. This mirrors the database's own "prove the narrowed
// candidate equals the original value" round-trip check, adapted for a
// client-side string input where the original textual precision is still
// available to inspect directly.
const saleQuantity = z
  .string()
  .trim()
  .regex(/^\d+(\.\d{1,3})?$/, {
    error: "Quantity must be a positive number with up to 3 decimal places.",
  })
  .transform((v) => Number(v))
  .refine((v) => v > 0, { error: "Quantity must be greater than zero." })
  .refine((v) => v <= 1_000_000, { error: "Quantity is too large." });

export const SaleItemSchema = z.object({
  productId: z.uuid(),
  quantity: saleQuantity,
});

// Codex adversarial review, application-layer round 3, Low 1:
// getSaleProductAvailabilityAction (lib/sales/actions.ts) batches a
// branch-availability re-fetch for every product id currently in the
// sale form's own cart — a client-controlled array that reaches a raw
// `.in("id", productIds)` query against a uuid column. Validated here
// with the SAME z.uuid() this file already uses for every other product/
// sale id, rather than inventing a second validation approach: a
// malformed id fails this schema and the whole batch is rejected before
// ever reaching Postgres (see that action's own comment on why a mixed
// valid/malformed array is rejected wholesale, not silently filtered).
// Capped at MAX_SALE_ITEMS — the same bound CreateSaleSchema's own
// `items` array already enforces — since this array can never
// legitimately exceed the cart's own maximum line count.
export const SaleProductIdsSchema = z.array(z.uuid()).max(MAX_SALE_ITEMS);

export type SaleItemInput = z.infer<typeof SaleItemSchema>;

export const CreateSaleSchema = z
  .object({
    creationKey: z.uuid(),
    // Phase 1G: the NEW UI always sends an explicit choice (SaleForm
    // requires the visible Branch select before it will submit) — but
    // this schema itself deliberately treats branchId as OPTIONAL at the
    // validation boundary, never a hard requirement. create_sale's own
    // approved compatibility contract (20260829080100_branch_aware_sales.sql)
    // resolves an OMITTED branch via the caller's active primary branch
    // assignment — an existing/legacy caller of this action that never
    // sends branchId at all must keep working through that exact fallback,
    // not be rejected here before ever reaching the RPC. Codex adversarial
    // review, application-layer round 2, Blocker 5.
    branchId: z.uuid({ error: "Choose a valid branch." }).optional(),
    customerId: z.uuid().optional(),
    items: z
      .array(SaleItemSchema)
      .min(1, { error: "Add at least one product." })
      .max(MAX_SALE_ITEMS, { error: `A sale can have at most ${MAX_SALE_ITEMS} product lines.` })
      // Client-side duplicate-line UX guard, mirroring the server's own
      // DUPLICATE_PRODUCT_LINE rejection — the RPC remains the actual
      // defense; this only gives the user a clear message before the
      // round trip.
      .refine((items) => new Set(items.map((i) => i.productId)).size === items.length, {
        error: "Each product can only appear once — combine the quantity into one line instead.",
        path: ["items"],
      }),
    discount: money.default(0),
    paymentStatus: z.enum(["UNPAID", "PARTIALLY_PAID", "PAID"], { error: "Choose a payment status." }),
    paymentMethod: z.enum(["CASH", "BANK_TRANSFER", "CARD", "OTHER"]).optional(),
    amountPaid: money.default(0),
    notes: z
      .string()
      .trim()
      .max(2000)
      .optional()
      .transform((v) => (v ? v : undefined)),
  })
  // Mirrors create_sale's own payment canonicalization exactly (§4 of
  // the approved database corrections) — these are the SAME shape rules
  // the RPC enforces, given here only so the form can show a field-level
  // error before submitting rather than a generic one after.
  .refine((data) => data.paymentStatus !== "UNPAID" || data.paymentMethod === undefined, {
    error: "An unpaid sale has no payment method.",
    path: ["paymentMethod"],
  })
  .refine(
    (data) =>
      (data.paymentStatus !== "PARTIALLY_PAID" && data.paymentStatus !== "PAID") ||
      data.paymentMethod !== undefined,
    { error: "Choose how the customer paid.", path: ["paymentMethod"] }
  )
  .refine((data) => data.paymentStatus !== "PARTIALLY_PAID" || data.amountPaid > 0, {
    error: "Enter the amount paid.",
    path: ["amountPaid"],
  });

export type CreateSaleInput = z.infer<typeof CreateSaleSchema>;

export const SaleFilterSchema = z.object({
  search: z.string().trim().max(200).optional(),
  paymentStatus: z.enum(["UNPAID", "PARTIALLY_PAID", "PAID"]).optional(),
  customerId: z.uuid().optional(),
  branchId: z.uuid().optional(),
  dateFrom: z.iso.date().optional(),
  dateTo: z.iso.date().optional(),
});

export type SaleFilterInput = z.infer<typeof SaleFilterSchema>;

/**
 * Pre-submit UX guard for SaleForm (components/sales/sale-form.tsx) —
 * NOT authoritative. create_sale's own payment invariants remain the
 * actual authority and are re-checked from the locked, server-computed
 * total regardless of what this returns. `totalEstimate` is always a JS
 * display estimate (never sent to the RPC as such); this function only
 * decides whether the form may submit `amountPaid` while
 * PARTIALLY_PAID — a valid partial payment must be strictly between 0
 * and the estimated total (both bounds excluded: an amount at or above
 * the total isn't "partial", and zero/empty/non-numeric isn't a payment
 * at all). UNPAID and PAID never send amountPaid as PARTIALLY_PAID does
 * (see the hidden input in SaleForm), so this always returns false for
 * them — there's nothing here to block.
 */
export function isPartialPaymentInvalid(
  paymentStatus: "UNPAID" | "PARTIALLY_PAID" | "PAID",
  amountPaidInput: string,
  totalEstimate: number
): boolean {
  if (paymentStatus !== "PARTIALLY_PAID") return false;
  const trimmed = amountPaidInput.trim();
  const amount = Number(trimmed);
  if (trimmed === "" || !Number.isFinite(amount)) return true;
  if (amount <= 0) return true;
  if (amount >= totalEstimate) return true;
  return false;
}
