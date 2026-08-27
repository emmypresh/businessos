import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

/**
 * STATIC SOURCE GUARD tests — Codex adversarial review, Finding 7.H and
 * 7.I (named honestly per the 2nd-pass review's own instruction: these
 * are source-text inspections, not rendered-DOM or runtime-call-count
 * assertions).
 *
 * Both properties under test here (the KPI card displays the server's
 * own net_cash_flow field rather than recomputing it; the /reports route
 * never queries raw sales/expenses) are structural, RSC-boundary
 * properties of files that this project's test harness cannot render or
 * dynamically spy on: there is no React rendering environment configured
 * for Server/Client Components (vitest.config.ts runs `environment:
 * "node"`, no jsdom/testing-library), and app/[businessId]/reports/page.tsx
 * is an async Server Component — Next.js's own module resolution, not a
 * plain function call, so mocking `@/lib/expenses/dal`/`@/lib/sales/dal`
 * the way tests/integration/*-action-auth.test.ts mocks
 * `@/lib/supabase/server` would only prove those modules AREN'T called
 * during THIS test file's own act of importing them — it would not
 * prove the real Next.js request pipeline never calls them, and would
 * silently stop meaning anything the moment someone renamed an import.
 *
 * Given that, this file inspects the actual committed SOURCE TEXT of the
 * two files in question — an honest, if structural, check: it fails the
 * moment the offending pattern (a raw subtraction recomputing net cash
 * flow, or an import/reference to listSales/listExpenses) is
 * (re)introduced, which is exactly the regression these two findings are
 * about. It does not, and does not claim to, prove anything about
 * runtime call counts or rendered output.
 */

function readSource(relativePath: string): string {
  return readFileSync(resolve(__dirname, "../..", relativePath), "utf8");
}

/**
 * A deliberately simple (not a real parser) comment stripper — good
 * enough for this project's own TSX source, which has no string literal
 * containing `//` or `/*` sequences that would confuse it (verified by
 * inspection of both files this module reads). Used ONLY so the
 * recomputation guard below can't be defeated by a false positive
 * inside an explanatory comment (exactly the failure the 1st-pass
 * review's own listSales/listExpenses check had, before being fixed to
 * require call-syntax) — never used to hide a genuine code match.
 */
function stripComments(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/.*$/gm, "");
}

// Matches "cashCollected"/"cash_collected", optionally immediately
// followed by a closing bracket/quote (for `summary["cashCollected"]`
// forms), then a `-`, then an OPTIONAL simple qualifier (`identifier.`
// or `identifier[` + optional opening quote — covers `summary.expenses`
// and `summary["expenses"]`), then "expenses". Checked in both field
// orders. This is what actually catches the qualified forms Codex's
// 2nd-pass review pointed out the 1st-pass regex missed entirely
// (`summary.cashCollected - summary.expenses`): the 1st-pass pattern
// required "expenses" immediately after the `-`, with no allowance for
// a `summary.`/`summary["` prefix in between.
const QUALIFIER = String.raw`(?:\w+\.|\w+\[["']?)?`;
const CASH_COLLECTED = String.raw`cash[_]?collected["'\]]*`;
const EXPENSES = String.raw`${QUALIFIER}expenses`;
const RECOMPUTE_FORWARD = new RegExp(`${CASH_COLLECTED}\\s*-\\s*${EXPENSES}`, "i");
const RECOMPUTE_REVERSED = new RegExp(`expenses["'\\]]*\\s*-\\s*${QUALIFIER}cash[_]?collected`, "i");

describe("Finding 7.H (STATIC SOURCE GUARD) — FinancialKpiCards displays the server's net_cash_flow field, never a client recomputation", () => {
  const source = readSource("components/reports/financial-kpi-cards.tsx");
  const codeOnly = stripComments(source);

  it("reads summary.netCashFlow directly", () => {
    expect(codeOnly).toMatch(/summary\.netCashFlow/);
  });

  it("never recomputes it from cashCollected and expenses — covers bare, dotted (summary.x), and bracket (summary[\"x\"]) forms, either field order", () => {
    expect(codeOnly).not.toMatch(RECOMPUTE_FORWARD);
    expect(codeOnly).not.toMatch(RECOMPUTE_REVERSED);
  });

  // Positive control — proves the regex above actually catches the
  // patterns it claims to, rather than being vacuously unmatchable. Not
  // testing production source; testing the GUARD itself.
  it("[guard self-test] the recompute pattern DOES match known-bad qualified forms", () => {
    const badSamples = [
      "const net = cashCollected - expenses;",
      "const net = summary.cashCollected - summary.expenses;",
      'const net = summary["cashCollected"] - summary["expenses"];',
      "const net = cash_collected - expenses;",
      "const net = expenses - cashCollected;",
      "const net = summary.expenses - summary.cashCollected;",
    ];
    for (const sample of badSamples) {
      const matches = RECOMPUTE_FORWARD.test(sample) || RECOMPUTE_REVERSED.test(sample);
      expect(matches, sample).toBe(true);
    }
  });

  // Positive control for the comment-stripping itself — proves a
  // recompute-shaped string INSIDE a comment does not fail the file
  // (documentation mentioning the pattern by name must remain legal).
  it("[guard self-test] a recompute-shaped string inside a comment is not flagged", () => {
    const withComment = "// never write cashCollected - expenses here\nconst x = 1;";
    const stripped = stripComments(withComment);
    expect(stripped).not.toMatch(RECOMPUTE_FORWARD);
  });

  it("the shipped helper text ('cash collected − expenses', prose with a space, not code) is not flagged", () => {
    // Confirms the guard's own specificity: this exact visible UI string
    // exists in the real file (components/reports/financial-kpi-cards.tsx)
    // and must NOT trip the recompute guard — "cash collected" (two
    // words, a space) is prose, not the identifier "cashCollected"/
    // "cash_collected" the guard looks for.
    expect(source).toMatch(/cash collected . expenses/);
    expect(codeOnly).not.toMatch(RECOMPUTE_FORWARD);
  });
});

describe("Finding 7.I (STATIC SOURCE GUARD) — the /reports route never queries raw sales/expenses", () => {
  const source = readSource("app/[businessId]/reports/page.tsx");
  const codeOnly = stripComments(source);

  it("imports getFinancialSummary from lib/reports/dal — the sole data-access call this route makes", () => {
    expect(codeOnly).toMatch(/from "@\/lib\/reports\/dal"/);
    expect(codeOnly).toMatch(/getFinancialSummary/);
  });

  it("never imports lib/expenses/dal or lib/sales/dal", () => {
    expect(codeOnly).not.toMatch(/from "@\/lib\/expenses\/dal"/);
    expect(codeOnly).not.toMatch(/from "@\/lib\/sales\/dal"/);
  });

  it("never actually CALLS listExpenses or listSales (call-syntax, not merely the word appearing in a comment)", () => {
    // Deliberately call-syntax (`name(`), not a bare word-boundary match
    // — the RAW source's own explanatory comment mentions both names in
    // prose ("do not add a listSales/listExpenses call to this file"),
    // which is exactly the kind of true documentation this check must
    // not flag. Checked against the comment-stripped text too, so this
    // guard doesn't depend solely on the call-syntax requirement to stay
    // honest.
    expect(source).not.toMatch(/\blistExpenses\s*\(/);
    expect(source).not.toMatch(/\blistSales\s*\(/);
    expect(codeOnly).not.toMatch(/\blistExpenses\b/);
    expect(codeOnly).not.toMatch(/\blistSales\b/);
  });
});

describe("Finding 7.E (STATIC SOURCE GUARD) — DateRangePicker actually renders the UTC labels/helper text, not a hardcoded/diverged copy", () => {
  const source = readSource("components/reports/date-range-picker.tsx");
  const codeOnly = stripComments(source);

  it("imports REPORT_RANGE_PRESET_LABEL and REPORT_RANGE_UTC_HELPER_TEXT from lib/reports/constants (the single source of truth pinned by lib/reports/constants.test.ts)", () => {
    expect(codeOnly).toMatch(/from "@\/lib\/reports\/constants"/);
    expect(codeOnly).toMatch(/\bREPORT_RANGE_PRESET_LABEL\b/);
    expect(codeOnly).toMatch(/\bREPORT_RANGE_UTC_HELPER_TEXT\b/);
  });

  it("actually renders REPORT_RANGE_PRESET_LABEL as each SelectItem's visible content — not merely imported and unused", () => {
    expect(codeOnly).toMatch(/\{REPORT_RANGE_PRESET_LABEL\[[^\]]+\]\}/);
  });

  it("actually renders REPORT_RANGE_UTC_HELPER_TEXT as visible text — not merely imported and unused", () => {
    expect(codeOnly).toMatch(/\{REPORT_RANGE_UTC_HELPER_TEXT\}/);
  });

  it("the helper text is NOT gated behind the CUSTOM-only conditional block — it renders regardless of which preset is selected", () => {
    // The custom date <Input> pair is the only content inside the
    // `preset === REPORT_RANGE_PRESET.CUSTOM ? (...) : null` block;
    // REPORT_RANGE_UTC_HELPER_TEXT must appear OUTSIDE that block's own
    // JSX so it's visible for every preset, not just "custom".
    const customBlockMatch = codeOnly.match(
      /preset === REPORT_RANGE_PRESET\.CUSTOM \? \(([\s\S]*?)\) : null/
    );
    expect(customBlockMatch, "expected to find the CUSTOM-only conditional block").not.toBeNull();
    expect(customBlockMatch![1]).not.toMatch(/REPORT_RANGE_UTC_HELPER_TEXT/);
  });
});
