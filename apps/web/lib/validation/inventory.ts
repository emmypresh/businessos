import { z } from "zod";

export const StockAdjustmentSchema = z.object({
  idempotencyKey: z.uuid(),
  productId: z.uuid(),
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
