import { describe, expect, it, vi, beforeEach } from "vitest";

const { requireUser } = vi.hoisted(() => ({ requireUser: vi.fn() }));
vi.mock("@/lib/auth/dal", () => ({ requireUser }));

const { getPermissions } = vi.hoisted(() => ({ getPermissions: vi.fn() }));
vi.mock("@/lib/business/dal", () => ({ getPermissions }));

const { rpc } = vi.hoisted(() => ({ rpc: vi.fn() }));
vi.mock("@/lib/supabase/server", () => ({
  createClient: vi.fn(async () => ({ rpc })),
}));

const { providerLookup } = vi.hoisted(() => ({ providerLookup: vi.fn() }));
vi.mock("./providers/open-food-facts", () => ({
  openFoodFactsProvider: { name: "open_food_facts", lookupByIdentifier: providerLookup },
}));

import {
  lookupLocalProductByIdentifier,
  lookupExternalProductByIdentifier,
  lookupProductByIdentifier,
} from "./actions";
import { __resetLookupCacheForTests } from "./cache";
import { ProductLookupProviderError } from "./provider";

const BUSINESS_ID = "11111111-1111-1111-1111-111111111111";

beforeEach(() => {
  vi.clearAllMocks();
  __resetLookupCacheForTests();
});

describe("lookupLocalProductByIdentifier", () => {
  it("returns LOCAL_MATCH with only safe product fields when the RPC finds a match", async () => {
    rpc.mockResolvedValue({
      data: [
        {
          status: "LOCAL_MATCH",
          identifier_type: "EAN_13",
          normalized_value: "5000112637922",
          product_id: "prod-1",
          product_name: "Widget",
          product_sku: "WID-001",
          product_status: "active",
          product_selling_price: "9.99",
        },
      ],
      error: null,
    });

    const result = await lookupLocalProductByIdentifier(BUSINESS_ID, "500-0112637922");

    expect(rpc).toHaveBeenCalledWith("lookup_product_identifier", {
      p_business_id: BUSINESS_ID,
      p_raw_value: "500-0112637922",
    });
    expect(result).toEqual({
      state: "LOCAL_MATCH",
      identifierType: "EAN_13",
      normalizedValue: "5000112637922",
      product: {
        productId: "prod-1",
        name: "Widget",
        sku: "WID-001",
        status: "active",
        sellingPrice: 9.99,
      },
    });
  });

  it("returns NOT_FOUND when the RPC reports no match", async () => {
    rpc.mockResolvedValue({
      data: [{ status: "NOT_FOUND", identifier_type: "EAN_13", normalized_value: "5000112637922" }],
      error: null,
    });
    const result = await lookupLocalProductByIdentifier(BUSINESS_ID, "5000112637922");
    expect(result.state).toBe("NOT_FOUND");
  });

  it("returns INVALID for a check-digit failure, never calling any provider itself", async () => {
    rpc.mockResolvedValue({
      data: [{ status: "INVALID", identifier_type: "EAN_13", normalized_value: "5000112637921" }],
      error: null,
    });
    const result = await lookupLocalProductByIdentifier(BUSINESS_ID, "5000112637921");
    expect(result.state).toBe("INVALID");
  });

  it("maps an RPC error (e.g. insufficient_privilege) to a controlled INVALID result, never throwing", async () => {
    rpc.mockResolvedValue({ data: null, error: { message: "insufficient_privilege", code: "42501" } });
    const result = await lookupLocalProductByIdentifier(BUSINESS_ID, "5000112637922");
    expect(result.state).toBe("INVALID");
  });
});

describe("lookupExternalProductByIdentifier", () => {
  it("returns EXTERNAL_MATCH for a provider hit", async () => {
    providerLookup.mockResolvedValue({
      identifier: "5000112637922",
      identifierType: "GTIN",
      name: "Widget",
      brand: null,
      description: null,
      imageUrl: null,
      categoryLabel: null,
      quantity: null,
      manufacturer: null,
      sourceProvider: "open_food_facts",
      sourceReference: "5000112637922",
    });
    const result = await lookupExternalProductByIdentifier("EAN_13", "5000112637922");
    expect(result.state).toBe("EXTERNAL_MATCH");
  });

  it("returns NOT_FOUND when the provider yields null", async () => {
    providerLookup.mockResolvedValue(null);
    const result = await lookupExternalProductByIdentifier("EAN_13", "5000112637922");
    expect(result).toEqual({ state: "NOT_FOUND", identifierType: "EAN_13", normalizedValue: "5000112637922" });
  });

  it("normalizes a thrown ProductLookupProviderError into a PROVIDER_ERROR result", async () => {
    providerLookup.mockRejectedValue(
      new ProductLookupProviderError("PRODUCT_LOOKUP_TIMEOUT", "timed out")
    );
    const result = await lookupExternalProductByIdentifier("EAN_13", "5000112637922");
    expect(result).toEqual({
      state: "PROVIDER_ERROR",
      identifierType: "EAN_13",
      normalizedValue: "5000112637922",
      errorCode: "PRODUCT_LOOKUP_TIMEOUT",
    });
  });

  it("normalizes an unexpected thrown error to PRODUCT_LOOKUP_PROVIDER_UNAVAILABLE, never leaking it raw", async () => {
    providerLookup.mockRejectedValue(new Error("boom"));
    const result = await lookupExternalProductByIdentifier("EAN_13", "5000112637922");
    expect(result).toEqual({
      state: "PROVIDER_ERROR",
      identifierType: "EAN_13",
      normalizedValue: "5000112637922",
      errorCode: "PRODUCT_LOOKUP_PROVIDER_UNAVAILABLE",
    });
  });
});

describe("lookupProductByIdentifier", () => {
  it("never calls the external provider when a local match exists", async () => {
    getPermissions.mockResolvedValue(new Set(["products.view", "products.manage"]));
    rpc.mockResolvedValue({
      data: [
        {
          status: "LOCAL_MATCH",
          identifier_type: "EAN_13",
          normalized_value: "5000112637922",
          product_id: "prod-1",
          product_name: "Widget",
          product_sku: "WID-001",
          product_status: "active",
          product_selling_price: "9.99",
        },
      ],
      error: null,
    });

    const result = await lookupProductByIdentifier(BUSINESS_ID, "5000112637922");
    expect(result.state).toBe("LOCAL_MATCH");
    expect(providerLookup).not.toHaveBeenCalled();
  });

  it("falls through to the external provider on a NOT_FOUND local result for a caller with manage permission", async () => {
    getPermissions.mockResolvedValue(new Set(["products.view", "products.manage"]));
    rpc.mockResolvedValue({
      data: [{ status: "NOT_FOUND", identifier_type: "EAN_13", normalized_value: "5000112637922" }],
      error: null,
    });
    providerLookup.mockResolvedValue({
      identifier: "5000112637922",
      identifierType: "GTIN",
      name: "External Widget",
      brand: null,
      description: null,
      imageUrl: null,
      categoryLabel: null,
      quantity: null,
      manufacturer: null,
      sourceProvider: "open_food_facts",
      sourceReference: "5000112637922",
    });

    const result = await lookupProductByIdentifier(BUSINESS_ID, "5000112637922");
    expect(result.state).toBe("EXTERNAL_MATCH");
    expect(providerLookup).toHaveBeenCalledTimes(1);
  });

  it("does not call the external provider for a caller lacking products.manage", async () => {
    getPermissions.mockResolvedValue(new Set(["products.view"]));
    rpc.mockResolvedValue({
      data: [{ status: "NOT_FOUND", identifier_type: "EAN_13", normalized_value: "5000112637922" }],
      error: null,
    });

    const result = await lookupProductByIdentifier(BUSINESS_ID, "5000112637922");
    expect(result.state).toBe("NOT_FOUND");
    expect(providerLookup).not.toHaveBeenCalled();
  });

  it("does not call the external provider for a non-GTIN-family (OTHER) miss", async () => {
    getPermissions.mockResolvedValue(new Set(["products.view", "products.manage"]));
    rpc.mockResolvedValue({
      data: [{ status: "NOT_FOUND", identifier_type: "OTHER", normalized_value: "ACME-1" }],
      error: null,
    });

    const result = await lookupProductByIdentifier(BUSINESS_ID, "ACME-1");
    expect(result.state).toBe("NOT_FOUND");
    expect(providerLookup).not.toHaveBeenCalled();
  });

  it("does not call the external provider for an INVALID (bad check digit) result", async () => {
    getPermissions.mockResolvedValue(new Set(["products.view", "products.manage"]));
    rpc.mockResolvedValue({
      data: [{ status: "INVALID", identifier_type: "EAN_13", normalized_value: "5000112637921" }],
      error: null,
    });

    const result = await lookupProductByIdentifier(BUSINESS_ID, "5000112637921");
    expect(result.state).toBe("INVALID");
    expect(providerLookup).not.toHaveBeenCalled();
    expect(rpc).toHaveBeenCalledTimes(1);
  });

  it("returns INVALID without ever calling the RPC for a caller lacking products.view", async () => {
    getPermissions.mockResolvedValue(new Set([]));
    const result = await lookupProductByIdentifier(BUSINESS_ID, "5000112637922");
    expect(result.state).toBe("INVALID");
    expect(rpc).not.toHaveBeenCalled();
  });
});
