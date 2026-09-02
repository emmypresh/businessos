import { z } from "zod";
import { AUDIT_CATEGORY } from "@/lib/audit/constants";

/**
 * Client/DAL-side filter validation for the Activity feed. The RLS
 * policy on public.audit_events (returns.view-style, gated on
 * audit.view) remains the actual read-authority boundary; this schema
 * only shapes/bounds the filter inputs before they reach a query.
 */

const CATEGORY_VALUES = [
  AUDIT_CATEGORY.COMMERCE,
  AUDIT_CATEGORY.INVENTORY,
  AUDIT_CATEGORY.FINANCE,
  AUDIT_CATEGORY.CUSTOMER,
  AUDIT_CATEGORY.ORGANIZATION,
  AUDIT_CATEGORY.SECURITY,
  AUDIT_CATEGORY.SYSTEM,
] as const;

export const ActivityFilterSchema = z.object({
  search: z.string().trim().max(200).optional(),
  category: z.enum(CATEGORY_VALUES).optional(),
  branchId: z.uuid().optional(),
  actorUserId: z.uuid().optional(),
  dateFrom: z.iso.date().optional(),
  dateTo: z.iso.date().optional(),
});

export type ActivityFilterInput = z.infer<typeof ActivityFilterSchema>;

// Shared UUID identifier check for the Activity feed's own businessId/
// eventId route params — mirrors every other Phase 1C-1J domain's own
// IdSchema exactly.
export const IdSchema = z.uuid();
