import { z } from "zod";

// Client-side feedback only, mirroring lib/validation/business.ts's own
// philosophy — the database's CHECK constraints and create_product's own
// normalization remain the actual authority. Numeric fields use
// z.coerce.number() to accept FormData's string values; no arithmetic is
// ever performed on the parsed result here or anywhere in the app —
// every authoritative number is either untouched user input passed
// straight to the RPC, or a value read back from the database.

const money = z
  .coerce
  .number({ error: "Enter a valid amount." })
  .min(0, { error: "Amount cannot be negative." })
  .max(999_999_999.99, { error: "Amount is too large." });

const quantity = z
  .coerce
  .number({ error: "Enter a valid quantity." })
  .min(0, { error: "Quantity cannot be negative." });

const optionalTrimmed = (max: number) =>
  z
    .string()
    .trim()
    .max(max)
    .optional()
    .transform((v) => (v ? v : undefined));

export const CreateProductSchema = z
  .object({
    creationKey: z.uuid(),
    name: z
      .string()
      .trim()
      .min(2, { error: "Name must be at least 2 characters." })
      .max(200, { error: "Name must be 200 characters or fewer." }),
    description: optionalTrimmed(2000),
    sku: optionalTrimmed(64),
    barcode: optionalTrimmed(64),
    category: optionalTrimmed(100),
    unit: z.string().trim().min(1).max(20).default("unit"),
    // costPrice is intentionally NOT required here — a caller lacking
    // inventory.view_cost never has this field in their form at all
    // (see components/products/product-form.tsx), and the Server Action
    // re-derives whether to honor it from the caller's own permission
    // set, never from whether this field is present in the parsed data.
    costPrice: money.optional(),
    sellingPrice: money.default(0),
    trackInventory: z
      .union([z.literal("on"), z.literal("true"), z.boolean()])
      .transform((v) => v === "on" || v === "true" || v === true)
      .default(true),
    lowStockThreshold: quantity.optional(),
    openingQuantity: quantity.optional(),
  })
  .refine((data) => !data.trackInventory || Boolean(data.sku), {
    error: "SKU is required when inventory tracking is enabled.",
    path: ["sku"],
  });

export type CreateProductInput = z.infer<typeof CreateProductSchema>;

// Deliberately excludes: id, businessId, createdBy, creationKey,
// trackInventory — none of these are editable after creation (the last
// is a database-enforced immutable field; the first three are simply
// never user input). costPrice is present in the SHAPE but, per the cost
// write permission rule, the Server Action only ever includes it in the
// actual UPDATE payload when the caller holds inventory.view_cost.
export const UpdateProductSchema = z.object({
  name: z
    .string()
    .trim()
    .min(2, { error: "Name must be at least 2 characters." })
    .max(200, { error: "Name must be 200 characters or fewer." }),
  description: optionalTrimmed(2000),
  sku: optionalTrimmed(64),
  barcode: optionalTrimmed(64),
  category: optionalTrimmed(100),
  unit: z.string().trim().min(1).max(20),
  costPrice: money.optional(),
  sellingPrice: money,
  lowStockThreshold: quantity.optional(),
});

export type UpdateProductInput = z.infer<typeof UpdateProductSchema>;

export const ProductFilterSchema = z.object({
  search: z.string().trim().max(200).optional(),
  status: z.enum(["active", "archived"]).optional(),
});

export type ProductFilterInput = z.infer<typeof ProductFilterSchema>;
