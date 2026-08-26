import { describe, expect, it } from "vitest";
import { MEMBERSHIP_STATUS, ROLE_NAME } from "./constants";

describe("MEMBERSHIP_STATUS", () => {
  it("matches business_members' check constraint exactly (lowercase)", () => {
    // supabase/migrations/20260825202824_create_business_members.sql:
    // status text not null default 'active'
    //   check (status in ('invited', 'active', 'suspended', 'removed'))
    expect(MEMBERSHIP_STATUS).toEqual({
      INVITED: "invited",
      ACTIVE: "active",
      SUSPENDED: "suspended",
      REMOVED: "removed",
    });
  });
});

describe("ROLE_NAME", () => {
  it("matches roles seeded in create_roles_permissions.sql (uppercase)", () => {
    expect(ROLE_NAME.OWNER).toBe("OWNER");
    expect(ROLE_NAME.ADMIN).toBe("ADMIN");
    expect(ROLE_NAME.VIEWER).toBe("VIEWER");
  });
});
