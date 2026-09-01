import { z } from "zod";
import { MAX_INVOICE_ITEMS, PAYMENT_METHOD } from "@/lib/invoices/constants";
import { isValidOffsetBearingInstant } from "@/lib/date/iso-instant";

/**
 * Client-side feedback only — create_invoice's/record_invoice_payment's/
 * void_invoice's own validation
 * (supabase/migrations/20260831080200_create_invoice_creation_rpc.sql,
 * supabase/migrations/20260831080400_record_invoice_payment_rpc.sql,
 * supabase/migrations/20260831080500_invoice_void_rpc.sql) remains the
 * actual authority. Every rule here mirrors those RPCs' exact contracts.
 */

const MAX_MONEY = 999_999_999_999.99;

// Codex adversarial review, remediation round 1, Medium 1: the previous
// `z.coerce.number()`-based `money` schema coerced its input to a JS
// `number` BEFORE any decimal-precision check ever ran — a value like
// 1.999 or 100.001 would coerce cleanly (JS numbers have no concept of
// "decimal places" at all) and simply pass through unrejected, silently
// reaching the database with excess precision (where create_invoice's
// own round-trip check, create_invoice_rpc.sql, would catch it — but the
// review requires this rejected at BOTH boundaries, not just the DB).
// Validated as a STRING first instead — regex-checked for AT MOST 2
// decimal places BEFORE any numeric coercion, mirroring
// PaymentAmountSchema's own already-correct pattern below (which this
// now shares verbatim, renamed to reflect that both a custom invoice
// line's unit price and a payment amount are the exact same "money,
// caller-authoritative, at most 2 decimal places" shape) — excess
// precision is REJECTED, never silently rounded. 1.999/0.005/100.001 all
// fail the regex; 0.01/1/1.5/1.50/1.99 all pass.
export const MoneyAmountSchema = z
  .string()
  .trim()
  .regex(/^\d+(\.\d{1,2})?$/, { error: "Enter an amount with up to 2 decimal places." })
  .transform((v) => Number(v))
  .refine((v) => v >= 0, { error: "Amount cannot be negative." })
  .refine((v) => v <= MAX_MONEY, { error: "Amount is too large." });

// Validated as a STRING first — regex-checked for AT MOST 3 decimal
// places BEFORE any numeric coercion, mirroring lib/validation/sales.ts's
// saleQuantity schema's own exact round-trip technique — excess
// precision is REJECTED, never silently rounded.
const invoiceQuantity = z
  .string()
  .trim()
  .regex(/^\d+(\.\d{1,3})?$/, {
    error: "Quantity must be a positive number with up to 3 decimal places.",
  })
  .transform((v) => Number(v))
  .refine((v) => v > 0, { error: "Quantity must be greater than zero." })
  .refine((v) => v <= 1_000_000, { error: "Quantity is too large." });

// An invoice line is EITHER product-linked (productId set — unit_price is
// always server-authoritative, the current selling_price, never accepted
// from the client at all) OR custom (no productId — description AND
// unitPrice are both required, since there is no product row to derive
// either from). Mirrors create_invoice's own exact two-shape contract.
export const InvoiceItemSchema = z
  .object({
    productId: z.uuid().optional(),
    description: z.string().trim().max(500).optional(),
    quantity: invoiceQuantity,
    unitPrice: MoneyAmountSchema.optional(),
  })
  .refine((data) => data.productId || (data.description && data.description.length > 0), {
    error: "Enter a description or choose a product.",
    path: ["description"],
  })
  .refine((data) => data.productId || data.unitPrice !== undefined, {
    error: "Enter a unit price.",
    path: ["unitPrice"],
  });

export type InvoiceItemInput = z.infer<typeof InvoiceItemSchema>;

export const CreateInvoiceSchema = z.object({
  creationKey: z.uuid(),
  customerId: z.uuid({ error: "Choose a customer." }),
  branchId: z.uuid({ error: "Choose a valid branch." }),
  items: z
    .array(InvoiceItemSchema)
    .min(1, { error: "Add at least one item." })
    .max(MAX_INVOICE_ITEMS, { error: `An invoice can have at most ${MAX_INVOICE_ITEMS} lines.` })
    // Client-side duplicate-line UX guard, mirroring create_invoice's own
    // DUPLICATE_PRODUCT_LINE rejection — the RPC remains the actual
    // defense; this only gives the user a clear message before the round
    // trip. Only product-linked lines participate — two custom lines are
    // never considered duplicates of each other.
    .refine(
      (items) => {
        const productIds = items.map((i) => i.productId).filter((id): id is string => Boolean(id));
        return new Set(productIds).size === productIds.length;
      },
      { error: "Each product can only appear once — combine the quantity into one line instead.", path: ["items"] }
    ),
  dueDate: z.iso.date().optional(),
  notes: z
    .string()
    .trim()
    .max(2000)
    .optional()
    .transform((v) => (v ? v : undefined)),
});

export type CreateInvoiceInput = z.infer<typeof CreateInvoiceSchema>;

export const InvoiceFilterSchema = z.object({
  search: z.string().trim().max(200).optional(),
  status: z.enum(["ISSUED", "PARTIALLY_PAID", "PAID", "VOID"]).optional(),
  branchId: z.uuid().optional(),
  overdueOnly: z.boolean().optional(),
});

export type InvoiceFilterInput = z.infer<typeof InvoiceFilterSchema>;

// Shares MoneyAmountSchema's exact string-regex round-trip check, adding
// the one rule specific to a payment (never zero — a custom invoice
// line's unit price legitimately CAN be 0, e.g. a free promotional line,
// but a payment of exactly 0 is meaningless).
export const PaymentAmountSchema = MoneyAmountSchema.refine((v) => v > 0, {
  error: "Amount must be greater than zero.",
});

// Codex adversarial review, remediation round 2, Medium 2: an EXPLICIT,
// offset-bearing UTC instant ONLY — never a bare "wall clock" string.
// components/invoices/payment-form.tsx's own paidAtIso already converts
// the visible datetime-local value to a real instant IN THE BROWSER
// (`new Date(localValue).toISOString()`, which always carries a
// trailing `Z`) before it's ever submitted — this schema is the SERVER
// boundary that must independently reject anything that skipped that
// conversion (a hand-crafted form submission, a direct action call,
// browser quirks), rather than trusting `Date.parse()` alone.
// `Date.parse()` happily accepts a timezone-less string like
// "2026-08-31T15:30" and silently interprets it in the RUNNING
// PROCESS's own local timezone — exactly the server-timezone-dependent
// bug this schema exists to close off.
//
// Codex adversarial review, remediation round 3 ("Semantically Invalid
// ISO Calendar Dates"): shape alone is not enough either.
// `Date.parse()`/`new Date(...)` NORMALIZE an impossible calendar date
// instead of rejecting it — "2026-02-30T15:30:00Z" silently becomes
// March 2nd, never NaN — so relying on `!Number.isNaN(Date.parse(v))`
// for semantic validity let an invalid date straight through to
// record_invoice_payment, where PostgreSQL's own real calendar
// arithmetic then failed it late with a raw SQLSTATE 22008. Replaced
// with isValidOffsetBearingInstant (lib/date/iso-instant.ts), a small,
// dedicated regex-capture + explicit-range + real-calendar-arithmetic
// validator (Gregorian leap years included) that never delegates the
// "is this real" question to JS's own normalizing date parser.
// `Date.parse` is still used below for the future-date grace-window
// check ONLY — safe at that point, since every calendar component has
// already been proven real.
export const PaymentPaidAtSchema = z
  .string()
  .min(1, { error: "Enter when this payment was received." })
  .refine(isValidOffsetBearingInstant, {
    error: "Enter a valid date and time.",
  })
  .refine((v) => Date.parse(v) <= Date.now() + 24 * 60 * 60 * 1000, {
    error: "Date cannot be in the future.",
  });

export const RecordInvoicePaymentSchema = z.object({
  creationKey: z.uuid(),
  invoiceId: z.uuid(),
  amount: PaymentAmountSchema,
  paymentMethod: z.enum(
    [PAYMENT_METHOD.CASH, PAYMENT_METHOD.BANK_TRANSFER, PAYMENT_METHOD.POS_CARD, PAYMENT_METHOD.OTHER],
    { error: "Choose a payment method." }
  ),
  paidAt: PaymentPaidAtSchema,
  reference: z
    .string()
    .trim()
    .max(200)
    .optional()
    .transform((v) => (v ? v : undefined)),
  note: z
    .string()
    .trim()
    .max(500)
    .optional()
    .transform((v) => (v ? v : undefined)),
});

export type RecordInvoicePaymentInput = z.infer<typeof RecordInvoicePaymentSchema>;

// Shared UUID identifier check for every Phase 1H Server Action's
// businessId/invoiceId form fields — mirrors lib/validation/expenses.ts's
// own IdSchema exactly: a malformed value is rejected before any
// permission lookup or database call, never reaching Postgres as a raw
// ::uuid cast.
export const IdSchema = z.uuid();
