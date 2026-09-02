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

describe("Phase 1F — branches + staff error mapping", () => {
  it("maps every ordering-sensitive idempotency code to its OWN message, not the generic fallback (mirrors the Phase 1E EXPENSE_IDEMPOTENCY_KEY_REUSED ordering bug regression test)", () => {
    expect(mapDatabaseError({ message: "BRANCH_IDEMPOTENCY_KEY_REUSED" }).message).toContain("branch");
    expect(mapDatabaseError({ message: "INVITATION_IDEMPOTENCY_KEY_REUSED" }).message).toContain("invitation");
  });

  it("maps DEFAULT_BRANCH_CANNOT_BE_DEACTIVATED to actionable guidance, not a raw constraint message", () => {
    const mapped = mapDatabaseError({ message: "DEFAULT_BRANCH_CANNOT_BE_DEACTIVATED" });
    expect(mapped.message).toMatch(/set another active branch as default/i);
  });

  it("maps every hierarchy/self-management code to a safe, distinct message", () => {
    expect(mapDatabaseError({ message: "CANNOT_MANAGE_SELF" }).message).toMatch(/own account/i);
    expect(mapDatabaseError({ message: "CANNOT_MANAGE_OWNER" }).message).toMatch(/owner/i);
    expect(mapDatabaseError({ message: "CANNOT_ASSIGN_OWNER_ROLE" }).message).toMatch(/owner/i);
    expect(mapDatabaseError({ message: "LAST_OWNER_REQUIRED" }).message).toMatch(/active owner/i);
  });

  // Codex adversarial review, application-layer round 2, Low 5: these two
  // codes previously had no dedicated mapping at all and fell through to
  // the generic fallback — verified against
  // supabase/migrations/20260828080500_member_management_rpcs.sql's own
  // exact `raise exception` strings.
  it("maps MEMBER_ALREADY_SUSPENDED and MEMBER_NOT_SUSPENDED to distinct, accurate messages — never the generic fallback", () => {
    expect(mapDatabaseError({ message: "MEMBER_ALREADY_SUSPENDED" })).toEqual({
      message: "This staff member is already suspended.",
    });
    expect(mapDatabaseError({ message: "MEMBER_NOT_SUSPENDED" })).toEqual({
      message: "This staff member is already active.",
    });
  });

  it("MEMBER_NOT_FOUND and MEMBER_NOT_SUSPENDED do not collide with each other's mapping despite sharing the MEMBER_NOT_ prefix", () => {
    expect(mapDatabaseError({ message: "MEMBER_NOT_FOUND" }).message).toMatch(/not available/i);
    expect(mapDatabaseError({ message: "MEMBER_NOT_SUSPENDED" }).message).toMatch(/already active/i);
  });

  it("maps INVALID_BRANCH_ASSIGNMENT to the same plain-language invariant description regardless of which specific violation triggered it", () => {
    const mapped = mapDatabaseError({ message: "INVALID_BRANCH_ASSIGNMENT" });
    expect(mapped.message).toMatch(/at least one branch/i);
    expect(mapped.message).toMatch(/exactly one/i);
  });

  it("maps BRANCH_NOT_FOUND to a message that never distinguishes nonexistent from foreign-tenant (non-disclosure)", () => {
    const mapped = mapDatabaseError({ message: "BRANCH_NOT_FOUND" });
    expect(mapped.message).not.toMatch(/foreign|tenant|exist/i);
  });

  it("maps INVITATION_NOT_FOUND to a message that never distinguishes nonexistent from wrong-email (mirrors accept_business_invitation's own non-disclosure contract)", () => {
    const mapped = mapDatabaseError({ message: "INVITATION_NOT_FOUND" });
    expect(mapped.message).not.toMatch(/email|exist|wrong/i);
  });

  it("never leaks a raw private role name, schema name, or SQL keyword for any Phase 1F code", () => {
    const codes = [
      "BRANCH_IDEMPOTENCY_KEY_REUSED",
      "INVITATION_IDEMPOTENCY_KEY_REUSED",
      "INVALID_BRANCH_NAME",
      "INVALID_BRANCH_CODE",
      "INVALID_BRANCH_ADDRESS",
      "INVALID_BRANCH_COUNTRY_CODE",
      "INVALID_BRANCH_PHONE",
      "BRANCH_NAME_ALREADY_EXISTS",
      "BRANCH_CODE_ALREADY_EXISTS",
      "DEFAULT_BRANCH_CANNOT_BE_DEACTIVATED",
      "BRANCH_NOT_ACTIVE",
      "BRANCH_NOT_FOUND",
      "INVALID_BRANCH_ASSIGNMENT",
      "CANNOT_MANAGE_SELF",
      "CANNOT_MANAGE_OWNER",
      "CANNOT_ASSIGN_OWNER_ROLE",
      "LAST_OWNER_REQUIRED",
      "MEMBER_NOT_FOUND",
      "MEMBER_ALREADY_SUSPENDED",
      "MEMBER_NOT_SUSPENDED",
      "INVALID_ROLE",
      "INVALID_INVITATION_EMAIL",
      "INVITATION_ALREADY_PENDING",
      "INVITATION_ALREADY_ACCEPTED",
      "INVITATION_REVOKED",
      "INVITATION_EXPIRED",
      "ALREADY_BUSINESS_MEMBER",
      "INVITATION_NOT_FOUND",
    ];
    for (const code of codes) {
      const message = mapDatabaseError({ message: code }).message.toLowerCase();
      expect(message, code).not.toMatch(/private_|private\.|public\.|postgres|constraint|sqlstate/);
    }
  });
});

describe("Phase 1G — branch-aware operations error mapping", () => {
  it("maps NO_PRIMARY_BRANCH_ASSIGNED to the exact controlled blocked-state message, field-scoped to branchId", () => {
    const mapped = mapDatabaseError({ message: "NO_PRIMARY_BRANCH_ASSIGNED" });
    expect(mapped.message).toMatch(/active branch assigned/i);
    expect(mapped.field).toBe("branchId");
  });

  it("maps NO_CANONICAL_LOCATION_FOR_BRANCH to a safe, field-scoped message rather than the generic fallback", () => {
    const mapped = mapDatabaseError({ message: "NO_CANONICAL_LOCATION_FOR_BRANCH" });
    expect(mapped.message).toMatch(/inventory location/i);
    expect(mapped.field).toBe("branchId");
  });

  it("an inaccessible/inactive/foreign branch (insufficient_privilege from has_branch_access) still maps to the generic permission-denied message, never a raw code", () => {
    const mapped = mapDatabaseError({ message: "insufficient_privilege", code: "42501" });
    expect(mapped.message).toMatch(/don't have permission/i);
  });

  it("never leaks a raw private role name, schema name, or SQL keyword for any Phase 1G code", () => {
    const codes = ["NO_PRIMARY_BRANCH_ASSIGNED", "NO_CANONICAL_LOCATION_FOR_BRANCH"];
    for (const code of codes) {
      const message = mapDatabaseError({ message: code }).message.toLowerCase();
      expect(message, code).not.toMatch(/private_|private\.|public\.|postgres|constraint|sqlstate/);
    }
  });
});

describe("Phase 1I — returns + refunds error mapping", () => {
  it("maps RETURN_IDEMPOTENCY_KEY_REUSED to its OWN message, not the generic IDEMPOTENCY_KEY_REUSED fallback (mirrors the Phase 1E EXPENSE_IDEMPOTENCY_KEY_REUSED ordering bug regression test)", () => {
    expect(mapDatabaseError({ message: "RETURN_IDEMPOTENCY_KEY_REUSED" }).message).toContain("return");
  });

  it("RETURN_SALE_NOT_FOUND is deliberately the SAME message a nonexistent/foreign/inaccessible-branch sale all share — never a distinguishable disclosure", () => {
    const mapped = mapDatabaseError({ message: "RETURN_SALE_NOT_FOUND" });
    expect(mapped.message).toBe("The sale is no longer available for return.");
    expect(mapped.field).toBe("saleId");
  });

  it("maps every return-invariant code to a safe, distinct, field-scoped message", () => {
    expect(mapDatabaseError({ message: "RETURN_QUANTITY_EXCEEDED" }).field).toBe("items");
    expect(mapDatabaseError({ message: "RETURN_REFUND_EXCEEDED" }).field).toBe("refundAmount");
    expect(mapDatabaseError({ message: "INVALID_REFUND_AMOUNT" }).field).toBe("refundAmount");
    expect(mapDatabaseError({ message: "INVALID_REFUND_METHOD" }).field).toBe("refundMethod");
    expect(mapDatabaseError({ message: "INVALID_RETURN_REASON" }).field).toBe("reason");
    expect(mapDatabaseError({ message: "INVALID_RETURN_NOTES" }).field).toBe("notes");
  });

  it("never leaks a raw private role name, schema name, or SQL keyword for any Phase 1I code", () => {
    const codes = [
      "RETURN_SALE_NOT_FOUND",
      "RETURN_SALE_NOT_ELIGIBLE",
      "RETURN_ITEM_NOT_FOUND",
      "RETURN_QUANTITY_EXCEEDED",
      "RETURN_REFUND_EXCEEDED",
      "MALFORMED_RETURN_ITEMS",
    ];
    for (const code of codes) {
      const message = mapDatabaseError({ message: code }).message.toLowerCase();
      expect(message, code).not.toMatch(/private_|private\.|public\.|postgres|constraint|sqlstate/);
    }
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
