import { z } from "zod";

export const StockAdjustmentSchema = z.object({
  idempotencyKey: z.uuid(),
  productId: z.uuid(),
  // Phase 1G: the NEW UI's own branch select (stock-adjustment-form.tsx)
  // guides the caller to an explicit choice, resolved to that branch's
  // real, current canonical location server-side — but this schema
  // itself leaves branchId OPTIONAL at the validation boundary. A legacy
  // caller of this action that never sends branchId at all (the
  // pre-Phase-1G calling shape) must still reach
  // record_inventory_movement's own approved legacy-default-location
  // compatibility alias (Medium 2C) rather than being rejected here.
  // Codex adversarial review, application-layer round 2, Blocker 5.
  branchId: z.uuid({ error: "Choose a valid branch." }).optional(),
  direction: z.enum(["increase", "decrease"], { error: "Choose a direction." }),
  quantity: z
    .coerce
    .number({ error: "Enter a valid quantity." })
    .positive({ error: "Quantity must be greater than zero." }),
  reason: z
    .string()
    .trim()
    .min(3, { error: "Reason must be at least 3 characters." })
    .max(500, { error: "Reason must be 500 characters or fewer." }),
  note: z
    .string()
    .trim()
    .max(1000)
    .optional()
    .transform((v) => (v ? v : undefined)),
});

export type StockAdjustmentInput = z.infer<typeof StockAdjustmentSchema>;

export const HistoryFilterSchema = z.object({
  productId: z.uuid().optional(),
  cursor: z.string().optional(),
});

export type HistoryFilterInput = z.infer<typeof HistoryFilterSchema>;
