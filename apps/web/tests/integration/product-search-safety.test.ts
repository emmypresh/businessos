import { describe, expect, it, afterEach } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";
import type { Database } from "@/lib/supabase/database.types";
import { deleteTestUser } from "./helpers/admin-client";
import { createOwnerAndBusiness, randomUuid } from "./helpers/inventory";
import { buildImatchSearchValue } from "@/lib/search";
import { DEFAULT_PAGE_SIZE } from "@/lib/pagination";

type Client = SupabaseClient<Database>;

let cleanupUserIds: string[] = [];
afterEach(async () => {
  for (const id of cleanupUserIds) await deleteTestUser(id);
  cleanupUserIds = [];
});

/**
 * Exercises the exact query shape lib/products/dal.ts's listProducts
 * builds (`.or("name.imatch.<value>,sku.imatch.<value>")`) against the
 * REAL local Data API — proving the fix empirically, not just at the
 * string-encoding-function level (lib/search.test.ts covers the encoder
 * function's own deterministic output; this file is the thing that
 * actually proves PostgREST parses the result the way the encoder
 * assumes). `imatch` (not `ilike`) is deliberate: PostgREST's `ilike`
 * unconditionally aliases a literal `*` in the value to `%` with no
 * escape that survives it (confirmed against the real API and PostgREST's
 * own docs), so a product name containing `*` could never be found via
 * `ilike` — see lib/search.ts for the full history.
 */
const ADVERSARIAL_TERMS = [
  "alpha",
  "alpha,beta",
  ",",
  "alpha)",
  "(alpha)",
  "(",
  "alpha.beta",
  "alpha:beta",
  "alpha*beta",
  'alpha"beta',
  "alpha'beta",
  "alpha\\beta",
  "alpha%beta",
  "alpha_beta",
  "alpha),sku.not.is.null",
  "alpha,sku.not.is.null",
  "or(name.eq.foo)",
  // POSIX-ERE metacharacters (added: imatch's regex engine, unlike
  // ilike's LIKE engine, treats these as syntax unless escaped).
  "+",
  "?",
  "^",
  "$",
  "{",
  "}",
  "[",
  "]",
  "|",
  "alpha.*",
  "alpha|beta",
  "alpha$",
  "^alpha",
  "alpha[0]",
  "alpha+",
  "alpha?",
];

async function searchProducts(client: Client, businessId: string, term: string, limit = DEFAULT_PAGE_SIZE + 1) {
  const value = buildImatchSearchValue(term);
  return client
    .from("products")
    .select("id, name, sku")
    .eq("business_id", businessId)
    .or(`name.imatch.${value},sku.imatch.${value}`)
    .limit(limit);
}

describe("product search is PostgREST-grammar-safe (real Data API)", () => {
  it("every adversarial term returns a valid response, never PGRST100, for a business with no matching products", async () => {
    const { client, businessId, userId } = await createOwnerAndBusiness("search-safety-empty");
    cleanupUserIds.push(userId);

    for (const term of ADVERSARIAL_TERMS) {
      const { data, error } = await searchProducts(client, businessId, term);
      expect(error, `term=${JSON.stringify(term)}`).toBeNull();
      expect(error?.code, `term=${JSON.stringify(term)}`).not.toBe("PGRST100");
      expect(data, `term=${JSON.stringify(term)}`).toEqual([]);
    }
  });

  // ---------------------------------------------------------------------
  // Group 1: every standalone punctuation character required by the
  // review, PLUS every combined term that corresponds to genuine literal
  // text a product could plausibly be named. Each case seeds ONE product
  // whose name contains that exact term, and a DECOY product that does
  // not, then proves the search finds ONLY the genuine one — this is
  // what proves literal semantics end-to-end (encode -> PostgREST parse
  // -> Postgres ILIKE match), not merely "returns empty for a term that
  // matches nothing," which the test above already covers separately.
  // ---------------------------------------------------------------------
  const LITERAL_MATCH_CASES: Array<[term: string, productName: string]> = [
    // The 11 standalone characters named explicitly in the review.
    [",", "Marker,Suffix"],
    ["(", "Marker(Suffix"],
    [")", "Marker)Suffix"],
    [".", "Marker.Suffix"],
    [":", "Marker:Suffix"],
    ["*", "Marker*Suffix"],
    ['"', 'Marker"Suffix'],
    ["'", "Marker'Suffix"],
    ["\\", "Marker\\Suffix"],
    ["%", "Marker%Suffix"],
    ["_", "Marker_Suffix"],
    // POSIX-ERE metacharacters, standalone (added: these are syntax to
    // Postgres's regex engine, which imatch uses, unlike the LIKE engine
    // ilike used previously).
    ["+", "Marker+Suffix"],
    ["?", "Marker?Suffix"],
    ["^", "Marker^Suffix"],
    ["$", "Marker$Suffix"],
    ["{", "Marker{Suffix"],
    ["}", "Marker}Suffix"],
    ["[", "Marker[Suffix"],
    ["]", "Marker]Suffix"],
    ["|", "Marker|Suffix"],
    // The combined terms that correspond to real literal text.
    ["alpha,beta", "Item alpha,beta End"],
    ["alpha)", "Item alpha) End"],
    ["(alpha)", "Item (alpha) End"],
    ["alpha.beta", "Item alpha.beta End"],
    ["alpha:beta", "Item alpha:beta End"],
    ["alpha*beta", "Item alpha*beta End"],
    ['alpha"beta', 'Item alpha"beta End'],
    ["alpha'beta", "Item alpha'beta End"],
    ["alpha\\beta", "Item alpha\\beta End"],
    ["alpha%beta", "Item alpha%beta End"],
    ["alpha_beta", "Item alpha_beta End"],
  ];

  it.each(LITERAL_MATCH_CASES)(
    "term %j matches ONLY the product literally containing it, never a decoy, never PGRST100",
    async (term, productName) => {
      const { client, businessId, userId } = await createOwnerAndBusiness("search-safety-literal");
      cleanupUserIds.push(userId);

      const genuine = await client.rpc("create_product", {
        p_business_id: businessId,
        p_creation_key: randomUuid(),
        p_name: productName,
        p_sku: `literal-sku-${randomUuid()}`,
      });
      expect(genuine.error).toBeNull();

      await client.rpc("create_product", {
        p_business_id: businessId,
        p_creation_key: randomUuid(),
        p_name: "Completely Unrelated Decoy Product",
        p_sku: `decoy-sku-${randomUuid()}`,
      });

      const { data, error } = await searchProducts(client, businessId, term);

      expect(error, `term=${JSON.stringify(term)}`).toBeNull();
      expect(error?.code, `term=${JSON.stringify(term)}`).not.toBe("PGRST100");
      expect(data, `term=${JSON.stringify(term)}`).toHaveLength(1);
      expect(data![0].id, `term=${JSON.stringify(term)}`).toBe(genuine.data!.id);
      expect(data![0].name, `term=${JSON.stringify(term)}`).toBe(productName);
    }
  );

  // ---------------------------------------------------------------------
  // Group 1b: combined terms built specifically to catch POSIX-ERE
  // regex broadening — each pairs a genuine product that literally
  // contains the term with a DECOY chosen because it's exactly what an
  // UNESCAPED interpretation of the term's regex metacharacter would
  // additionally match (not just an unrelated string, as in Group 1's
  // generic decoy). If lib/search.ts's regex-metacharacter escaping ever
  // regressed, these are the specific false positives that would appear.
  // ---------------------------------------------------------------------
  const REGEX_BROADENING_CASES: Array<[term: string, productName: string, broadeningDecoyName: string]> = [
    // Unescaped "alpha.*" (any char, zero-or-more) would match any
    // string starting with "alpha".
    ["alpha.*", "Item alpha.* End", "alphaZZZZZZZZ"],
    // Unescaped "alpha|beta" (alternation) would match a string
    // containing "beta" alone, with no "alpha" at all.
    ["alpha|beta", "Item alpha|beta End", "Something with beta only"],
    // Unescaped "alpha$" (end anchor) would match any string ENDING in
    // "alpha" (no literal $ needed).
    ["alpha$", "Item alpha$ End", "This string ends with alpha"],
    // Unescaped "^alpha" (start anchor) would match any string STARTING
    // with "alpha" (no literal ^ needed).
    ["^alpha", "^alpha Item End", "alpha starts this string"],
    // Unescaped "alpha[0]" (character class matching just "0") would
    // match "alpha0" with no literal brackets.
    ["alpha[0]", "Item alpha[0] End", "alpha0"],
    // Unescaped "alpha+" (one-or-more of the preceding "a") would match
    // "alphaa", "alphaaa", etc. — not just the literal "alpha+".
    ["alpha+", "Item alpha+ End", "alphaaa"],
    // Unescaped "alpha?" (zero-or-one of the preceding "a") would match
    // "alph" alone, with no trailing "a" at all.
    ["alpha?", "Item alpha? End", "alph"],
  ];

  it.each(REGEX_BROADENING_CASES)(
    "term %j matches ONLY the literal product, never the regex-broadening decoy %j, never PGRST100",
    async (term, productName, broadeningDecoyName) => {
      const { client, businessId, userId } = await createOwnerAndBusiness("search-safety-regex");
      cleanupUserIds.push(userId);

      const genuine = await client.rpc("create_product", {
        p_business_id: businessId,
        p_creation_key: randomUuid(),
        p_name: productName,
        p_sku: `literal-sku-${randomUuid()}`,
      });
      expect(genuine.error).toBeNull();

      await client.rpc("create_product", {
        p_business_id: businessId,
        p_creation_key: randomUuid(),
        p_name: broadeningDecoyName,
        p_sku: `regex-decoy-sku-${randomUuid()}`,
      });

      const { data, error } = await searchProducts(client, businessId, term);

      expect(error, `term=${JSON.stringify(term)}`).toBeNull();
      expect(error?.code, `term=${JSON.stringify(term)}`).not.toBe("PGRST100");
      expect(data, `term=${JSON.stringify(term)}`).toHaveLength(1);
      expect(data![0].id, `term=${JSON.stringify(term)}`).toBe(genuine.data!.id);
      expect(data![0].name, `term=${JSON.stringify(term)}`).toBe(productName);
    }
  );

  // ---------------------------------------------------------------------
  // Group 2: terms that are pure grammar-injection attempts with no
  // corresponding genuine product name — must never match anything, and
  // specifically must never broaden into the OTHER genuine products that
  // exist in the same tenant (proving the attack can't "leak" into an
  // unrelated OR-condition or an early-closed group).
  // ---------------------------------------------------------------------
  const GRAMMAR_ATTACK_ONLY_TERMS = [
    "alpha),sku.not.is.null",
    "alpha,sku.not.is.null",
    "or(name.eq.foo)",
  ];

  it.each(GRAMMAR_ATTACK_ONLY_TERMS)(
    "grammar-attack term %j never broadens into genuine same-tenant products",
    async (term) => {
      const { client, businessId, userId } = await createOwnerAndBusiness("search-safety-attack");
      cleanupUserIds.push(userId);
      for (let i = 0; i < 3; i++) {
        await client.rpc("create_product", {
          p_business_id: businessId,
          p_creation_key: randomUuid(),
          p_name: `Ordinary Product ${i}`,
          p_sku: `ordinary-sku-${i}-${randomUuid()}`,
        });
      }
      const { data: allProducts } = await client.from("products").select("id").eq("business_id", businessId);
      expect(allProducts).toHaveLength(3);

      const { data, error } = await searchProducts(client, businessId, term);
      expect(error, `term=${JSON.stringify(term)}`).toBeNull();
      expect(error?.code, `term=${JSON.stringify(term)}`).not.toBe("PGRST100");
      // None of the 3 seeded products literally contain this string, so
      // it must return zero rows — if the grammar were broken, this
      // could instead return all 3, or a different subset than a
      // genuine literal ILIKE search would.
      expect(data, `term=${JSON.stringify(term)}`).toEqual([]);
    }
  );

  it("tenant scope remains intact for every adversarial term — never returns another business's products", async () => {
    const a = await createOwnerAndBusiness("search-safety-tenant-a");
    const b = await createOwnerAndBusiness("search-safety-tenant-b");
    cleanupUserIds.push(a.userId, b.userId);
    await a.client.rpc("create_product", {
      p_business_id: a.businessId,
      p_creation_key: randomUuid(),
      p_name: "Tenant A Only Product",
      p_sku: `tenant-a-sku-${randomUuid()}`,
    });

    for (const term of ADVERSARIAL_TERMS) {
      const { data, error } = await searchProducts(b.client, a.businessId, term);
      expect(error, `term=${JSON.stringify(term)}`).toBeNull();
      // business B's client querying business A's id: RLS/tenant
      // scoping means zero rows regardless of the search term.
      expect(data, `term=${JSON.stringify(term)}`).toEqual([]);
    }
  });

  // ---------------------------------------------------------------------
  // The limit assertion, corrected: the previous version's malicious term
  // matched zero seeded rows, so it never actually exercised "many
  // genuine matches, still capped by .limit()." This seeds
  // DEFAULT_PAGE_SIZE + 5 products that ALL literally contain the
  // grammar-sensitive character ")", plus several unrelated decoys, and
  // proves both properties in one assertion: the grammar cannot broaden
  // the query (every returned row genuinely contains ")"), AND the limit
  // remains effective even though far more than the limit's worth of
  // rows would legitimately match.
  // ---------------------------------------------------------------------
  it("the page limit stays effective when many genuine rows literally match a grammar-sensitive term", async () => {
    const { client, businessId, userId } = await createOwnerAndBusiness("search-safety-limit");
    cleanupUserIds.push(userId);

    const matchingCount = DEFAULT_PAGE_SIZE + 5; // deliberately more than the limit
    for (let i = 0; i < matchingCount; i++) {
      const padded = String(i).padStart(3, "0");
      await client.rpc("create_product", {
        p_business_id: businessId,
        p_creation_key: randomUuid(),
        p_name: `Limit ) Product ${padded}`,
        p_sku: `limit-match-sku-${padded}-${randomUuid()}`,
      });
    }
    // Decoys that do NOT contain ")" — if the search ever broadened,
    // these would leak into the result too.
    for (let i = 0; i < 5; i++) {
      await client.rpc("create_product", {
        p_business_id: businessId,
        p_creation_key: randomUuid(),
        p_name: `Unrelated Decoy ${i}`,
        p_sku: `limit-decoy-sku-${i}-${randomUuid()}`,
      });
    }

    const { data: totalRows } = await client.from("products").select("id").eq("business_id", businessId);
    expect(totalRows).toHaveLength(matchingCount + 5);

    const { data, error } = await searchProducts(client, businessId, ")", DEFAULT_PAGE_SIZE);

    expect(error).toBeNull();
    // Exactly the configured limit — not fewer (proving the many genuine
    // matches weren't somehow filtered out), not more (proving the limit
    // clause itself wasn't broken or stripped by the adversarial term),
    // and never matchingCount+5 (which would mean the search broadened
    // to every product regardless of content).
    expect(data).toHaveLength(DEFAULT_PAGE_SIZE);
    for (const row of data!) {
      expect(row.name, `row=${JSON.stringify(row)}`).toContain(")");
    }
  });
});
