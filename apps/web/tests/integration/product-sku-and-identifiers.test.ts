// Phase 1Q-B — product identifier + auto-SKU foundation. Exercises
// create_product's mode-aware SKU generation (SMART_AUTO/SIMPLE_SEQUENTIAL/
// MANUAL), business-scoped case-insensitive SKU uniqueness, SKU stability
// across unrelated edits, the sku-changed audit trigger, and
// add_product_identifier/remove_product_identifier (GTIN/UPC/EAN check
// digits, business-scoped uniqueness, cross-tenant IDOR).
//
// Phase 1Q-B remediation adds two more describe blocks below: a true
// parallel-session concurrency regression for the primary-identifier race
// (Codex rejection, blocking finding 1), and full coverage for the
// dedicated public.update_product_sku mutation (blocking finding 2) —
// see supabase/migrations/20261010080400_product_identifier_concurrency_
// and_sku_update_rpc.sql.
//
// NOTE: this suite requires a local Supabase stack (`supabase start`).
// It WAS executed against a real local database for this remediation
// pass (`supabase db reset` + `vitest run --config
// vitest.integration.config.ts tests/integration/product-sku-and-
// identifiers.test.ts`) — 28/28 passing — see the build brief's own
// validation section for the full run log.
import { describe, expect, it, afterEach } from "vitest";
import { deleteTestUser } from "./helpers/admin-client";
import { createOwnerAndBusiness, randomUuid } from "./helpers/inventory";

let cleanupUserIds: string[] = [];
afterEach(async () => {
  for (const id of cleanupUserIds) await deleteTestUser(id);
  cleanupUserIds = [];
});

async function createProduct(
  client: Awaited<ReturnType<typeof createOwnerAndBusiness>>["client"],
  businessId: string,
  overrides: Record<string, unknown> = {}
) {
  return client.rpc("create_product", {
    p_business_id: businessId,
    p_creation_key: randomUuid(),
    p_name: "Test Product",
    p_selling_price: 100,
    ...overrides,
  });
}

describe("Phase 1Q-B — SKU generation modes", () => {
  it("SMART_AUTO (default, no business_sku_settings row): generates a readable, category-hinted SKU", async () => {
    // createOwnerAndBusiness seeds category_code GENERAL_TRADING -> "GEN".
    const owner = await createOwnerAndBusiness("sku-smart-default");
    cleanupUserIds.push(owner.userId);

    const { data, error } = await createProduct(owner.client, owner.businessId, {
      p_name: "Widget Pro",
    });
    expect(error).toBeNull();
    expect(data!.sku).toMatch(/^GEN-WIDG-PRO-\d{3}$/);
  });

  it("SMART_AUTO: two products allocate independent, non-colliding sequence suffixes", async () => {
    const owner = await createOwnerAndBusiness("sku-smart-seq");
    cleanupUserIds.push(owner.userId);

    const first = await createProduct(owner.client, owner.businessId, { p_name: "Alpha Gadget" });
    const second = await createProduct(owner.client, owner.businessId, { p_name: "Alpha Gadget" });
    expect(first.error).toBeNull();
    expect(second.error).toBeNull();
    expect(first.data!.sku).not.toBe(second.data!.sku);
  });

  it("SIMPLE_SEQUENTIAL: PRD-000001 style, business-wide counter", async () => {
    const owner = await createOwnerAndBusiness("sku-simple-seq");
    cleanupUserIds.push(owner.userId);

    const settings = await owner.client
      .from("business_sku_settings")
      .upsert({ business_id: owner.businessId, sku_mode: "SIMPLE_SEQUENTIAL" });
    expect(settings.error).toBeNull();

    const { data, error } = await createProduct(owner.client, owner.businessId);
    expect(error).toBeNull();
    expect(data!.sku).toMatch(/^PRD-\d{6}$/);
  });

  it("MANUAL mode: omitted sku on a tracked product is rejected with SKU_REQUIRED", async () => {
    const owner = await createOwnerAndBusiness("sku-manual-required");
    cleanupUserIds.push(owner.userId);
    await owner.client
      .from("business_sku_settings")
      .upsert({ business_id: owner.businessId, sku_mode: "MANUAL" });

    const { error } = await createProduct(owner.client, owner.businessId, { p_track_inventory: true });
    expect(error?.message).toContain("SKU_REQUIRED");
  });

  it("MANUAL mode: a non-tracked (service) product may still omit sku", async () => {
    const owner = await createOwnerAndBusiness("sku-manual-service");
    cleanupUserIds.push(owner.userId);
    await owner.client
      .from("business_sku_settings")
      .upsert({ business_id: owner.businessId, sku_mode: "MANUAL" });

    const { data, error } = await createProduct(owner.client, owner.businessId, {
      p_track_inventory: false,
    });
    expect(error).toBeNull();
    expect(data!.sku).toBeNull();
  });

  it("a caller-supplied sku is normalized (uppercased, whitespace collapsed) and used as-is", async () => {
    const owner = await createOwnerAndBusiness("sku-manual-normalize");
    cleanupUserIds.push(owner.userId);

    const { data, error } = await createProduct(owner.client, owner.businessId, {
      p_sku: "  abc   123 ",
    });
    expect(error).toBeNull();
    expect(data!.sku).toBe("ABC-123");
  });

  it("SKU is business-scoped, case-insensitive unique: same SKU rejected within a business, allowed across businesses", async () => {
    const owner = await createOwnerAndBusiness("sku-uniq-a");
    const other = await createOwnerAndBusiness("sku-uniq-b");
    cleanupUserIds.push(owner.userId, other.userId);

    const first = await createProduct(owner.client, owner.businessId, { p_sku: "DUP-001" });
    expect(first.error).toBeNull();

    const dupe = await createProduct(owner.client, owner.businessId, { p_sku: "dup-001" });
    expect(dupe.error?.message).toContain("SKU_UNAVAILABLE");

    const crossBusiness = await createProduct(other.client, other.businessId, { p_sku: "DUP-001" });
    expect(crossBusiness.error).toBeNull();
  });

  it("SKU is stable across an unrelated product edit (name change does not regenerate it)", async () => {
    const owner = await createOwnerAndBusiness("sku-stability");
    cleanupUserIds.push(owner.userId);

    const { data: product } = await createProduct(owner.client, owner.businessId, { p_name: "Original Name" });
    const originalSku = product!.sku;

    const update = await owner.client
      .from("products")
      .update({ name: "Renamed Product" })
      .eq("id", product!.id);
    expect(update.error).toBeNull();

    const { data: reloaded } = await owner.client.from("products").select("sku").eq("id", product!.id).single();
    expect(reloaded!.sku).toBe(originalSku);
  });

  it("an explicit manual SKU edit is recorded as product.sku_changed in the audit trail", async () => {
    const owner = await createOwnerAndBusiness("sku-change-audit");
    cleanupUserIds.push(owner.userId);

    const { data: product } = await createProduct(owner.client, owner.businessId, { p_sku: "OLD-001" });
    const update = await owner.client.rpc("update_product_sku", {
      p_business_id: owner.businessId,
      p_product_id: product!.id,
      p_sku: "NEW-001",
    });
    expect(update.error).toBeNull();

    const { data: events } = await owner.client
      .from("audit_events")
      .select("action, metadata")
      .eq("resource_id", product!.id)
      .eq("action", "product.sku_changed");
    expect(events).toHaveLength(1);
    expect(events![0].metadata).toMatchObject({ old_sku: "OLD-001", new_sku: "NEW-001" });
  });

  it("legacy NULL-sku products remain readable/updatable without forcing sku generation", async () => {
    const owner = await createOwnerAndBusiness("sku-legacy-null");
    cleanupUserIds.push(owner.userId);

    const { data: product } = await createProduct(owner.client, owner.businessId, {
      p_track_inventory: false,
      p_sku: null,
    });
    expect(product!.sku).toBeNull();

    const update = await owner.client
      .from("products")
      .update({ description: "Updated description" })
      .eq("id", product!.id);
    expect(update.error).toBeNull();

    const { data: reloaded } = await owner.client.from("products").select("sku").eq("id", product!.id).single();
    expect(reloaded!.sku).toBeNull();
  });
});

describe("Phase 1Q-B — external product identifiers", () => {
  it("accepts a valid EAN-13 and its check digit", async () => {
    const owner = await createOwnerAndBusiness("ident-ean13-valid");
    cleanupUserIds.push(owner.userId);
    const { data: product } = await createProduct(owner.client, owner.businessId);

    const { data, error } = await owner.client.rpc("add_product_identifier", {
      p_business_id: owner.businessId,
      p_product_id: product!.id,
      p_identifier_type: "EAN_13",
      p_identifier_value: "4006381333931", // well-known valid GS1 EAN-13 example
    });
    expect(error).toBeNull();
    expect(data!.identifier_type).toBe("EAN_13");
  });

  it("rejects an EAN-13 with an incorrect check digit", async () => {
    const owner = await createOwnerAndBusiness("ident-ean13-invalid");
    cleanupUserIds.push(owner.userId);
    const { data: product } = await createProduct(owner.client, owner.businessId);

    const { error } = await owner.client.rpc("add_product_identifier", {
      p_business_id: owner.businessId,
      p_product_id: product!.id,
      p_identifier_type: "EAN_13",
      p_identifier_value: "4006381333932", // last digit corrupted
    });
    expect(error?.message).toContain("INVALID_IDENTIFIER_CHECK_DIGIT");
  });

  it("OTHER type accepts a non-numeric code without check-digit validation", async () => {
    const owner = await createOwnerAndBusiness("ident-other");
    cleanupUserIds.push(owner.userId);
    const { data: product } = await createProduct(owner.client, owner.businessId);

    const { data, error } = await owner.client.rpc("add_product_identifier", {
      p_business_id: owner.businessId,
      p_product_id: product!.id,
      p_identifier_type: "OTHER",
      p_identifier_value: "internal-code-001",
    });
    expect(error).toBeNull();
    expect(data!.identifier_type).toBe("OTHER");
  });

  it("rejects a duplicate normalized identifier within the same business, allows it across businesses", async () => {
    const owner = await createOwnerAndBusiness("ident-uniq-a");
    const other = await createOwnerAndBusiness("ident-uniq-b");
    cleanupUserIds.push(owner.userId, other.userId);
    const { data: productA } = await createProduct(owner.client, owner.businessId, { p_sku: "PA-1" });
    const { data: productB } = await createProduct(owner.client, owner.businessId, { p_sku: "PA-2" });
    const { data: productC } = await createProduct(other.client, other.businessId, { p_sku: "PB-1" });

    const first = await owner.client.rpc("add_product_identifier", {
      p_business_id: owner.businessId,
      p_product_id: productA!.id,
      p_identifier_type: "EAN_13",
      p_identifier_value: "4006381333931",
    });
    expect(first.error).toBeNull();

    const dupe = await owner.client.rpc("add_product_identifier", {
      p_business_id: owner.businessId,
      p_product_id: productB!.id,
      p_identifier_type: "EAN_13",
      p_identifier_value: "4006381333931",
    });
    expect(dupe.error?.message).toContain("IDENTIFIER_ALREADY_EXISTS");

    const crossBusiness = await other.client.rpc("add_product_identifier", {
      p_business_id: other.businessId,
      p_product_id: productC!.id,
      p_identifier_type: "EAN_13",
      p_identifier_value: "4006381333931",
    });
    expect(crossBusiness.error).toBeNull();
  });

  it("rejects assigning an identifier to another business's product (IDOR)", async () => {
    const owner = await createOwnerAndBusiness("ident-idor-add");
    const attacker = await createOwnerAndBusiness("ident-idor-attacker");
    cleanupUserIds.push(owner.userId, attacker.userId);
    const { data: product } = await createProduct(owner.client, owner.businessId);

    const { error } = await attacker.client.rpc("add_product_identifier", {
      p_business_id: attacker.businessId,
      p_product_id: product!.id, // foreign product_id
      p_identifier_type: "OTHER",
      p_identifier_value: "hijack-attempt",
    });
    expect(error?.message).toContain("PRODUCT_NOT_FOUND");
  });

  it("removes an identifier and rejects removing another tenant's identifier (IDOR)", async () => {
    const owner = await createOwnerAndBusiness("ident-remove");
    const attacker = await createOwnerAndBusiness("ident-remove-attacker");
    cleanupUserIds.push(owner.userId, attacker.userId);
    const { data: product } = await createProduct(owner.client, owner.businessId);
    const { data: identifier } = await owner.client.rpc("add_product_identifier", {
      p_business_id: owner.businessId,
      p_product_id: product!.id,
      p_identifier_type: "OTHER",
      p_identifier_value: "remove-me",
    });

    const cross = await attacker.client.rpc("remove_product_identifier", {
      p_business_id: attacker.businessId,
      p_identifier_id: identifier!.id,
    });
    expect(cross.error?.message).toContain("IDENTIFIER_NOT_FOUND");

    const ok = await owner.client.rpc("remove_product_identifier", {
      p_business_id: owner.businessId,
      p_identifier_id: identifier!.id,
    });
    expect(ok.error).toBeNull();

    const again = await owner.client.rpc("remove_product_identifier", {
      p_business_id: owner.businessId,
      p_identifier_id: identifier!.id,
    });
    expect(again.error?.message).toContain("IDENTIFIER_NOT_FOUND");
  });

  it("setting is_primary demotes any previously-primary identifier on the same product", async () => {
    const owner = await createOwnerAndBusiness("ident-primary");
    cleanupUserIds.push(owner.userId);
    const { data: product } = await createProduct(owner.client, owner.businessId);

    const first = await owner.client.rpc("add_product_identifier", {
      p_business_id: owner.businessId,
      p_product_id: product!.id,
      p_identifier_type: "OTHER",
      p_identifier_value: "code-a",
      p_is_primary: true,
    });
    const second = await owner.client.rpc("add_product_identifier", {
      p_business_id: owner.businessId,
      p_product_id: product!.id,
      p_identifier_type: "OTHER",
      p_identifier_value: "code-b",
      p_is_primary: true,
    });
    expect(first.error).toBeNull();
    expect(second.error).toBeNull();

    const { data: rows } = await owner.client
      .from("product_identifiers")
      .select("id, is_primary")
      .eq("product_id", product!.id);
    const primaries = (rows ?? []).filter((r) => r.is_primary);
    expect(primaries).toHaveLength(1);
    expect(primaries[0].id).toBe(second.data!.id);
  });

  // Phase 1Q-B remediation (Codex rejection, blocking finding 1): a real
  // concurrency regression, not two sequential awaits. Two independent
  // in-flight RPC calls over the SAME authenticated client (each a
  // distinct HTTP request, each served by its own PostgREST-assigned
  // database connection/transaction) both request is_primary=true for
  // two DIFFERENT identifiers on the SAME product, fired via Promise.all
  // so they genuinely race at the database, not just at the JS event
  // loop. The required invariant: no matter which one "wins" or whether
  // both succeed, the FINAL persisted state has exactly one primary,
  // never zero, never two — enforced by
  // product_identifiers_one_primary_per_product_idx (a hard partial
  // unique index) and add_product_identifier's own product-row FOR
  // UPDATE lock (supabase/migrations/20261010080400_product_identifier_
  // concurrency_and_sku_update_rpc.sql).
  it("concurrent is_primary=true requests for two different identifiers on the same product leave exactly one primary (true parallel race)", async () => {
    const owner = await createOwnerAndBusiness("ident-primary-race");
    cleanupUserIds.push(owner.userId);
    const { data: product } = await createProduct(owner.client, owner.businessId);

    const [first, second] = await Promise.all([
      owner.client.rpc("add_product_identifier", {
        p_business_id: owner.businessId,
        p_product_id: product!.id,
        p_identifier_type: "OTHER",
        p_identifier_value: "race-code-a",
        p_is_primary: true,
      }),
      owner.client.rpc("add_product_identifier", {
        p_business_id: owner.businessId,
        p_product_id: product!.id,
        p_identifier_type: "OTHER",
        p_identifier_value: "race-code-b",
        p_is_primary: true,
      }),
    ]);

    // Both requests are individually valid (distinct identifier values,
    // both requesting is_primary=true is not itself an error) — the
    // product-row lock serializes them rather than rejecting either.
    // Document the observed behavior rather than assuming it: both are
    // expected to succeed under the serialized-lock strategy.
    expect(first.error).toBeNull();
    expect(second.error).toBeNull();

    const { data: rows } = await owner.client
      .from("product_identifiers")
      .select("id, is_primary")
      .eq("product_id", product!.id);
    const primaries = (rows ?? []).filter((r) => r.is_primary);

    // The hard invariant: never zero, never more than one, regardless of
    // which request actually landed second.
    expect(primaries).toHaveLength(1);
    expect(rows).toHaveLength(2);
  });

  it("no cross-business effect: a concurrent primary race on business A's product never touches business B's identifiers", async () => {
    const a = await createOwnerAndBusiness("ident-primary-race-a");
    const b = await createOwnerAndBusiness("ident-primary-race-b");
    cleanupUserIds.push(a.userId, b.userId);
    const { data: productA } = await createProduct(a.client, a.businessId);
    const { data: productB } = await createProduct(b.client, b.businessId);

    const seedB = await b.client.rpc("add_product_identifier", {
      p_business_id: b.businessId,
      p_product_id: productB!.id,
      p_identifier_type: "OTHER",
      p_identifier_value: "b-baseline",
      p_is_primary: true,
    });
    expect(seedB.error).toBeNull();

    await Promise.all([
      a.client.rpc("add_product_identifier", {
        p_business_id: a.businessId,
        p_product_id: productA!.id,
        p_identifier_type: "OTHER",
        p_identifier_value: "a-race-1",
        p_is_primary: true,
      }),
      a.client.rpc("add_product_identifier", {
        p_business_id: a.businessId,
        p_product_id: productA!.id,
        p_identifier_type: "OTHER",
        p_identifier_value: "a-race-2",
        p_is_primary: true,
      }),
    ]);

    const { data: bRows } = await b.client
      .from("product_identifiers")
      .select("id, is_primary")
      .eq("product_id", productB!.id);
    expect(bRows).toHaveLength(1);
    expect(bRows![0].is_primary).toBe(true);
  });
});

describe("Phase 1Q-B remediation — canonical SKU-edit mutation (public.update_product_sku)", () => {
  it("normalizes a lowercase, whitespace-padded manual SKU edit", async () => {
    const owner = await createOwnerAndBusiness("sku-edit-normalize");
    cleanupUserIds.push(owner.userId);
    const { data: product } = await createProduct(owner.client, owner.businessId, { p_sku: "OLD-1" });

    const { data, error } = await owner.client.rpc("update_product_sku", {
      p_business_id: owner.businessId,
      p_product_id: product!.id,
      p_sku: "  new   sku ",
    });
    expect(error).toBeNull();
    expect(data).toBe("NEW-SKU");
  });

  it("rejects an SKU that normalizes to nothing (INVALID_SKU)", async () => {
    const owner = await createOwnerAndBusiness("sku-edit-invalid");
    cleanupUserIds.push(owner.userId);
    const { data: product } = await createProduct(owner.client, owner.businessId, { p_sku: "OLD-1" });

    const { error } = await owner.client.rpc("update_product_sku", {
      p_business_id: owner.businessId,
      p_product_id: product!.id,
      p_sku: "!!!",
    });
    expect(error?.message).toContain("INVALID_SKU");
  });

  it("rejects a duplicate SKU within the same business with the stable SKU_ALREADY_EXISTS code", async () => {
    const owner = await createOwnerAndBusiness("sku-edit-dup");
    cleanupUserIds.push(owner.userId);
    const { data: taken } = await createProduct(owner.client, owner.businessId, { p_sku: "TAKEN-1" });
    const { data: product } = await createProduct(owner.client, owner.businessId, { p_sku: "MINE-1" });
    void taken;

    const { error } = await owner.client.rpc("update_product_sku", {
      p_business_id: owner.businessId,
      p_product_id: product!.id,
      p_sku: "taken-1",
    });
    expect(error?.message).toContain("SKU_ALREADY_EXISTS");
  });

  it("allows the identical SKU string when it belongs to a product in a DIFFERENT business", async () => {
    const owner = await createOwnerAndBusiness("sku-edit-cross-a");
    const other = await createOwnerAndBusiness("sku-edit-cross-b");
    cleanupUserIds.push(owner.userId, other.userId);
    await createProduct(other.client, other.businessId, { p_sku: "SHARED-1" });
    const { data: product } = await createProduct(owner.client, owner.businessId, { p_sku: "MINE-2" });

    const { error } = await owner.client.rpc("update_product_sku", {
      p_business_id: owner.businessId,
      p_product_id: product!.id,
      p_sku: "SHARED-1",
    });
    expect(error).toBeNull();
  });

  it("rejects an unauthorized/cross-business SKU update attempt (IDOR)", async () => {
    const owner = await createOwnerAndBusiness("sku-edit-idor-owner");
    const attacker = await createOwnerAndBusiness("sku-edit-idor-attacker");
    cleanupUserIds.push(owner.userId, attacker.userId);
    const { data: product } = await createProduct(owner.client, owner.businessId, { p_sku: "OWNER-1" });

    const { error } = await attacker.client.rpc("update_product_sku", {
      p_business_id: attacker.businessId,
      p_product_id: product!.id,
      p_sku: "HIJACKED",
    });
    expect(error?.message).toContain("PRODUCT_NOT_FOUND");

    const { data: reloaded } = await owner.client.from("products").select("sku").eq("id", product!.id).single();
    expect(reloaded!.sku).toBe("OWNER-1");
  });

  it("a direct client-side UPDATE of products.sku is now rejected — the RPC is the only write path", async () => {
    const owner = await createOwnerAndBusiness("sku-edit-direct-blocked");
    cleanupUserIds.push(owner.userId);
    const { data: product } = await createProduct(owner.client, owner.businessId, { p_sku: "DIRECT-1" });

    const direct = await owner.client.from("products").update({ sku: "DIRECT-2" }).eq("id", product!.id);
    expect(direct.error).not.toBeNull();

    const { data: reloaded } = await owner.client.from("products").select("sku").eq("id", product!.id).single();
    expect(reloaded!.sku).toBe("DIRECT-1");
  });

  it("an unrelated field edit (via the plain products UPDATE) leaves sku unchanged", async () => {
    const owner = await createOwnerAndBusiness("sku-edit-unrelated");
    cleanupUserIds.push(owner.userId);
    const { data: product } = await createProduct(owner.client, owner.businessId, { p_sku: "STABLE-1" });

    const update = await owner.client
      .from("products")
      .update({ description: "Updated via the app's own edit form" })
      .eq("id", product!.id);
    expect(update.error).toBeNull();

    const { data: reloaded } = await owner.client.from("products").select("sku").eq("id", product!.id).single();
    expect(reloaded!.sku).toBe("STABLE-1");
  });

  it("clearing the SKU (NULL) on a non-tracked product is preserved as a legitimate value", async () => {
    const owner = await createOwnerAndBusiness("sku-edit-null");
    cleanupUserIds.push(owner.userId);
    const { data: product } = await createProduct(owner.client, owner.businessId, {
      p_track_inventory: false,
      p_sku: "TEMP-1",
    });

    // p_sku is deliberately OMITTED (never `null`) — update_product_sku's
    // own `p_sku text default null` signature (see supabase/migrations/
    // 20261010080400_product_identifier_concurrency_and_sku_update_rpc.sql)
    // treats an omitted argument identically to an explicit SQL NULL,
    // which is what this test actually exercises: clearing the sku.
    const { data, error } = await owner.client.rpc("update_product_sku", {
      p_business_id: owner.businessId,
      p_product_id: product!.id,
    });
    expect(error).toBeNull();
    expect(data).toBeNull();
  });

  it("clearing the SKU on a TRACKED product is rejected with SKU_REQUIRED", async () => {
    const owner = await createOwnerAndBusiness("sku-edit-required");
    cleanupUserIds.push(owner.userId);
    const { data: product } = await createProduct(owner.client, owner.businessId, {
      p_track_inventory: true,
      p_sku: "KEEP-1",
    });

    const { error } = await owner.client.rpc("update_product_sku", {
      p_business_id: owner.businessId,
      p_product_id: product!.id,
      p_sku: "",
    });
    expect(error?.message).toContain("SKU_REQUIRED");

    const { data: reloaded } = await owner.client.from("products").select("sku").eq("id", product!.id).single();
    expect(reloaded!.sku).toBe("KEEP-1");
  });
});
