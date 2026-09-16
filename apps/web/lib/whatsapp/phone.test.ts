import { describe, expect, it } from "vitest";
import { normalizeMetaWaIdToE164, phonesMatchExactly } from "@/lib/whatsapp/phone";

describe("normalizeMetaWaIdToE164", () => {
  it("prepends + to a digits-only Meta wa_id", () => {
    expect(normalizeMetaWaIdToE164("2348012345678")).toBe("+2348012345678");
  });

  it("strips any non-digit characters before validating", () => {
    expect(normalizeMetaWaIdToE164("+234 801 234 5678")).toBe("+2348012345678");
  });

  it("returns null for an empty value", () => {
    expect(normalizeMetaWaIdToE164("")).toBeNull();
  });

  it("returns null for a value that is too short to be a real number", () => {
    expect(normalizeMetaWaIdToE164("123")).toBeNull();
  });

  it("returns null for a value starting with 0 after stripping (invalid E.164)", () => {
    expect(normalizeMetaWaIdToE164("0123456789")).toBeNull();
  });
});

describe("phonesMatchExactly", () => {
  it("matches an exact stored phone against a normalized inbound phone", () => {
    expect(phonesMatchExactly("+2348012345678", "+2348012345678")).toBe(true);
  });

  it("does not match a null stored phone", () => {
    expect(phonesMatchExactly(null, "+2348012345678")).toBe(false);
  });

  it("does not perform any fuzzy/partial matching", () => {
    expect(phonesMatchExactly("2348012345678", "+2348012345678")).toBe(false);
    expect(phonesMatchExactly("+234 801 234 5678", "+2348012345678")).toBe(false);
  });
});
