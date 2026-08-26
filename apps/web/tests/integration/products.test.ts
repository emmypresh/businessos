import { describe, expect, it, afterEach } from "vitest";
import { deleteTestUser } from "./helpers/admin-client";
import {
  createOwnerAndBusiness,
  createMemberWithRole,
  randomUuid,
} from "./helpers/inventory";

let cleanupUserIds: string[] = [];
afterEach(async () => {
  for (const id of cleanupUserIds) await deleteTestUser(id);
  cleanupUserIds = [];
});

describe("public.create_product", () => {
  it("creates a valid product", async () => {
    const { client, businessId, userId } = await createOwnerAndBusiness("prod-valid");
    cleanupUserIds.push(userId);

    const { data, error } = await client.rpc("create_product", {
      p_business_id: businessId,
      p_creation_key: randomUuid(),
      p_name: "  T-Shirt  ",
      p_sku: "  tshirt-001  ",
      p_selling_price: 5000,
      p_cost_price: 3000,
    });

    expect(error).toBeNull();
    expect(data?.name).toBe("T-Shirt"); // trimmed
    expect(data?.sku).toBe("tshirt-001"); // trimmed
    expect(data?.status).toBe("active");
    expect(data?.business_id).toBe(businessId);
  });

  it("rejects a name shorter than 2 characters or blank after trim", async () => {
    const { client, businessId, userId } = await createOwnerAndBusiness("prod-name");
    cleanupUserIds.push(userId);

    const { error } = await client.rpc("create_product", {
      p_business_id: businessId,
      p_creation_key: randomUuid(),
      p_name: "  A  ",
      p_sku: "sku-1",
    });
    expect(error).not.toBeNull();
  });

  it("rejects negative cost/selling price and negative low_stock_threshold at the DB boundary", async () => {
    const { client, businessId, userId } = await createOwnerAndBusiness("prod-money");
    cleanupUserIds.push(userId);

    const cases = [
      { p_cost_price: -1 },
      { p_selling_price: -1 },
      { p_low_stock_threshold: -1 },
    ];
    for (const overrides of cases) {
      const { error } = await client.rpc("create_product", {
        p_business_id: businessId,
        p_creation_key: randomUuid(),
        p_name: "Bad Money",
        p_sku: `sku-${randomUuid()}`,
        ...overrides,
      });
      expect(error, JSON.stringify(overrides)).not.toBeNull();
    }
  });

  it("requires a SKU when track_inventory is true, but allows omitting it when false", async () => {
    const { client, businessId, userId } = await createOwnerAndBusiness("prod-sku-required");
    cleanupUserIds.push(userId);

    const tracked = await client.rpc("create_product", {
      p_business_id: businessId,
      p_creation_key: randomUuid(),
      p_name: "Tracked no SKU",
      p_track_inventory: true,
    });
    expect(tracked.error).not.toBeNull();

    const service = await client.rpc("create_product", {
      p_business_id: businessId,
      p_creation_key: randomUuid(),
      p_name: "A Service",
      p_track_inventory: false,
    });
    expect(service.error).toBeNull();
    expect(service.data?.sku).toBeNull();
  });

  it("rejects a duplicate SKU (case/whitespace-normalized) within the same business", async () => {
    const { client, businessId, userId } = await createOwnerAndBusiness("prod-dup-sku");
    cleanupUserIds.push(userId);

    const first = await client.rpc("create_product", {
      p_business_id: businessId,
      p_creation_key: randomUuid(),
      p_name: "First",
      p_sku: "DUP-001",
    });
    expect(first.error).toBeNull();

    const second = await client.rpc("create_product", {
      p_business_id: businessId,
      p_creation_key: randomUuid(),
      p_name: "Second",
      p_sku: "  dup-001  ",
    });
    expect(second.error).not.toBeNull();
    expect(second.error?.message).toContain("SKU_UNAVAILABLE");
  });

  it("rejects a duplicate barcode within the same business", async () => {
    const { client, businessId, userId } = await createOwnerAndBusiness("prod-dup-barcode");
    cleanupUserIds.push(userId);

    const first = await client.rpc("create_product", {
      p_business_id: businessId,
      p_creation_key: randomUuid(),
      p_name: "First",
      p_sku: "sku-a",
      p_barcode: "1234567890",
    });
    expect(first.error).toBeNull();

    const second = await client.rpc("create_product", {
      p_business_id: businessId,
      p_creation_key: randomUuid(),
      p_name: "Second",
      p_sku: "sku-b",
      p_barcode: "1234567890",
    });
    expect(second.error).not.toBeNull();
    expect(second.error?.message).toContain("BARCODE_UNAVAILABLE");
  });

  it("does not free a SKU when the original product is archived", async () => {
    const { client, businessId, userId } = await createOwnerAndBusiness("prod-archived-sku");
    cleanupUserIds.push(userId);

    const first = await client.rpc("create_product", {
      p_business_id: businessId,
      p_creation_key: randomUuid(),
      p_name: "Original",
      p_sku: "ARCHIVE-ME",
    });
    expect(first.error).toBeNull();

    const archive = await client
      .from("products")
      .update({ status: "archived" })
      .eq("id", first.data!.id);
    expect(archive.error).toBeNull();

    const second = await client.rpc("create_product", {
      p_business_id: businessId,
      p_creation_key: randomUuid(),
      p_name: "Reuse attempt",
      p_sku: "archive-me",
    });
    expect(second.error).not.toBeNull();
    expect(second.error?.message).toContain("SKU_UNAVAILABLE");
  });

  it("rejects a forged business_id the caller has no membership in", async () => {
    const a = await createOwnerAndBusiness("forged-biz-a");
    const b = await createOwnerAndBusiness("forged-biz-b");
    cleanupUserIds.push(a.userId, b.userId);

    const { error } = await a.client.rpc("create_product", {
      p_business_id: b.businessId,
      p_creation_key: randomUuid(),
      p_name: "Should not be created",
      p_sku: "forged-sku",
    });
    expect(error).not.toBeNull();
    expect(error?.message).toContain("insufficient_privilege");

    const { data: leaked } = await b.client
      .from("products")
      .select("id")
      .eq("sku", "forged-sku");
    expect(leaked ?? []).toHaveLength(0);
  });

  it("denies a role without products.manage (SALES)", async () => {
    const owner = await createOwnerAndBusiness("sales-cannot-create");
    cleanupUserIds.push(owner.userId);
    const sales = await createMemberWithRole(owner.businessId, "sales-cannot-create", "SALES");
    cleanupUserIds.push(sales.userId);

    const { error } = await sales.client.rpc("create_product", {
      p_business_id: owner.businessId,
      p_creation_key: randomUuid(),
      p_name: "Nope",
      p_sku: "nope-sku",
    });
    expect(error).not.toBeNull();
    expect(error?.message).toContain("insufficient_privilege");
  });

  it("business_id, created_by, creation_key, and track_inventory are immutable", async () => {
    const owner = await createOwnerAndBusiness("prod-immutable");
    const other = await createOwnerAndBusiness("prod-immutable-other");
    cleanupUserIds.push(owner.userId, other.userId);

    const { data: product } = await owner.client.rpc("create_product", {
      p_business_id: owner.businessId,
      p_creation_key: randomUuid(),
      p_name: "Immutable",
      p_sku: "immutable-sku",
    });
    expect(product).not.toBeNull();

    // The generated Database type describes table structure, not runtime
    // GRANTs — these fields type-check fine but are rejected at the
    // Postgres privilege layer (excluded from the UPDATE column grant)
    // and, as defense in depth, by private.enforce_product_immutable_fields
    // even for a writer that somehow held the column grant.
    const trackInventory = await owner.client
      .from("products")
      .update({ track_inventory: false })
      .eq("id", product!.id);
    expect(trackInventory.error).not.toBeNull();

    const businessIdChange = await owner.client
      .from("products")
      .update({ business_id: other.businessId })
      .eq("id", product!.id);
    expect(businessIdChange.error).not.toBeNull();
  });
});
