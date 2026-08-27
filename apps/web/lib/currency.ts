/**
 * Consistent NGN/currency display formatting — Phase 1E's one shared
 * money formatter, used by both the expenses and reports UI. Every value
 * passed in is already database-authoritative (an RPC-returned or
 * DAL-selected number, e.g. get_financial_summary's net_cash_flow or an
 * ExpenseRow's amount); this function only ever formats for DISPLAY — it
 * never recomputes a total, never rounds for storage, and its output is
 * never fed back into further arithmetic.
 */
export function formatMoney(amount: number, currencyCode: string): string {
  const formatted = new Intl.NumberFormat("en-NG", {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  }).format(amount);
  return `${currencyCode} ${formatted}`;
}
