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

  describe("Phase 1E codes (expenses + reports)", () => {
    it("maps EXPENSE_IDEMPOTENCY_KEY_REUSED distinctly from the generic IDEMPOTENCY_KEY_REUSED", () => {
      expect(mapDatabaseError({ message: "EXPENSE_IDEMPOTENCY_KEY_REUSED" }).message).toContain(
        "expense may already have been recorded"
      );
    });

    it("maps INVALID_EXPENSE_AMOUNT/EXPENSE_AMOUNT_OUT_OF_RANGE with the amount field", () => {
      expect(mapDatabaseError({ message: "INVALID_EXPENSE_AMOUNT" }).field).toBe("amount");
      expect(mapDatabaseError({ message: "EXPENSE_AMOUNT_OUT_OF_RANGE" }).field).toBe("amount");
    });

    it("maps EXPENSE_CATEGORY_NOT_FOUND generically (non-disclosure) with the categoryId field", () => {
      const mapped = mapDatabaseError({ message: "EXPENSE_CATEGORY_NOT_FOUND" });
      expect(mapped.message).toBe("This category is not available.");
      expect(mapped.field).toBe("categoryId");
    });

    it("maps EXPENSE_CATEGORY_ARCHIVED distinctly from EXPENSE_CATEGORY_NOT_FOUND", () => {
      const archived = mapDatabaseError({ message: "EXPENSE_CATEGORY_ARCHIVED" });
      const notFound = mapDatabaseError({ message: "EXPENSE_CATEGORY_NOT_FOUND" });
      expect(archived.message).not.toBe(notFound.message);
    });

    it("maps EXPENSE_NOT_FOUND generically (non-disclosure — same treatment as PRODUCT_NOT_FOUND)", () => {
      expect(mapDatabaseError({ message: "EXPENSE_NOT_FOUND" }).message).toBe(
        "This expense is not available."
      );
    });

    it("maps EXPENSE_ALREADY_VOIDED", () => {
      expect(mapDatabaseError({ message: "EXPENSE_ALREADY_VOIDED" }).message).toBe(
        "This expense has already been voided."
      );
    });

    it("maps void_expense's own INVALID_VOID_REASON (no EXPENSE_ prefix — exact committed migration code) with the reason field", () => {
      const mapped = mapDatabaseError({ message: "INVALID_VOID_REASON" });
      expect(mapped.field).toBe("reason");
    });

    it("maps the expense_categories unique-name-index violation to a friendly, field-scoped message", () => {
      const mapped = mapDatabaseError({
        message:
          'duplicate key value violates unique constraint "expense_categories_name_unique_idx"',
        code: "23505",
      });
      expect(mapped.message).toBe("A category with this name already exists.");
      expect(mapped.field).toBe("name");
      expect(mapped.message).not.toContain("expense_categories_name_unique_idx");
    });

    it("maps INVALID_REPORT_RANGE and REPORT_AMOUNT_OUT_OF_RANGE to stable, safe messages", () => {
      expect(mapDatabaseError({ message: "INVALID_REPORT_RANGE" }).message).toBe(
        "The selected date range is invalid."
      );
      expect(mapDatabaseError({ message: "REPORT_AMOUNT_OUT_OF_RANGE" }).message).toBe(
        "One of the amounts in this report is too large."
      );
    });

    it("no Phase 1E mapping ever contains the word profit or margin", () => {
      const codes = [
        "EXPENSE_IDEMPOTENCY_KEY_REUSED",
        "INVALID_EXPENSE_AMOUNT",
        "EXPENSE_AMOUNT_OUT_OF_RANGE",
        "INVALID_EXPENSE_PAYMENT_METHOD",
        "INVALID_EXPENSE_DATE",
        "INVALID_EXPENSE_PAYEE",
        "INVALID_EXPENSE_REFERENCE",
        "INVALID_EXPENSE_NOTES",
        "EXPENSE_CATEGORY_ARCHIVED",
        "EXPENSE_CATEGORY_NOT_FOUND",
        "EXPENSE_ALREADY_VOIDED",
        "EXPENSE_NOT_FOUND",
        "INVALID_VOID_REASON",
        "INVALID_REPORT_RANGE",
        "REPORT_AMOUNT_OUT_OF_RANGE",
      ];
      for (const code of codes) {
        expect(mapDatabaseError({ message: code }).message.toLowerCase()).not.toMatch(/profit|margin/);
      }
    });
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
