import { getLocaleForCountry, type CurrencyCode } from "@/lib/business/country-currency";

/**
 * Consistent currency display formatting — Phase 1E's one shared money
 * formatter, used across expenses/reports/dashboard/invoices UI. Every
 * value passed in is already database-authoritative (an RPC-returned or
 * DAL-selected number, e.g. get_financial_summary's net_cash_flow or an
 * ExpenseRow's amount); this function only ever formats for DISPLAY — it
 * never recomputes a total, never rounds for storage, and its output is
 * never fed back into further arithmetic. No monetary precision/rounding
 * semantics change in Phase 1Q-0A — this file only controls presentation.
 *
 * Phase 1Q-0A extends this with an optional currency-display mode, kept
 * fully backward compatible: every existing 2-argument call site
 * (formatMoney(amount, "NGN")) is untouched and keeps returning exactly
 * "NGN 1,234.56", because `display` defaults to "code". `display: "symbol"`
 * is new, opt-in output for later phases (1Q-0C) to migrate call sites to.
 *
 * Digit grouping/decimal formatting is deliberately fixed (US-style comma
 * thousands, period decimal) regardless of `locale`, even in "symbol"
 * mode — see the phase brief's Symbol Collision / determinism rule.
 * Some locales' own Intl.NumberFormat currency output is not
 * product-deterministic (e.g. en-ZA renders ZAR with space-grouped
 * thousands and a comma decimal separator), so this formatter always
 * derives the numeric string itself and only borrows the *symbol* from a
 * fixed table, never the locale's own currency formatting. `locale` is
 * accepted for forward compatibility (future non-numeric formatting
 * needs) but does not currently affect output.
 */

// Deterministic product symbol table — overrides what Intl.NumberFormat
// would otherwise render per-locale (which is not guaranteed to match;
// e.g. USD can render "US$" and KES can render "Ksh " depending on
// locale). ISO code remains the stored/API identity everywhere; this
// table is presentation-only. A currency outside this table falls back to
// its ISO code as the "symbol" (e.g. an unsupported currency still
// displays legibly as "XYZ 1,234.56" rather than throwing).
const CURRENCY_SYMBOLS: Record<CurrencyCode, string> = {
  NGN: "₦",
  GBP: "£",
  USD: "$",
  EUR: "€",
  GHS: "GH₵",
  KES: "KSh",
  ZAR: "R",
};

export interface FormatMoneyOptions {
  /** Business display locale (see lib/business/country-currency.ts). Reserved for future use. */
  locale?: string;
  /** "code" (default, backward-compatible: "NGN 1,234.56") or "symbol" ("₦1,234.56"). */
  display?: "code" | "symbol";
}

function formatNumber(amount: number): string {
  return new Intl.NumberFormat("en-US", {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  }).format(amount);
}

function symbolFor(currencyCode: string): string {
  return CURRENCY_SYMBOLS[currencyCode as CurrencyCode] ?? currencyCode;
}

/**
 * Exported for UI surfaces that need just the symbol (e.g. an "Amount
 * (₦)" field label) without formatting a number — same deterministic
 * table `formatMoney`'s "symbol" display mode uses.
 */
export function getCurrencySymbol(currencyCode: string): string {
  return symbolFor(currencyCode);
}

export function formatMoney(
  amount: number,
  currencyCode: string,
  options?: FormatMoneyOptions
): string {
  const formatted = formatNumber(amount);
  if (options?.display === "symbol") {
    return `${symbolFor(currencyCode)}${formatted}`;
  }
  return `${currencyCode} ${formatted}`;
}

/**
 * Convenience wrapper for a business record (any object carrying its own
 * ISO country/currency, e.g. a `businesses` row) — formats in symbol mode
 * using that business's currency and country-derived locale. Not yet
 * called by any UI in Phase 1Q-0A (no call sites are migrated this phase);
 * provided for 1Q-0C to adopt without redefining the formatting contract.
 */
export function formatMoneyForBusiness(
  amount: number,
  business: { country_code: string; currency_code: string }
): string {
  return formatMoney(amount, business.currency_code, {
    display: "symbol",
    locale: getLocaleForCountry(business.country_code),
  });
}
