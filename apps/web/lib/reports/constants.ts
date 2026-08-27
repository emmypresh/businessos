// Phase 1E financial overview. Mirrors get_financial_summary's exact
// returned shape — see
// supabase/migrations/20260827080600_get_financial_summary_rpc.sql.
// Deliberately does NOT include profit/gross profit/net profit/margin/
// COGS/tax — those are not calculated anywhere in Phase 1E, and no
// constant, label, or helper in this module ever introduces them.

export const REPORT_RANGE_PRESET = {
  TODAY: "today",
  LAST_7_DAYS: "last_7_days",
  LAST_30_DAYS: "last_30_days",
  THIS_MONTH: "this_month",
  PREVIOUS_MONTH: "previous_month",
  CUSTOM: "custom",
} as const;

export type ReportRangePreset =
  (typeof REPORT_RANGE_PRESET)[keyof typeof REPORT_RANGE_PRESET];

// Every relative preset is labeled "(UTC)" explicitly — the range
// arithmetic (lib/reports/ranges.ts) is correct, but without this label
// the words "Today"/"This month"/etc. read as the viewer's own local
// calendar, when they actually describe UTC calendar periods (no
// per-business timezone setting exists yet — see ranges.ts's own header
// comment). This is a UX-semantics fix only (Codex adversarial review,
// Finding 2): no range arithmetic changed, no business-timezone support
// invented. CUSTOM has no "(UTC)" suffix of its own — the reports page
// instead shows explicit UTC helper copy next to the custom date inputs,
// which is clearer than folding it into a single word.
export const REPORT_RANGE_PRESET_LABEL: Record<ReportRangePreset, string> = {
  [REPORT_RANGE_PRESET.TODAY]: "Today (UTC)",
  [REPORT_RANGE_PRESET.LAST_7_DAYS]: "Last 7 days (UTC)",
  [REPORT_RANGE_PRESET.LAST_30_DAYS]: "Last 30 days (UTC)",
  [REPORT_RANGE_PRESET.THIS_MONTH]: "This month (UTC)",
  [REPORT_RANGE_PRESET.PREVIOUS_MONTH]: "Previous month (UTC)",
  [REPORT_RANGE_PRESET.CUSTOM]: "Custom",
};

// Concise, professional helper copy — shown once near the range control
// (not repeated per-preset) so the UTC-boundary caveat is visible
// regardless of which preset or custom range is selected.
export const REPORT_RANGE_UTC_HELPER_TEXT =
  "Reporting periods use UTC. Business timezone settings are not yet available.";
