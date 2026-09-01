import { describe, expect, it } from "vitest";
import { isInvoiceOverdue, INVOICE_STATUS } from "./constants";

describe("isInvoiceOverdue", () => {
  it("is overdue: unpaid balance, due date in the past, not VOID/PAID", () => {
    expect(
      isInvoiceOverdue({ status: INVOICE_STATUS.ISSUED, dueDate: "2020-01-01", balance: 100 })
    ).toBe(true);
  });

  it("is NOT overdue when the balance is already zero (PAID)", () => {
    expect(
      isInvoiceOverdue({ status: INVOICE_STATUS.PAID, dueDate: "2020-01-01", balance: 0 })
    ).toBe(false);
  });

  it("is NOT overdue for a VOID invoice, even with a past due date and a nonzero nominal balance", () => {
    expect(
      isInvoiceOverdue({ status: INVOICE_STATUS.VOID, dueDate: "2020-01-01", balance: 100 })
    ).toBe(false);
  });

  it("is NOT overdue when there is no due date at all", () => {
    expect(
      isInvoiceOverdue({ status: INVOICE_STATUS.ISSUED, dueDate: null, balance: 100 })
    ).toBe(false);
  });

  it("is NOT overdue when the due date is in the future", () => {
    const futureDate = new Date(Date.now() + 30 * 24 * 60 * 60 * 1000).toISOString().slice(0, 10);
    expect(
      isInvoiceOverdue({ status: INVOICE_STATUS.ISSUED, dueDate: futureDate, balance: 100 })
    ).toBe(false);
  });

  it("is overdue for a PARTIALLY_PAID invoice with a remaining balance past its due date", () => {
    expect(
      isInvoiceOverdue({ status: INVOICE_STATUS.PARTIALLY_PAID, dueDate: "2020-01-01", balance: 30 })
    ).toBe(true);
  });

  // Codex adversarial review, remediation round 1, Low 4: at 00:30
  // Africa/Lagos (UTC+1) on September 1, the UTC calendar date is still
  // "2026-08-31" — a plain `new Date().toISOString().slice(0, 10)` would
  // wrongly treat an invoice due 2026-08-31 as due "today" (not yet
  // overdue) instead of overdue. 00:30 Lagos on Sep 1 == 23:30 UTC on
  // Aug 31 (Lagos has no daylight saving, a fixed year-round UTC+1).
  describe("Africa/Lagos calendar-day boundary", () => {
    const lagos0030OnSep1AsUtc = new Date("2026-08-31T23:30:00.000Z");

    it("an invoice due Aug 31 IS overdue at 00:30 Lagos on Sep 1", () => {
      expect(
        isInvoiceOverdue(
          { status: INVOICE_STATUS.ISSUED, dueDate: "2026-08-31", balance: 100 },
          lagos0030OnSep1AsUtc
        )
      ).toBe(true);
    });

    it("an invoice due Sep 1 (today, Lagos) is NOT overdue at 00:30 Lagos on Sep 1", () => {
      expect(
        isInvoiceOverdue(
          { status: INVOICE_STATUS.ISSUED, dueDate: "2026-09-01", balance: 100 },
          lagos0030OnSep1AsUtc
        )
      ).toBe(false);
    });

    it("a PAID invoice is never overdue, even past its due date, at this same instant", () => {
      expect(
        isInvoiceOverdue(
          { status: INVOICE_STATUS.PAID, dueDate: "2026-08-31", balance: 0 },
          lagos0030OnSep1AsUtc
        )
      ).toBe(false);
    });

    it("a VOID invoice is never overdue, even past its due date, at this same instant", () => {
      expect(
        isInvoiceOverdue(
          { status: INVOICE_STATUS.VOID, dueDate: "2026-08-31", balance: 100 },
          lagos0030OnSep1AsUtc
        )
      ).toBe(false);
    });
  });
});
