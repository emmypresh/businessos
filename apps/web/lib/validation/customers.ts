import { z } from "zod";

/**
 * Client-side feedback only, mirroring lib/validation/products.ts's own
 * philosophy — create_customer's own validation (which mirrors the
 * customers table's CHECK constraints exactly, see
 * supabase/migrations/20260826090100_create_customer_creation_requests_and_rpc.sql)
 * remains the actual authority. Every rule here matches that RPC's rule
 * one-for-one so a form never lets a request through that the database
 * would reject anyway, but the RPC's own validation is what's actually
 * trusted.
 */

const optionalTrimmed = (max: number) =>
  z
    .string()
    .trim()
    .max(max)
    .optional()
    .transform((v) => (v ? v : undefined));

export const CreateCustomerSchema = z.object({
  creationKey: z.uuid(),
  name: z
    .string()
    .trim()
    .min(2, { error: "Name must be at least 2 characters." })
    .max(200, { error: "Name must be 200 characters or fewer." }),
  phone: optionalTrimmed(32),
  email: optionalTrimmed(254).refine(
    (v) => v === undefined || /^[^@\s]+@[^@\s]+\.[^@\s]+$/i.test(v),
    { error: "Enter a valid email address." }
  ),
  address: optionalTrimmed(500),
  notes: optionalTrimmed(2000),
});

export type CreateCustomerInput = z.infer<typeof CreateCustomerSchema>;

// Deliberately excludes: id, businessId, createdBy, createdAt — none of
// these are editable after creation. `status` supports the three-state
// active/inactive/archived transition (no hard delete).
export const UpdateCustomerSchema = z.object({
  name: z
    .string()
    .trim()
    .min(2, { error: "Name must be at least 2 characters." })
    .max(200, { error: "Name must be 200 characters or fewer." }),
  phone: optionalTrimmed(32),
  email: optionalTrimmed(254).refine(
    (v) => v === undefined || /^[^@\s]+@[^@\s]+\.[^@\s]+$/i.test(v),
    { error: "Enter a valid email address." }
  ),
  address: optionalTrimmed(500),
  notes: optionalTrimmed(2000),
  status: z.enum(["active", "inactive", "archived"]),
});

export type UpdateCustomerInput = z.infer<typeof UpdateCustomerSchema>;

export const CustomerFilterSchema = z.object({
  search: z.string().trim().max(200).optional(),
  status: z.enum(["active", "inactive", "archived"]).optional(),
});

export type CustomerFilterInput = z.infer<typeof CustomerFilterSchema>;
