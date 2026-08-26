/**
 * Encodes a raw user search term into a value that PostgREST's `.or()`/
 * `.filter()` grammar treats as an OPAQUE LITERAL — never as filter
 * syntax (comma-separated conditions, `.`-separated column/operator/
 * value segments, `(`/`)` and/or grouping) and never as a pattern-match
 * wildcard.
 *
 * Root cause history:
 *
 * 1. `listProducts`'s search originally interpolated the raw term
 *    directly into a hand-built `.or()` string
 *    (`name.ilike.%${term}%,sku.ilike.%${term}%`), escaping only `%`/`_`
 *    for LIKE purposes. A term containing `,`, `(`, `)`, or `.` altered
 *    the filter's own grouping/columns/operators instead of being
 *    matched as text — e.g. a comma injected an extra condition, and `)`
 *    could close a group early and broaden the result set within the
 *    same tenant.
 * 2. That was fixed by wrapping the LIKE pattern in a PostgREST-quoted
 *    value (this module's `quoteForPostgrestFilterValue`). That closed
 *    the grammar-injection hole, but a literal `*` in the search term
 *    still matched unrelated rows: PostgREST's `like`/`ilike` filter
 *    operators unconditionally treat `*` as an alias for `%` in the
 *    pattern VALUE — "to avoid URL encoding you can use * as an alias of
 *    the percent sign %" (PostgREST docs) — and this substitution is
 *    applied by PostgREST itself, independent of quoting, with no escape
 *    sequence that survives it. Confirmed empirically: a raw HTTP
 *    request bypassing supabase-js entirely, `GET
 *    .../products?name=ilike.%25*%25`, still matched a row containing no
 *    `*` at all, and backslash-escaping or doubling the `*` in the value
 *    made no difference — the substitution happens before Postgres ever
 *    sees the pattern, so no LIKE-layer escaping of `*` can survive it.
 *    Raw Postgres `ILIKE '%*%'` (bypassing PostgREST entirely) correctly
 *    treats `*` as a literal character, confirming the bug is specific
 *    to PostgREST's `like`/`ilike` operators, not Postgres's own LIKE
 *    engine.
 *
 * Because `like`/`ilike` cannot represent a literal `*`, this module
 * targets PostgREST's `imatch` operator instead (`~*`, Postgres's
 * case-insensitive POSIX-ERE regex match). `imatch` has no documented or
 * observed wildcard-aliasing behavior on its value. The encoding is
 * therefore regex-metacharacter escaping, not LIKE-metacharacter
 * escaping:
 *
 * 1. POSIX ERE escaping: every regex metacharacter in the user's term
 *    (`. ^ $ * + ? ( ) [ ] { } | \`) is backslash-escaped so it matches
 *    itself literally rather than acting as regex syntax. `imatch`
 *    performs an unanchored substring search (no leading/trailing `.*`
 *    needed — POSIX ERE `~*` already matches anywhere in the string).
 * 2. PostgREST quoted-value escaping: the resulting pattern (which may
 *    now itself contain backslashes from step 1) is wrapped in `"..."`
 *    so PostgREST's tokenizer treats commas/parens/periods/colons/
 *    quotes inside it as inert characters, not `.or()` grammar. Inside
 *    the quotes, PostgREST requires `\` -> `\\` and `"` -> `\"`.
 *
 * The two layers compose correctly because each targets a different
 * parser (Postgres's regex engine vs. PostgREST's filter-value
 * tokenizer) that unescapes independently, in the reverse order queries
 * were built — verified against the real local Data API, including the
 * full adversarial term list and the previously-failing bare `*` case,
 * in tests/integration/product-search-safety.test.ts, not assumed.
 */

function escapeRegexMetacharacters(raw: string): string {
  return raw.replace(/[.^$*+?()[\]{}|\\]/g, "\\$&");
}

function quoteForPostgrestFilterValue(raw: string): string {
  const escaped = raw.replace(/\\/g, "\\\\").replace(/"/g, '\\"');
  return `"${escaped}"`;
}

/**
 * Builds a `column.imatch.<value>` value for embedding in a `.or()`
 * string, from an arbitrary raw search term. The returned string is a
 * POSIX-ERE pattern that matches the raw term as literal, unanchored,
 * case-insensitive text — pass it straight after `imatch.` in a
 * hand-built `.or()` condition string.
 */
export function buildImatchSearchValue(rawTerm: string): string {
  const regexEscaped = escapeRegexMetacharacters(rawTerm);
  return quoteForPostgrestFilterValue(regexEscaped);
}
