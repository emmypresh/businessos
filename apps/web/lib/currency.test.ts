import { describe, expect, it } from "vitest";
import { formatMoney } from "./currency";

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
});
