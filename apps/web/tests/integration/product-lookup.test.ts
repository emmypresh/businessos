// Phase 1Q-C — free product lookup, RPC-level integration coverage.
// Exercises public.lookup_product_identifier directly against a real
// local Supabase stack: local-match-first behavior, business-scoped
// tenant isolation (the same normalized barcode in two different
// businesses never leaks across them), and check-digit rejection before
// any provider would ever be reached.
//
// NOTE: requires a local Supabase stack (`supabase start` +
// `supabase db reset`) — run with
// `vitest run --config vitest.integration.config.ts tests/integration/product-lookup.test.ts`.
import { describe, expect, it, afterEach } from "vitest";
import { deleteTestUser } from "./helpers/admin-client";
import { createOwnerAndBusiness, randomUuid } from "./helpers/inventory";

let cleanupUserIds: string[] = [];
afterEach(async () => {
  for (const id of cleanupUserIds) await deleteTestUser(id);
  cleanupUserIds = [];
});

// A real EAN-13 with a valid check digit (Codex-verified against the
// standard mod-10 GS1 algorithm — 5000112637922 is a commonly used test
// EAN-13 with a correct check digit).
const VALID_EAN13 = "5000112637922";
const INVALID_CHECK_DIGIT_EAN13 = "5000112637921";

async function createProduct(
  client: Awaited<ReturnType<typeof createOwnerAndBusiness>>["client"],
  businessId: string,
  overrides: Record<string, unknown> = {}
) {
  return client.rpc("create_product", {
    p_business_id: businessId,
    p_creation_key: randomUuid(),
    p_name: "Lookup Test Product",
    p_selling_price: 100,
    ...overrides,
  });
}

describe("Phase 1Q-C — lookup_product_identifier", () => {
  it("returns NOT_FOUND for a code no product in the business has", async () => {
    const owner = await createOwnerAndBusiness("lookup-notfound");
    cleanupUserIds.push(owner.userId);

    const { data, error } = await owner.client.rpc("lookup_product_identifier", {
      p_business_id: owner.businessId,
      p_raw_value: VALID_EAN13,
    });
    expect(error).toBeNull();
    expect(data![0].status).toBe("NOT_FOUND");
    expect(data![0].identifier_type).toBe("EAN_13");
    expect(data![0].normalized_value).toBe(VALID_EAN13);
  });

  it("returns INVALID for a recognized-length GS1 code with a failing check digit, before any product search", async () => {
    const owner = await createOwnerAndBusiness("lookup-invalid");
    cleanupUserIds.push(owner.userId);

    const { data, error } = await owner.client.rpc("lookup_product_identifier", {
      p_business_id: owner.businessId,
      p_raw_value: INVALID_CHECK_DIGIT_EAN13,
    });
    expect(error).toBeNull();
    expect(data![0].status).toBe("INVALID");
    expect(data![0].product_id).toBeNull();
  });

  it("returns LOCAL_MATCH with only safe fields when the business has the identifier", async () => {
    const owner = await createOwnerAndBusiness("lookup-local-match");
    cleanupUserIds.push(owner.userId);

    const { data: product, error: productError } = await createProduct(owner.client, owner.businessId);
    expect(productError).toBeNull();

    const { error: addError } = await owner.client.rpc("add_product_identifier", {
      p_business_id: owner.businessId,
      p_product_id: product!.id,
      p_identifier_type: "EAN_13",
      p_identifier_value: VALID_EAN13,
    });
    expect(addError).toBeNull();

    const { data, error } = await owner.client.rpc("lookup_product_identifier", {
      p_business_id: owner.businessId,
      p_raw_value: `  ${VALID_EAN13}  `,
    });
    expect(error).toBeNull();
    const row = data![0];
    expect(row.status).toBe("LOCAL_MATCH");
    expect(row.product_id).toBe(product!.id);
    expect(row.product_name).toBe("Lookup Test Product");
    expect(Number(row.product_selling_price)).toBe(100);
  });

  it("never leaks a match across businesses — the same barcode in another business stays invisible", async () => {
    const ownerA = await createOwnerAndBusiness("lookup-tenant-a");
    const ownerB = await createOwnerAndBusiness("lookup-tenant-b");
    cleanupUserIds.push(ownerA.userId, ownerB.userId);

    const { data: productA } = await createProduct(ownerA.client, ownerA.businessId);
    await ownerA.client.rpc("add_product_identifier", {
      p_business_id: ownerA.businessId,
      p_product_id: productA!.id,
      p_identifier_type: "EAN_13",
      p_identifier_value: VALID_EAN13,
    });

    // Business B's own owner, looking up the SAME barcode in THEIR
    // business, must see NOT_FOUND — never business A's product.
    const { data, error } = await ownerB.client.rpc("lookup_product_identifier", {
      p_business_id: ownerB.businessId,
      p_raw_value: VALID_EAN13,
    });
    expect(error).toBeNull();
    expect(data![0].status).toBe("NOT_FOUND");
  });

  it("rejects a lookup scoped to a business the caller does not belong to (IDOR/cross-tenant guard)", async () => {
    const ownerA = await createOwnerAndBusiness("lookup-idor-a");
    const ownerB = await createOwnerAndBusiness("lookup-idor-b");
    cleanupUserIds.push(ownerA.userId, ownerB.userId);

    const { error } = await ownerB.client.rpc("lookup_product_identifier", {
      p_business_id: ownerA.businessId,
      p_raw_value: VALID_EAN13,
    });
    expect(error).not.toBeNull();
    expect(error!.message).toContain("insufficient_privilege");
  });

  it("rejects an unauthenticated call", async () => {
    const owner = await createOwnerAndBusiness("lookup-unauth");
    cleanupUserIds.push(owner.userId);
    await owner.client.auth.signOut();

    const { error } = await owner.client.rpc("lookup_product_identifier", {
      p_business_id: owner.businessId,
      p_raw_value: VALID_EAN13,
    });
    expect(error).not.toBeNull();
  });

  it("matches a locally stored OTHER-type identifier by its own normalization, not just the digit-strip form", async () => {
    const owner = await createOwnerAndBusiness("lookup-other-type");
    cleanupUserIds.push(owner.userId);

    const { data: product } = await createProduct(owner.client, owner.businessId);
    await owner.client.rpc("add_product_identifier", {
      p_business_id: owner.businessId,
      p_product_id: product!.id,
      p_identifier_type: "OTHER",
      p_identifier_value: "supplier-code-42",
    });

    const { data, error } = await owner.client.rpc("lookup_product_identifier", {
      p_business_id: owner.businessId,
      p_raw_value: "supplier-code-42",
    });
    expect(error).toBeNull();
    expect(data![0].status).toBe("LOCAL_MATCH");
    expect(data![0].product_id).toBe(product!.id);
  });
});
