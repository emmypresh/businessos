import { describe, expect, it } from "vitest";
import {
  MemberQuerySchema,
  parseMemberQuery,
  parsePageParam,
  parseSupportTab,
  SUPPORT_TAB,
} from "./platform-business-operations";

describe("parseSupportTab", () => {
  it("defaults to overview for an undefined tab", () => {
    expect(parseSupportTab(undefined)).toBe(SUPPORT_TAB.OVERVIEW);
  });

  it("accepts every known tab value", () => {
    for (const tab of Object.values(SUPPORT_TAB)) {
      expect(parseSupportTab(tab)).toBe(tab);
    }
  });

  it("falls back to overview for an unknown tab, never trusting the raw string", () => {
    expect(parseSupportTab("../../etc/passwd")).toBe(SUPPORT_TAB.OVERVIEW);
    expect(parseSupportTab("settings")).toBe(SUPPORT_TAB.OVERVIEW);
  });

  it("falls back to overview when given an array (malformed query)", () => {
    expect(parseSupportTab(["members", "audit"])).toBe(SUPPORT_TAB.OVERVIEW);
  });
});

describe("MemberQuerySchema", () => {
  it("defaults to page 1, created_at desc, no filters", () => {
    const result = MemberQuerySchema.parse({});
    expect(result).toEqual({ sort: "created_at", dir: "desc", page: 1 });
  });

  it("accepts a valid role and status", () => {
    const result = MemberQuerySchema.safeParse({ role: "MANAGER", status: "active" });
    expect(result.success).toBe(true);
  });

  it("rejects an unknown role (strict allowlist)", () => {
    const result = MemberQuerySchema.safeParse({ role: "SUPERUSER" });
    expect(result.success).toBe(false);
  });

  it("rejects an unknown status", () => {
    const result = MemberQuerySchema.safeParse({ status: "banned" });
    expect(result.success).toBe(false);
  });

  it("rejects a non-UUID branch id", () => {
    const result = MemberQuerySchema.safeParse({ branch: "not-a-uuid" });
    expect(result.success).toBe(false);
  });

  it("rejects a search string over 200 characters", () => {
    const result = MemberQuerySchema.safeParse({ q: "x".repeat(201) });
    expect(result.success).toBe(false);
  });

  it("rejects page < 1", () => {
    const result = MemberQuerySchema.safeParse({ page: 0 });
    expect(result.success).toBe(false);
  });
});

describe("parseMemberQuery", () => {
  it("falls back to full defaults when the query is entirely malformed", () => {
    const result = parseMemberQuery({ role: "not-a-role", status: "also-invalid" });
    expect(result).toEqual({ sort: "created_at", dir: "desc", page: 1 });
  });

  it("passes through a valid, fully-specified query", () => {
    const result = parseMemberQuery({ q: "jane", role: "ADMIN", status: "active", sort: "email", dir: "asc", page: "2" });
    expect(result).toEqual({
      q: "jane",
      role: "ADMIN",
      status: "active",
      sort: "email",
      dir: "asc",
      page: 2,
    });
  });

  it("ignores array-shaped query values", () => {
    const result = parseMemberQuery({ q: ["a", "b"] });
    expect(result.q).toBeUndefined();
  });
});

describe("parsePageParam", () => {
  it("defaults to 1 for an undefined/invalid value", () => {
    expect(parsePageParam(undefined)).toBe(1);
    expect(parsePageParam("not-a-number")).toBe(1);
    expect(parsePageParam("0")).toBe(1);
  });

  it("parses a valid page number", () => {
    expect(parsePageParam("3")).toBe(3);
  });
});
