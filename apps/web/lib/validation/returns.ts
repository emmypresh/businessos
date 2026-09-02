import { z } from "zod";
import { MAX_RETURN_ITEMS, REFUND_METHOD, RETURN_REASON } from "@/lib/returns/constants";

/**
 * Client/Server-Action-side feedback only — create_sale_return's own
 * validation (supabase/migrations/20260901080300_create_sale_return_rpc.sql)
 * remains the actual authority. Every rule here mirrors that RPC's exact
 * contract. Object schemas are `.strict()` at this application boundary —
 * the DB itself safely ignores forged extra JSON keys (proven live during
 * Phase 1I's own security self-review), but an unknown field is better
 * rejected here with a clear error than silently dropped, per this
 * round's own explicit instruction.
 */

const MAX_MONEY = 999_999_999_999.99;

// Shares MoneyAmountSchema's exact string-regex round-trip technique
// (lib/validation/invoices.ts) — kept as its own copy, not a shared
// import, since a refund amount and a payment/invoice-line amount are
// independently evolvable domains that only coincide in shape today.
export const RefundAmountSchema = z
  .string()
  .trim()
  .regex(/^\d+(\.\d{1,2})?$/, { error: "Enter an amount with up to 2 decimal places." })
  .transform((v) => Number(v))
  .refine((v) => v >= 0, { error: "Amount cannot be negative." })
  .refine((v) => v <= MAX_MONEY, { error: "Amount is too large." });

// Validated as a STRING first — regex-checked for AT MOST 3 decimal
// places BEFORE any numeric coercion, mirroring
// lib/validation/invoices.ts's own invoiceQuantity/lib/validation/sales.ts's
// own saleQuantity exact round-trip technique.
export const ReturnQuantitySchema = z
  .string()
  .trim()
  .regex(/^\d+(\.\d{1,3})?$/, {
    error: "Quantity must be a positive number with up to 3 decimal places.",
  })
  .transform((v) => Number(v))
  .refine((v) => v > 0, { error: "Quantity must be greater than zero." })
  .refine((v) => v <= 1_000_000, { error: "Quantity is too large." });

export const ReturnItemSchema = z
  .object({
    saleItemId: z.uuid({ error: "Choose a valid item." }),
    quantity: ReturnQuantitySchema,
    restock: z.boolean(),
  })
  .strict();

export type ReturnItemInput = z.infer<typeof ReturnItemSchema>;

export const RETURN_REASON_VALUES = [
  RETURN_REASON.CUSTOMER_RETURN,
  RETURN_REASON.DAMAGED,
  RETURN_REASON.WRONG_ITEM,
  RETURN_REASON.DEFECTIVE,
  RETURN_REASON.OTHER,
] as const;

export const REFUND_METHOD_VALUES = [
  REFUND_METHOD.CASH,
  REFUND_METHOD.BANK_TRANSFER,
  REFUND_METHOD.POS_CARD,
  REFUND_METHOD.OTHER,
] as const;

export const CreateSaleReturnSchema = z
  .object({
    creationKey: z.uuid(),
    saleId: z.uuid({ error: "Choose a sale." }),
    items: z
      .array(ReturnItemSchema)
      .min(1, { error: "Select at least one item to return." })
      .max(MAX_RETURN_ITEMS, { error: `A return can have at most ${MAX_RETURN_ITEMS} lines.` })
      // Client-side duplicate-line UX guard, mirroring create_sale_return's
      // own DUPLICATE_SALE_ITEM_LINE rejection — the RPC remains the
      // actual defense.
      .refine(
        (items) => {
          const ids = items.map((i) => i.saleItemId);
          return new Set(ids).size === ids.length;
        },
        { error: "Each item can only appear once — combine the quantity into one line instead.", path: ["items"] }
      ),
    refundAmount: RefundAmountSchema,
    refundMethod: z.enum(REFUND_METHOD_VALUES).optional(),
    reason: z.enum(RETURN_REASON_VALUES).optional(),
    notes: z
      .string()
      .trim()
      .max(2000)
      .optional()
      .transform((v) => (v ? v : undefined)),
  })
  .strict()
  // Mirrors create_sale_return's own exact biconditional: refund_method is
  // required exactly when there is money to refund, and structurally
  // absent otherwise.
  .refine((data) => data.refundAmount === 0 || data.refundMethod !== undefined, {
    error: "Choose a refund method.",
    path: ["refundMethod"],
  })
  .refine((data) => data.refundAmount > 0 || data.refundMethod === undefined, {
    error: "A refund method cannot be set when the refund amount is 0.",
    path: ["refundMethod"],
  });

export type CreateSaleReturnInput = z.infer<typeof CreateSaleReturnSchema>;

export const ReturnFilterSchema = z.object({
  search: z.string().trim().max(200).optional(),
  branchId: z.uuid().optional(),
  reason: z.enum(RETURN_REASON_VALUES).optional(),
});

export type ReturnFilterInput = z.infer<typeof ReturnFilterSchema>;

// Shared UUID identifier check for every Phase 1I Server Action's
// businessId/saleId/returnId form fields — mirrors
// lib/validation/invoices.ts's own IdSchema exactly.
export const IdSchema = z.uuid();
