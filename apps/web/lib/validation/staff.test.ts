import { describe, expect, it } from "vitest";
import {
  RoleSchema,
  InviteStaffSchema,
  ReplaceMemberBranchesSchema,
  ChangeRoleSchema,
  IdSchema,
  parseStaffListFilters,
} from "./staff";
import { ROLE_NAME } from "@/lib/business/constants";

describe("RoleSchema", () => {
  it.each(Object.values(ROLE_NAME))("accepts the seeded role %s", (role) => {
    expect(RoleSchema.safeParse(role).success).toBe(true);
  });
  it("rejects an unrecognized role", () => {
    expect(RoleSchema.safeParse("SUPERADMIN").success).toBe(false);
  });
  it("rejects a lowercase role name (case-sensitive — mirrors the exact seeded casing)", () => {
    expect(RoleSchema.safeParse("owner").success).toBe(false);
  });
});

// Codex adversarial review round-3 LOCKED INVARIANT, mirrored client-side:
// at least one branch, exactly one primary, primary must be in the set.
// The RPC layer is the actual authority — these tests only prove the
// client-side schema enforces the SAME shape before ever reaching it.
describe("branch-assignment invariant (shared by InviteStaffSchema and ReplaceMemberBranchesSchema)", () => {
  const branchA = crypto.randomUUID();
  const branchB = crypto.randomUUID();

  it("rejects an empty branch set", () => {
    const result = ReplaceMemberBranchesSchema.safeParse({ branchIds: [], primaryBranchId: branchA });
    expect(result.success).toBe(false);
  });

  it("rejects a missing primaryBranchId", () => {
    const result = ReplaceMemberBranchesSchema.safeParse({ branchIds: [branchA] });
    expect(result.success).toBe(false);
  });

  it("rejects a primaryBranchId outside the selected set", () => {
    const result = ReplaceMemberBranchesSchema.safeParse({ branchIds: [branchA], primaryBranchId: branchB });
    expect(result.success).toBe(false);
  });

  it("rejects a duplicated branch id", () => {
    const result = ReplaceMemberBranchesSchema.safeParse({ branchIds: [branchA, branchA], primaryBranchId: branchA });
    expect(result.success).toBe(false);
  });

  it("accepts a valid single-branch set", () => {
    const result = ReplaceMemberBranchesSchema.safeParse({ branchIds: [branchA], primaryBranchId: branchA });
    expect(result.success).toBe(true);
  });

  it("accepts a valid multi-branch set with the primary among them", () => {
    const result = ReplaceMemberBranchesSchema.safeParse({ branchIds: [branchA, branchB], primaryBranchId: branchB });
    expect(result.success).toBe(true);
  });
});

describe("InviteStaffSchema", () => {
  const branchId = crypto.randomUUID();
  const base = () => ({
    creationKey: crypto.randomUUID(),
    email: "person@example.test",
    role: ROLE_NAME.VIEWER,
    branchIds: [branchId],
    primaryBranchId: branchId,
  });

  it("accepts a fully valid shape", () => {
    expect(InviteStaffSchema.safeParse(base()).success).toBe(true);
  });

  it("rejects an invalid email", () => {
    expect(InviteStaffSchema.safeParse({ ...base(), email: "not-an-email" }).success).toBe(false);
  });

  it("rejects an invalid role", () => {
    expect(InviteStaffSchema.safeParse({ ...base(), role: "SUPERADMIN" }).success).toBe(false);
  });

  it("rejects an empty branch set — an invitation can never carry zero branches, mirroring create_business_invitation's own LOCKED INVARIANT", () => {
    expect(InviteStaffSchema.safeParse({ ...base(), branchIds: [] }).success).toBe(false);
  });
});

describe("ChangeRoleSchema", () => {
  it("accepts a valid role", () => {
    expect(ChangeRoleSchema.safeParse({ role: ROLE_NAME.ADMIN }).success).toBe(true);
  });
  it("rejects a missing role", () => {
    expect(ChangeRoleSchema.safeParse({}).success).toBe(false);
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

describe("parseStaffListFilters", () => {
  it("passes through well-formed role/status/branchId", () => {
    const branchId = crypto.randomUUID();
    const result = parseStaffListFilters({ role: ROLE_NAME.MANAGER, status: "active", branchId });
    expect(result).toEqual({ role: ROLE_NAME.MANAGER, status: "active", branchId });
  });

  it("silently drops a malformed role rather than throwing", () => {
    const result = parseStaffListFilters({ role: "not-a-role" });
    expect(result.role).toBeUndefined();
  });

  it("silently drops a malformed branchId rather than forwarding it as a raw string", () => {
    const result = parseStaffListFilters({ branchId: "not-a-uuid" });
    expect(result.branchId).toBeUndefined();
  });

  it("returns undefined for every field when the query is empty", () => {
    expect(parseStaffListFilters({})).toEqual({ role: undefined, status: undefined, branchId: undefined });
  });
});
