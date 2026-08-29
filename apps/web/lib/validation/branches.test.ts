import { describe, expect, it } from "vitest";
import {
  BranchNameSchema,
  BranchCodeSchema,
  BranchCountryCodeSchema,
  CreateBranchSchema,
  UpdateBranchSchema,
  IdSchema,
  parseBranchListFilters,
} from "./branches";

describe("BranchNameSchema", () => {
  it("accepts a 2-100 character name", () => {
    expect(BranchNameSchema.safeParse("Ikeja Branch").success).toBe(true);
  });
  it("rejects a 1-character name", () => {
    expect(BranchNameSchema.safeParse("A").success).toBe(false);
  });
  it("rejects a name over 100 characters", () => {
    expect(BranchNameSchema.safeParse("A".repeat(101)).success).toBe(false);
  });
  it("trims outer whitespace before length-checking", () => {
    const result = BranchNameSchema.safeParse("  Ikeja  ");
    expect(result.success).toBe(true);
    if (result.success) expect(result.data).toBe("Ikeja");
  });
});

describe("BranchCodeSchema", () => {
  it("accepts a code with no spaces", () => {
    const result = BranchCodeSchema.safeParse("BR-01");
    expect(result.success).toBe(true);
    if (result.success) expect(result.data).toBe("BR-01");
  });
  it("rejects a code containing internal spaces — mirrors create_business_branch's own INVALID_BRANCH_CODE check exactly (codes are never whitespace-collapsed, unlike names)", () => {
    expect(BranchCodeSchema.safeParse("BR 01").success).toBe(false);
  });
  it("rejects a code over 20 characters", () => {
    expect(BranchCodeSchema.safeParse("A".repeat(21)).success).toBe(false);
  });
  it("is optional — an empty/absent code transforms to undefined, not an empty string", () => {
    const result = BranchCodeSchema.safeParse(undefined);
    expect(result.success).toBe(true);
    if (result.success) expect(result.data).toBeUndefined();
  });
});

describe("BranchCountryCodeSchema", () => {
  it("accepts a 2-letter code and uppercases it", () => {
    const result = BranchCountryCodeSchema.safeParse("ng");
    expect(result.success).toBe(true);
    if (result.success) expect(result.data).toBe("NG");
  });
  it("rejects a non-2-letter value", () => {
    expect(BranchCountryCodeSchema.safeParse("NGA").success).toBe(false);
    expect(BranchCountryCodeSchema.safeParse("N1").success).toBe(false);
  });
});

describe("CreateBranchSchema", () => {
  const base = () => ({ creationKey: crypto.randomUUID(), name: "Ikeja Branch" });

  it("accepts the minimal valid shape (name + creationKey only)", () => {
    expect(CreateBranchSchema.safeParse(base()).success).toBe(true);
  });

  it("rejects a missing/malformed creationKey", () => {
    expect(CreateBranchSchema.safeParse({ ...base(), creationKey: "not-a-uuid" }).success).toBe(false);
  });

  it("rejects a missing name", () => {
    const { name: _name, ...rest } = base();
    void _name;
    expect(CreateBranchSchema.safeParse(rest).success).toBe(false);
  });
});

describe("UpdateBranchSchema", () => {
  it("has no creationKey field at all — mirrors update_business_branch's own RPC signature, which has none either", () => {
    expect("creationKey" in UpdateBranchSchema.shape).toBe(false);
  });

  it("has no status/is_default field — those are each their own dedicated action, never part of this schema", () => {
    expect("status" in UpdateBranchSchema.shape).toBe(false);
    expect("isDefault" in UpdateBranchSchema.shape).toBe(false);
  });

  it("accepts the minimal valid shape (name only)", () => {
    expect(UpdateBranchSchema.safeParse({ name: "Ikeja Branch" }).success).toBe(true);
  });
});

describe("IdSchema", () => {
  it("accepts a well-formed UUID", () => {
    expect(IdSchema.safeParse(crypto.randomUUID()).success).toBe(true);
  });
  it("rejects a non-UUID string", () => {
    expect(IdSchema.safeParse("not-a-uuid").success).toBe(false);
  });
});

describe("parseBranchListFilters", () => {
  it("passes through well-formed search/status", () => {
    const result = parseBranchListFilters({ search: "ikeja", status: "ACTIVE" });
    expect(result).toEqual({ search: "ikeja", status: "ACTIVE" });
  });

  it("silently drops a malformed status rather than throwing", () => {
    const result = parseBranchListFilters({ status: "not-a-status" });
    expect(result.status).toBeUndefined();
  });

  it("ignores an array value for a scalar field (Next.js searchParams shape)", () => {
    const result = parseBranchListFilters({ search: ["a", "b"] });
    expect(result.search).toBeUndefined();
  });

  it("returns undefined for every field when the query is empty", () => {
    expect(parseBranchListFilters({})).toEqual({ search: undefined, status: undefined });
  });
});
