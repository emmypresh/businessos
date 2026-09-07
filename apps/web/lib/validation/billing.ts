import { z } from "zod";

// Server-authoritative from here: the Server Action re-reads the
// referenced price row itself (lib/billing/actions.ts) — this schema
// only proves the SHAPE of what the form submitted is a well-formed
// identifier, never that it is safe to trust for amount/currency/plan.
export const CheckoutInitSchema = z.object({
  priceId: z.uuid(),
});
