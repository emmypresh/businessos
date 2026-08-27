import { describe, expect, it } from "vitest";
import {
  ExpenseAmountSchema,
  CreateExpenseSchema,
  VoidExpenseSchema,
  CreateExpenseCategorySchema,
  IdSchema,
  parseExpenseListFilters,
} from "./expenses";
import { MAX_EXPENSE_AMOUNT, VOID_REASON_MAX_LENGTH } from "@/lib/expenses/constants";

const categoryId = () => crypto.randomUUID();

describe("ExpenseAmountSchema precision (mirrors create_expense's exact round-trip rule)", () => {
  const ACCEPTED = ["1", "1.0", "1.00", "1.2", "1.23", "0.01"];
  const REJECTED = ["0", "-1", "1.234", "0.001", "abc", "", "1e5"];

  it.each(ACCEPTED)("accepts amount %s", (amount) => {
    const result = ExpenseAmountSchema.safeParse(amount);
    expect(result.success, amount).toBe(true);
  });

  it.each(REJECTED)("rejects amount %s", (amount) => {
    const result = ExpenseAmountSchema.safeParse(amount);
    expect(result.success, amount).toBe(false);
  });

  it("never silently rounds excess precision — the parsed value for a rejected input is never produced", () => {
    const result = ExpenseAmountSchema.safeParse("1.239");
    expect(result.success).toBe(false);
  });

  it("accepts the exact numeric(14,2) maximum", () => {
    const result = ExpenseAmountSchema.safeParse(String(MAX_EXPENSE_AMOUNT));
    expect(result.success).toBe(true);
  });

  it("rejects an amount exceeding the numeric(14,2) maximum", () => {
    const result = ExpenseAmountSchema.safeParse("1000000000000.00");
    expect(result.success).toBe(false);
  });

  it("parses to a plain number, not a string", () => {
    const result = ExpenseAmountSchema.safeParse("1.23");
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data).toBe(1.23);
      expect(typeof result.data).toBe("number");
    }
  });
});

describe("CreateExpenseSchema", () => {
  const base = () => ({
    creationKey: crypto.randomUUID(),
    categoryId: categoryId(),
    amount: "1000",
    paymentMethod: "CASH" as const,
    incurredAt: new Date().toISOString(),
  });

  it("accepts a minimal valid expense", () => {
    const result = CreateExpenseSchema.safeParse(base());
    expect(result.success).toBe(true);
  });

  it("rejects a malformed categoryId", () => {
    const result = CreateExpenseSchema.safeParse({ ...base(), categoryId: "not-a-uuid" });
    expect(result.success).toBe(false);
  });

  it("rejects a malformed creationKey", () => {
    const result = CreateExpenseSchema.safeParse({ ...base(), creationKey: "not-a-uuid" });
    expect(result.success).toBe(false);
  });

  it("rejects an invalid payment method enum value", () => {
    const result = CreateExpenseSchema.safeParse({ ...base(), paymentMethod: "CRYPTO" });
    expect(result.success).toBe(false);
  });

  it.each(["CASH", "BANK_TRANSFER", "CARD", "OTHER"])("accepts payment method %s", (paymentMethod) => {
    const result = CreateExpenseSchema.safeParse({ ...base(), paymentMethod });
    expect(result.success, paymentMethod).toBe(true);
  });

  it("rejects an incurred date more than 1 day in the future", () => {
    const future = new Date(Date.now() + 2 * 24 * 60 * 60 * 1000).toISOString();
    const result = CreateExpenseSchema.safeParse({ ...base(), incurredAt: future });
    expect(result.success).toBe(false);
  });

  it("accepts a historical incurred date with no lower bound", () => {
    const old = new Date("2015-01-01T00:00:00.000Z").toISOString();
    const result = CreateExpenseSchema.safeParse({ ...base(), incurredAt: old });
    expect(result.success).toBe(true);
  });

  it("rejects a missing/empty incurred date", () => {
    const result = CreateExpenseSchema.safeParse({ ...base(), incurredAt: "" });
    expect(result.success).toBe(false);
  });

  it("rejects payee longer than 200 characters", () => {
    const result = CreateExpenseSchema.safeParse({ ...base(), payee: "x".repeat(201) });
    expect(result.success).toBe(false);
  });

  it("rejects reference longer than 100 characters", () => {
    const result = CreateExpenseSchema.safeParse({ ...base(), reference: "x".repeat(101) });
    expect(result.success).toBe(false);
  });

  it("rejects notes longer than 2000 characters", () => {
    const result = CreateExpenseSchema.safeParse({ ...base(), notes: "x".repeat(2001) });
    expect(result.success).toBe(false);
  });

  it("the parsed shape never includes expenseNumber/categoryNameSnapshot/currency/status", () => {
    const result = CreateExpenseSchema.safeParse({
      ...base(),
      expenseNumber: "EXP-000001",
      status: "VOIDED",
    } as never);
    expect(result.success).toBe(true);
    if (result.success) {
      expect(Object.keys(result.data).sort()).toEqual(
        ["amount", "categoryId", "creationKey", "incurredAt", "paymentMethod"].sort()
      );
    }
  });
});

describe("VoidExpenseSchema", () => {
  it("requires a non-empty reason", () => {
    expect(VoidExpenseSchema.safeParse({ reason: "" }).success).toBe(false);
    expect(VoidExpenseSchema.safeParse({ reason: "   " }).success).toBe(false);
  });

  it("accepts a reasonable reason", () => {
    expect(VoidExpenseSchema.safeParse({ reason: "Recorded in error" }).success).toBe(true);
  });

  it("rejects a reason exceeding the max length", () => {
    const result = VoidExpenseSchema.safeParse({ reason: "x".repeat(VOID_REASON_MAX_LENGTH + 1) });
    expect(result.success).toBe(false);
  });

  it("accepts a reason at exactly the max length", () => {
    const result = VoidExpenseSchema.safeParse({ reason: "x".repeat(VOID_REASON_MAX_LENGTH) });
    expect(result.success).toBe(true);
  });
});

describe("CreateExpenseCategorySchema", () => {
  it("rejects a name shorter than 2 characters", () => {
    expect(CreateExpenseCategorySchema.safeParse({ name: "A" }).success).toBe(false);
  });

  it("rejects a name longer than 100 characters", () => {
    expect(CreateExpenseCategorySchema.safeParse({ name: "x".repeat(101) }).success).toBe(false);
  });

  it("accepts a valid name and trims whitespace", () => {
    const result = CreateExpenseCategorySchema.safeParse({ name: "  Fuel  " });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.name).toBe("Fuel");
    }
  });

  it("the parsed shape never includes status — every category starts ACTIVE", () => {
    const result = CreateExpenseCategorySchema.safeParse({ name: "Fuel", status: "ARCHIVED" } as never);
    expect(result.success).toBe(true);
    if (result.success) {
      expect(Object.keys(result.data)).toEqual(["name"]);
    }
  });
});

// Codex adversarial review, Finding 4 — every action identifier
// (businessId/categoryId/expenseId) is validated through this schema
// before any permission lookup or database call.
describe("IdSchema", () => {
  it("accepts a well-formed UUID", () => {
    expect(IdSchema.safeParse(crypto.randomUUID()).success).toBe(true);
  });

  it.each(["not-a-uuid", "12345", "", "  ", "'; drop table expenses; --", "00000000-0000-0000-0000"])(
    "rejects %s",
    (value) => {
      expect(IdSchema.safeParse(value).success).toBe(false);
    }
  );
});

// Codex adversarial review, Finding 3 + Finding 7.B — parseExpenseListFilters
// is the application-boundary function that keeps a malformed filter
// value out of lib/expenses/dal.ts (and therefore Postgres) entirely: a
// bad value in ONE field is dropped, every OTHER well-formed field still
// applies.
describe("parseExpenseListFilters", () => {
  it("passes through every well-formed field unchanged", () => {
    const id = categoryId();
    const result = parseExpenseListFilters({
      search: "office supplies",
      categoryId: id,
      paymentMethod: "CASH",
      status: "POSTED",
      dateFrom: "2026-08-01",
      dateTo: "2026-08-27",
    });
    expect(result).toEqual({
      search: "office supplies",
      categoryId: id,
      paymentMethod: "CASH",
      status: "POSTED",
      dateFrom: "2026-08-01",
      dateTo: "2026-08-27",
    });
  });

  it("drops a malformed categoryId, keeping every other well-formed field", () => {
    const result = parseExpenseListFilters({
      categoryId: "not-a-uuid",
      status: "POSTED",
    });
    expect(result.categoryId).toBeUndefined();
    expect(result.status).toBe("POSTED");
  });

  it("drops a malformed dateFrom/dateTo", () => {
    const result = parseExpenseListFilters({ dateFrom: "not-a-date", dateTo: "2026-02-30" });
    expect(result.dateFrom).toBeUndefined();
    expect(result.dateTo).toBeUndefined();
  });

  it("drops an invalid paymentMethod/status enum value", () => {
    const result = parseExpenseListFilters({ paymentMethod: "CRYPTO", status: "DRAFT" });
    expect(result.paymentMethod).toBeUndefined();
    expect(result.status).toBeUndefined();
  });

  it("treats a searchParams array value (Next.js's own possible shape) as absent, not a crash", () => {
    const result = parseExpenseListFilters({ search: ["a", "b"], categoryId: [categoryId()] });
    expect(result.search).toBeUndefined();
    expect(result.categoryId).toBeUndefined();
  });

  it("treats every field as absent for an entirely empty query", () => {
    expect(parseExpenseListFilters({})).toEqual({
      search: undefined,
      categoryId: undefined,
      paymentMethod: undefined,
      status: undefined,
      dateFrom: undefined,
      dateTo: undefined,
    });
  });

  it("never throws for any single malformed field", () => {
    for (const field of ["search", "categoryId", "paymentMethod", "status", "dateFrom", "dateTo"]) {
      expect(() => parseExpenseListFilters({ [field]: "\0￿<script>" })).not.toThrow();
    }
  });

  // Codex adversarial review (2nd pass), Finding 1 + Finding 7.A — the
  // exact repro: /expenses?dateFrom=2026-08-28&dateTo=2026-08-27. Both
  // dates are individually well-formed, but the pair is contradictory —
  // BOTH must be dropped (never one silently swapped for the other,
  // which would change the caller's actual filter intent), while every
  // other filter keeps working.
  describe("inverted date range (dateFrom after dateTo)", () => {
    it("drops BOTH dates when dateFrom is after dateTo — the exact Codex repro", () => {
      const result = parseExpenseListFilters({ dateFrom: "2026-08-28", dateTo: "2026-08-27" });
      expect(result.dateFrom).toBeUndefined();
      expect(result.dateTo).toBeUndefined();
    });

    it("never swaps the values — dateTo is not silently promoted to dateFrom or vice versa", () => {
      const result = parseExpenseListFilters({ dateFrom: "2026-08-28", dateTo: "2026-08-27" });
      expect(result.dateFrom).not.toBe("2026-08-27");
      expect(result.dateTo).not.toBe("2026-08-28");
    });

    it("every OTHER filter still applies when the date pair is inverted", () => {
      const id = categoryId();
      const result = parseExpenseListFilters({
        search: "fuel",
        categoryId: id,
        paymentMethod: "CARD",
        status: "POSTED",
        dateFrom: "2026-08-28",
        dateTo: "2026-08-27",
      });
      expect(result).toEqual({
        search: "fuel",
        categoryId: id,
        paymentMethod: "CARD",
        status: "POSTED",
        dateFrom: undefined,
        dateTo: undefined,
      });
    });

    it("an EQUAL pair (dateFrom === dateTo — a valid single-day range) is NOT treated as inverted", () => {
      const result = parseExpenseListFilters({ dateFrom: "2026-08-27", dateTo: "2026-08-27" });
      expect(result.dateFrom).toBe("2026-08-27");
      expect(result.dateTo).toBe("2026-08-27");
    });

    it("a normal, non-inverted pair is unaffected", () => {
      const result = parseExpenseListFilters({ dateFrom: "2026-08-01", dateTo: "2026-08-27" });
      expect(result.dateFrom).toBe("2026-08-01");
      expect(result.dateTo).toBe("2026-08-27");
    });

    it("a single date with no sibling is never treated as inverted", () => {
      expect(parseExpenseListFilters({ dateFrom: "2026-08-28" }).dateFrom).toBe("2026-08-28");
      expect(parseExpenseListFilters({ dateTo: "2026-08-27" }).dateTo).toBe("2026-08-27");
    });
  });
});
