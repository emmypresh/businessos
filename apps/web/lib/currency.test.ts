import { describe, expect, it } from "vitest";
import { formatMoney, formatMoneyForBusiness } from "./currency";

describe("formatMoney", () => {
  it("formats a whole number with 2 decimal places", () => {
    expect(formatMoney(1000, "NGN")).toBe("NGN 1,000.00");
  });

  it("formats with thousands separators", () => {
    expect(formatMoney(1234567.89, "NGN")).toBe("NGN 1,234,567.89");
  });

  it("formats zero", () => {
    expect(formatMoney(0, "NGN")).toBe("NGN 0.00");
  });

  it("formats a negative amount (e.g. a negative net cash flow) with a minus sign", () => {
    expect(formatMoney(-500, "NGN")).toBe("NGN -500.00");
  });

  it("never recomputes — the displayed value is exactly the input, rounded only for 2-decimal display", () => {
    expect(formatMoney(0.005, "NGN")).toBe("NGN 0.01");
  });

  it("defaults to code display for any currency, not just NGN", () => {
    expect(formatMoney(1234567.89, "USD")).toBe("USD 1,234,567.89");
    expect(formatMoney(1234567.89, "GBP")).toBe("GBP 1,234,567.89");
  });

  describe("display: 'symbol'", () => {
    it.each([
      ["NGN", "₦1,234,567.89"],
      ["GBP", "£1,234,567.89"],
      ["USD", "$1,234,567.89"],
      ["EUR", "€1,234,567.89"],
      ["GHS", "GH₵1,234,567.89"],
      ["KES", "KSh1,234,567.89"],
      ["ZAR", "R1,234,567.89"],
    ])("formats %s with its product symbol", (currency, expected) => {
      expect(formatMoney(1234567.89, currency, { display: "symbol" })).toBe(expected);
    });

    it("formats zero, negative and large values consistently", () => {
      expect(formatMoney(0, "USD", { display: "symbol" })).toBe("$0.00");
      expect(formatMoney(-500, "USD", { display: "symbol" })).toBe("$-500.00");
      expect(formatMoney(999999999.99, "USD", { display: "symbol" })).toBe(
        "$999,999,999.99"
      );
    });

    it("falls back to the ISO code for a currency outside the symbol table", () => {
      expect(formatMoney(100, "XYZ", { display: "symbol" })).toBe("XYZ100.00");
    });
  });
});

describe("formatMoneyForBusiness", () => {
  it("formats using the business's own currency in symbol mode", () => {
    expect(
      formatMoneyForBusiness(1234567.89, { country_code: "GH", currency_code: "GHS" })
    ).toBe("GH₵1,234,567.89");
  });

  it("formats a Nigerian business the same as the legacy call sites' expected currency, in symbol mode", () => {
    expect(
      formatMoneyForBusiness(1234567.89, { country_code: "NG", currency_code: "NGN" })
    ).toBe("₦1,234,567.89");
  });
});
