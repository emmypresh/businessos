import { describe, expect, it } from "vitest";
import { mapDatabaseError, toActionState } from "./errors";

describe("mapDatabaseError", () => {
  it("maps PRODUCT_IDEMPOTENCY_KEY_REUSED distinctly from IDEMPOTENCY_KEY_REUSED", () => {
    expect(mapDatabaseError({ message: "PRODUCT_IDEMPOTENCY_KEY_REUSED" }).message).toContain(
      "product may already have been created"
    );
    expect(mapDatabaseError({ message: "IDEMPOTENCY_KEY_REUSED" }).message).toContain(
      "adjustment may already have been recorded"
    );
  });

  it("maps SKU_UNAVAILABLE and BARCODE_UNAVAILABLE with a field", () => {
    expect(mapDatabaseError({ message: "SKU_UNAVAILABLE" }).field).toBe("sku");
    expect(mapDatabaseError({ message: "BARCODE_UNAVAILABLE" }).field).toBe("barcode");
  });

  it("maps CANNOT_ARCHIVE_WITH_STOCK", () => {
    expect(mapDatabaseError({ message: "CANNOT_ARCHIVE_WITH_STOCK" }).message).toContain(
      "still has stock recorded"
    );
  });

  it("maps INSUFFICIENT_STOCK with a quantity field", () => {
    const mapped = mapDatabaseError({ message: "INSUFFICIENT_STOCK" });
    expect(mapped.field).toBe("quantity");
  });

  it("maps PRODUCT_ARCHIVED and PRODUCT_NOT_TRACKED", () => {
    expect(mapDatabaseError({ message: "PRODUCT_ARCHIVED" }).message).toContain("archived");
    expect(mapDatabaseError({ message: "PRODUCT_NOT_TRACKED" }).message).toContain(
      "does not track inventory"
    );
  });

  it("maps LOCATION_ARCHIVED and LOCATION_NOT_FOUND to the identical message (non-disclosure)", () => {
    const archived = mapDatabaseError({ message: "LOCATION_ARCHIVED" });
    const notFound = mapDatabaseError({ message: "LOCATION_NOT_FOUND" });
    expect(archived).toEqual(notFound);
  });

  it("maps PRODUCT_NOT_FOUND generically (non-disclosure — same message for forged or genuinely missing)", () => {
    expect(mapDatabaseError({ message: "PRODUCT_NOT_FOUND" }).message).toBe(
      "This product is not available."
    );
  });

  it("maps NO_DEFAULT_LOCATION", () => {
    expect(mapDatabaseError({ message: "NO_DEFAULT_LOCATION" }).message).toContain(
      "No inventory location"
    );
  });

  it("maps 42501 to a generic permission-denied message, never the raw Postgres text", () => {
    const mapped = mapDatabaseError({
      message: 'permission denied for table products',
      code: "42501",
    });
    expect(mapped.message).toBe("You don't have permission to do this.");
    expect(mapped.message).not.toContain("permission denied for table");
  });

  it("falls back to a generic message for an unmapped/unknown error, never leaking raw Postgres detail", () => {
    const mapped = mapDatabaseError({
      message: 'duplicate key value violates unique constraint "some_internal_constraint_name"',
      code: "23505",
    });
    expect(mapped.message).toBe("Something went wrong. Please try again.");
  });

  it("handles a null/undefined error safely", () => {
    expect(mapDatabaseError(null).message).toBe("Something went wrong. Please try again.");
    expect(mapDatabaseError(undefined).message).toBe("Something went wrong. Please try again.");
  });
});

describe("toActionState", () => {
  it("a field-scoped mapping produces ONLY fieldErrors — no top-level error, so the message never renders twice", () => {
    const state = toActionState({ message: "This SKU is already in use.", field: "sku" });
    expect(state).toEqual({ fieldErrors: { sku: ["This SKU is already in use."] } });
    expect(state).not.toHaveProperty("error");
  });

  it("a non-field mapping produces ONLY a top-level error", () => {
    const state = toActionState({ message: "Something went wrong. Please try again." });
    expect(state).toEqual({ error: "Something went wrong. Please try again." });
    expect(state).not.toHaveProperty("fieldErrors");
  });
});
