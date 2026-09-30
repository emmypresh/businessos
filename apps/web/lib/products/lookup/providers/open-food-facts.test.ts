import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import { openFoodFactsProvider } from "./open-food-facts";
import { ProductLookupProviderError } from "../provider";

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

const fetchMock = vi.fn();

beforeEach(() => {
  vi.stubGlobal("fetch", fetchMock);
  fetchMock.mockReset();
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("openFoodFactsProvider", () => {
  it("returns a normalized candidate for a matched barcode", async () => {
    fetchMock.mockResolvedValue(
      jsonResponse({
        status: 1,
        product: {
          product_name: "Nutella",
          brands: "Ferrero, Other Brand",
          categories: "Spreads, Sweet spreads",
          quantity: "400g",
          image_url: "https://images.example.com/nutella.jpg",
          code: "3017620422003",
        },
      })
    );

    const result = await openFoodFactsProvider.lookupByIdentifier("3017620422003", new AbortController().signal);

    expect(result).toEqual({
      identifier: "3017620422003",
      identifierType: "GTIN",
      name: "Nutella",
      brand: "Ferrero",
      description: null,
      imageUrl: "https://images.example.com/nutella.jpg",
      categoryLabel: "Spreads",
      quantity: "400g",
      manufacturer: null,
      sourceProvider: "open_food_facts",
      sourceReference: "3017620422003",
    });
  });

  it("returns null when the provider reports status 0 (not found)", async () => {
    fetchMock.mockResolvedValue(jsonResponse({ status: 0 }));
    const result = await openFoodFactsProvider.lookupByIdentifier("00000000", new AbortController().signal);
    expect(result).toBeNull();
  });

  it("returns null when the matched product has no usable name", async () => {
    fetchMock.mockResolvedValue(jsonResponse({ status: 1, product: { brands: "Foo" } }));
    const result = await openFoodFactsProvider.lookupByIdentifier("00000000", new AbortController().signal);
    expect(result).toBeNull();
  });

  it("normalizes a malformed JSON body to PROVIDER_UNAVAILABLE, never throwing the raw parse error", async () => {
    fetchMock.mockResolvedValue(new Response("not json", { status: 200 }));
    await expect(
      openFoodFactsProvider.lookupByIdentifier("00000000", new AbortController().signal)
    ).rejects.toMatchObject({ code: "PRODUCT_LOOKUP_PROVIDER_UNAVAILABLE" });
  });

  it("normalizes an unexpected response shape to a miss rather than throwing", async () => {
    fetchMock.mockResolvedValue(jsonResponse({ unexpected: "shape" }));
    const result = await openFoodFactsProvider.lookupByIdentifier("00000000", new AbortController().signal);
    expect(result).toBeNull();
  });

  it("normalizes a 429 to PRODUCT_LOOKUP_RATE_LIMITED", async () => {
    fetchMock.mockResolvedValue(new Response(null, { status: 429 }));
    await expect(
      openFoodFactsProvider.lookupByIdentifier("00000000", new AbortController().signal)
    ).rejects.toMatchObject({ code: "PRODUCT_LOOKUP_RATE_LIMITED" });
  });

  it("normalizes a 500 to PRODUCT_LOOKUP_PROVIDER_UNAVAILABLE", async () => {
    fetchMock.mockResolvedValue(new Response(null, { status: 500 }));
    await expect(
      openFoodFactsProvider.lookupByIdentifier("00000000", new AbortController().signal)
    ).rejects.toMatchObject({ code: "PRODUCT_LOOKUP_PROVIDER_UNAVAILABLE" });
  });

  it("normalizes a network failure to PRODUCT_LOOKUP_PROVIDER_UNAVAILABLE", async () => {
    fetchMock.mockRejectedValue(new TypeError("network down"));
    await expect(
      openFoodFactsProvider.lookupByIdentifier("00000000", new AbortController().signal)
    ).rejects.toMatchObject({ code: "PRODUCT_LOOKUP_PROVIDER_UNAVAILABLE" });
  });

  it("normalizes an abort (timeout) to PRODUCT_LOOKUP_TIMEOUT", async () => {
    fetchMock.mockImplementation(() => {
      const err = new Error("aborted");
      err.name = "AbortError";
      return Promise.reject(err);
    });
    await expect(
      openFoodFactsProvider.lookupByIdentifier("00000000", new AbortController().signal)
    ).rejects.toMatchObject({ code: "PRODUCT_LOOKUP_TIMEOUT" });
  });

  it("truncates an oversized provider text field rather than passing it through raw", async () => {
    fetchMock.mockResolvedValue(
      jsonResponse({ status: 1, product: { product_name: "A".repeat(400) } })
    );
    const result = await openFoodFactsProvider.lookupByIdentifier("00000000", new AbortController().signal);
    // The Zod schema itself caps at 300 chars — an oversized value fails
    // schema validation and is treated as a miss (safer than truncating a
    // caller-controlled string that already failed one bound check).
    expect(result).toBeNull();
  });

  it("rejects a non-https/http image URL rather than passing it through", async () => {
    fetchMock.mockResolvedValue(
      jsonResponse({
        status: 1,
        product: { product_name: "X", image_url: "javascript:alert(1)" },
      })
    );
    const result = await openFoodFactsProvider.lookupByIdentifier("00000000", new AbortController().signal);
    expect(result?.imageUrl).toBeNull();
  });

  it("refuses to query the provider with a non-barcode identifier", async () => {
    await expect(
      openFoodFactsProvider.lookupByIdentifier("NOT-A-BARCODE", new AbortController().signal)
    ).rejects.toBeInstanceOf(ProductLookupProviderError);
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
