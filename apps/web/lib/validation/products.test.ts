import { describe, expect, it } from "vitest";
import { CreateProductSchema, UpdateProductSchema, ProductFilterSchema } from "./products";

const validKey = "11111111-1111-4111-8111-111111111111";

describe("CreateProductSchema", () => {
  it("accepts a minimal valid tracked product", () => {
    const result = CreateProductSchema.safeParse({
      creationKey: validKey,
      name: "T-Shirt",
      sku: "tshirt-001",
    });
    expect(result.success).toBe(true);
  });

  it("rejects a name shorter than 2 characters", () => {
    expect(
      CreateProductSchema.safeParse({ creationKey: validKey, name: "A", sku: "x" }).success
    ).toBe(false);
  });

  // Phase 1Q-B: this schema no longer requires a caller-supplied sku when
  // trackInventory is true — create_product itself now resolves a missing
  // sku per the business's own sku_mode (generating one for
  // SMART_AUTO/SIMPLE_SEQUENTIAL businesses; still required server-side,
  // as SKU_REQUIRED, only for a MANUAL-mode business) — see
  // lib/validation/products.ts's own header comment on this schema.
  it("accepts an omitted sku even when trackInventory is true (default) — resolved server-side", () => {
    const result = CreateProductSchema.safeParse({
      creationKey: validKey,
      name: "No SKU Tracked",
    });
    expect(result.success).toBe(true);
  });

  it("does not require sku when trackInventory is false", () => {
    const result = CreateProductSchema.safeParse({
      creationKey: validKey,
      name: "Service Item",
      trackInventory: false,
    });
    expect(result.success).toBe(true);
  });

  it("rejects a negative selling price", () => {
    expect(
      CreateProductSchema.safeParse({
        creationKey: validKey,
        name: "Bad Price",
        sku: "x",
        sellingPrice: -1,
      }).success
    ).toBe(false);
  });

  it("rejects an invalid creationKey", () => {
    expect(
      CreateProductSchema.safeParse({ creationKey: "not-a-uuid", name: "X", sku: "x" }).success
    ).toBe(false);
  });

  it("costPrice is optional (a caller without inventory.view_cost never submits it)", () => {
    const result = CreateProductSchema.safeParse({
      creationKey: validKey,
      name: "No Cost Field",
      sku: "x",
    });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.costPrice).toBeUndefined();
    }
  });
});

describe("UpdateProductSchema", () => {
  it("accepts a valid update payload", () => {
    const result = UpdateProductSchema.safeParse({
      name: "Renamed",
      unit: "unit",
      sellingPrice: 1000,
    });
    expect(result.success).toBe(true);
  });

  it("has no fields for id/businessId/createdBy/creationKey/trackInventory — they are structurally absent from the schema", () => {
    const shape = UpdateProductSchema.shape;
    expect(shape).not.toHaveProperty("id");
    expect(shape).not.toHaveProperty("businessId");
    expect(shape).not.toHaveProperty("createdBy");
    expect(shape).not.toHaveProperty("creationKey");
    expect(shape).not.toHaveProperty("trackInventory");
  });
});

describe("ProductFilterSchema", () => {
  it("accepts empty filters", () => {
    expect(ProductFilterSchema.safeParse({}).success).toBe(true);
  });

  it("rejects an invalid status", () => {
    expect(ProductFilterSchema.safeParse({ status: "deleted" }).success).toBe(false);
  });
});
