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

  // Phase 1Q-0C: isInvoiceOverdue's third parameter threads a
  // per-business IANA timezone (previously always defaulted to
  // Africa/Lagos regardless of the invoice's actual business). Each case
  // below picks a UTC instant that is a DIFFERENT calendar date in the
  // named zone than in UTC itself, proving the timezone parameter — not
  // just the default — is what's actually driving the comparison.
  describe("per-business timezone threading", () => {
    it("Europe/London (BST, UTC+1 in September): 00:30 London on Sep 1 is still Aug 31 UTC", () => {
      const london0030OnSep1AsUtc = new Date("2026-08-31T23:30:00.000Z");
      expect(
        isInvoiceOverdue(
          { status: INVOICE_STATUS.ISSUED, dueDate: "2026-08-31", balance: 100 },
          london0030OnSep1AsUtc,
          "Europe/London"
        )
      ).toBe(true);
      expect(
        isInvoiceOverdue(
          { status: INVOICE_STATUS.ISSUED, dueDate: "2026-09-01", balance: 100 },
          london0030OnSep1AsUtc,
          "Europe/London"
        )
      ).toBe(false);
    });

    it("America/New_York (EDT, UTC-4 in September): 21:00 UTC on Sep 1 is already Sep 1 in New York", () => {
      const ny1700OnSep1 = new Date("2026-09-01T21:00:00.000Z");
      // An invoice due "today" (Sep 1) in New York is not yet overdue,
      // even though it's already past 20:00 UTC — proving this uses New
      // York's own calendar date, not a Lagos or UTC one.
      expect(
        isInvoiceOverdue(
          { status: INVOICE_STATUS.ISSUED, dueDate: "2026-09-01", balance: 100 },
          ny1700OnSep1,
          "America/New_York"
        )
      ).toBe(false);
      expect(
        isInvoiceOverdue(
          { status: INVOICE_STATUS.ISSUED, dueDate: "2026-08-31", balance: 100 },
          ny1700OnSep1,
          "America/New_York"
        )
      ).toBe(true);
    });

    it("America/Los_Angeles (PDT, UTC-7 in September) lags UTC's own calendar date, the opposite direction from Lagos/London", () => {
      // 05:00 UTC on Sep 1 is 22:00 PDT on Aug 31 — LA's OWN calendar date
      // is still Aug 31 even though UTC's is already Sep 1. An invoice
      // due Aug 31 is not yet overdue (it's still "today" in LA); one due
      // a day earlier already is.
      const la2200OnAug31AsUtc = new Date("2026-09-01T05:00:00.000Z");
      expect(
        isInvoiceOverdue(
          { status: INVOICE_STATUS.ISSUED, dueDate: "2026-08-31", balance: 100 },
          la2200OnAug31AsUtc,
          "America/Los_Angeles"
        )
      ).toBe(false);
      expect(
        isInvoiceOverdue(
          { status: INVOICE_STATUS.ISSUED, dueDate: "2026-08-30", balance: 100 },
          la2200OnAug31AsUtc,
          "America/Los_Angeles"
        )
      ).toBe(true);

      // 07:30 UTC on Sep 1 is 00:30 PDT on Sep 1 — LA has now rolled over
      // to Sep 1, so the same Aug-31 due date is overdue.
      const la0030OnSep1AsUtc = new Date("2026-09-01T07:30:00.000Z");
      expect(
        isInvoiceOverdue(
          { status: INVOICE_STATUS.ISSUED, dueDate: "2026-08-31", balance: 100 },
          la0030OnSep1AsUtc,
          "America/Los_Angeles"
        )
      ).toBe(true);
    });

    it("DST-aware: America/New_York in January (EST, UTC-5) resolves a different calendar date than the same UTC instant would in September (EDT, UTC-4)", () => {
      // 04:30 UTC on Jan 2 is 23:30 EST on Jan 1 (UTC-5, no DST in
      // January) — "today" in New York is still Jan 1 at this instant, so
      // an invoice due Dec 31 is overdue and one due Jan 1 is not yet,
      // proving the offset used is the DST-correct one for this date, not
      // a fixed year-round -4 or -5.
      const ny2330OnJan1AsUtc = new Date("2026-01-02T04:30:00.000Z");
      expect(
        isInvoiceOverdue(
          { status: INVOICE_STATUS.ISSUED, dueDate: "2025-12-31", balance: 100 },
          ny2330OnJan1AsUtc,
          "America/New_York"
        )
      ).toBe(true);
      expect(
        isInvoiceOverdue(
          { status: INVOICE_STATUS.ISSUED, dueDate: "2026-01-01", balance: 100 },
          ny2330OnJan1AsUtc,
          "America/New_York"
        )
      ).toBe(false);
    });

    it("omitting the timezone parameter still defaults to Africa/Lagos, unchanged from before this phase", () => {
      const lagos0030OnSep1AsUtc = new Date("2026-08-31T23:30:00.000Z");
      expect(
        isInvoiceOverdue(
          { status: INVOICE_STATUS.ISSUED, dueDate: "2026-08-31", balance: 100 },
          lagos0030OnSep1AsUtc
        )
      ).toBe(true);
    });
  });
});
