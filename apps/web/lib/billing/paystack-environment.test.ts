import { describe, expect, it } from "vitest";
import { parsePaystackEnvironment, isValidPaystackEnvironment } from "./paystack-environment";

describe("parsePaystackEnvironment — fail closed, never a silent default", () => {
  it("returns null for undefined", () => {
    expect(parsePaystackEnvironment(undefined)).toBeNull();
  });

  it("returns null for an empty string", () => {
    expect(parsePaystackEnvironment("")).toBeNull();
  });

  it("returns null for a lowercase variant — canonicalization is deliberately NOT performed", () => {
    expect(parsePaystackEnvironment("test")).toBeNull();
    expect(parsePaystackEnvironment("live")).toBeNull();
  });

  it("returns null for garbage input", () => {
    expect(parsePaystackEnvironment("production")).toBeNull();
    expect(parsePaystackEnvironment("staging")).toBeNull();
    expect(parsePaystackEnvironment("TEST ")).toBeNull();
    expect(parsePaystackEnvironment(" LIVE")).toBeNull();
  });

  it("accepts exactly 'TEST'", () => {
    expect(parsePaystackEnvironment("TEST")).toBe("TEST");
  });

  it("accepts exactly 'LIVE'", () => {
    expect(parsePaystackEnvironment("LIVE")).toBe("LIVE");
  });
});

describe("isValidPaystackEnvironment", () => {
  it("accepts TEST/LIVE and rejects everything else", () => {
    expect(isValidPaystackEnvironment("TEST")).toBe(true);
    expect(isValidPaystackEnvironment("LIVE")).toBe(true);
    expect(isValidPaystackEnvironment("test")).toBe(false);
    expect(isValidPaystackEnvironment("")).toBe(false);
    expect(isValidPaystackEnvironment(undefined)).toBe(false);
    expect(isValidPaystackEnvironment(null)).toBe(false);
  });
});
