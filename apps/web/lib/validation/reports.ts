import { z } from "zod";
import { REPORT_RANGE_PRESET } from "@/lib/reports/constants";

/**
 * Client-side feedback only — get_financial_summary's own [p_from, p_to)
 * check (INVALID_REPORT_RANGE, supabase/migrations/20260827080600_get_financial_summary_rpc.sql)
 * remains the actual authority. This schema exists so a bad custom range
 * (from after to) never leaves the page as a request at all, with a safe
 * inline error instead.
 */

export const ReportRangePresetSchema = z.enum([
  REPORT_RANGE_PRESET.TODAY,
  REPORT_RANGE_PRESET.LAST_7_DAYS,
  REPORT_RANGE_PRESET.LAST_30_DAYS,
  REPORT_RANGE_PRESET.THIS_MONTH,
  REPORT_RANGE_PRESET.PREVIOUS_MONTH,
  REPORT_RANGE_PRESET.CUSTOM,
]);

// Plain YYYY-MM-DD dates from <input type="date"> — resolved to explicit
// UTC instant boundaries by lib/reports/ranges.ts's resolveCustomRange,
// never sent to the RPC as bare date strings.
export const CustomReportRangeSchema = z
  .object({
    dateFrom: z.iso.date({ error: "Enter a start date." }),
    dateTo: z.iso.date({ error: "Enter an end date." }),
  })
  .refine((data) => data.dateFrom <= data.dateTo, {
    error: "Start date must be on or before the end date.",
    path: ["dateTo"],
  });

export type CustomReportRangeInput = z.infer<typeof CustomReportRangeSchema>;
