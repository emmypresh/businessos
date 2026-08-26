import { describe, expect, it } from "vitest";
import { buildImatchSearchValue } from "./search";

/**
 * The exact adversarial term list from the review, plus explicit
 * assertions on the ENCODED OUTPUT SHAPE (always double-quote-wrapped,
 * every POSIX-ERE metacharacter backslash-escaped) — the real proof that
 * these terms never corrupt PostgREST's .or() grammar, and never get
 * reinterpreted as pattern syntax (including the `*` case that `ilike`
 * cannot represent literally — see lib/search.ts), is the live-API test
 * in tests/integration/product-search-safety.test.ts; this file locks in
 * the encoding function's own deterministic behavior.
 */
describe("buildImatchSearchValue", () => {
  it("wraps a plain term in double quotes with no escaping needed", () => {
    expect(buildImatchSearchValue("alpha")).toBe('"alpha"');
  });

  it("never leaves a raw comma, paren, or period able to break out of the quoted value", () => {
    for (const term of [
      "alpha,beta",
      ",",
      "alpha)",
      "(alpha)",
      "(",
      "alpha.beta",
      "alpha),sku.not.is.null",
      "alpha,sku.not.is.null",
      "or(name.eq.foo)",
    ]) {
      const value = buildImatchSearchValue(term);
      // The value is exactly one quoted token: starts and ends with an
      // unescaped `"`, and every `"` in between is escaped (`\"`) — i.e.
      // there is no unescaped `"` before the final character, which is
      // what would let a comma/paren AFTER it be read as bare .or()
      // grammar instead of part of the value.
      expect(value.startsWith('"')).toBe(true);
      expect(value.endsWith('"')).toBe(true);
      const inner = value.slice(1, -1);
      // No unescaped double-quote remains inside.
      expect(inner.replace(/\\"/g, "")).not.toContain('"');
    }
  });

  it("escapes a literal double quote (PostgREST-quote layer)", () => {
    expect(buildImatchSearchValue('alpha"beta')).toBe('"alpha\\"beta"');
  });

  it("escapes every POSIX-ERE regex metacharacter so it matches itself literally", () => {
    // . ^ $ * + ? ( ) [ ] { } | \ are ERE metacharacters. Each becomes
    // \<char> at the regex layer; the outer PostgREST-quote layer then
    // doubles any backslash it finds, so a single metacharacter input
    // produces a doubled backslash in the wire value.
    expect(buildImatchSearchValue("alpha*beta")).toBe('"alpha\\\\*beta"');
    expect(buildImatchSearchValue("alpha.beta")).toBe('"alpha\\\\.beta"');
    expect(buildImatchSearchValue("alpha(beta)")).toBe('"alpha\\\\(beta\\\\)"');
    expect(buildImatchSearchValue("alpha^beta")).toBe('"alpha\\\\^beta"');
    expect(buildImatchSearchValue("alpha$beta")).toBe('"alpha\\\\$beta"');
    expect(buildImatchSearchValue("alpha|beta")).toBe('"alpha\\\\|beta"');
  });

  it("escapes a literal backslash (the regex-escaping layer doubles it, then the PostgREST-quote layer doubles again)", () => {
    // Layer 1 (regex): \ -> \\. Layer 2 (PostgREST quoting): each \ -> \\.
    // Net: one input backslash becomes four backslash characters in the
    // wire value, which decodes back to exactly one literal backslash
    // after both layers unescape — verified end-to-end against the real
    // API in the integration test.
    expect(buildImatchSearchValue("alpha\\beta")).toBe('"alpha\\\\\\\\beta"');
  });

  it("% and _ pass through unescaped (they are not regex metacharacters, so imatch matches them as plain text)", () => {
    expect(buildImatchSearchValue("alpha%beta")).toBe('"alpha%beta"');
    expect(buildImatchSearchValue("alpha_beta")).toBe('"alpha_beta"');
  });

  it("single quotes and colons pass through unescaped (harmless inside PostgREST's quoted value and not regex metacharacters)", () => {
    expect(buildImatchSearchValue("alpha'beta")).toBe('"alpha\'beta"');
    expect(buildImatchSearchValue("alpha:beta")).toBe('"alpha:beta"');
  });

  it("an empty term still produces a valid quoted value (matches everything via an empty pattern, not an error)", () => {
    expect(buildImatchSearchValue("")).toBe('""');
  });
});
