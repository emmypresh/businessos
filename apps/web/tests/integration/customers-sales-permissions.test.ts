import { describe, expect, it } from "vitest";
import { createTestDbClient } from "./helpers/db-client";

/**
 * The exact Phase 1D role matrix, queried directly against the seeded
 * role_permissions/roles/permissions rows — not application-layer
 * constants that could drift from it independently. Matches
 * customers_sales_permissions.sql's own role assignment exactly.
 */
const EXPECTED: Record<string, string[]> = {
  OWNER: ["customers.view", "customers.manage", "sales.view", "sales.create"],
  ADMIN: ["customers.view", "customers.manage", "sales.view", "sales.create"],
  MANAGER: ["customers.view", "customers.manage", "sales.view", "sales.create"],
  SALES: ["customers.view", "customers.manage", "sales.view", "sales.create"],
  INVENTORY: [],
  ACCOUNTANT: ["customers.view", "sales.view"],
  VIEWER: ["customers.view", "sales.view"],
};

const PHASE_1D_PERMISSION_KEYS = ["customers.view", "customers.manage", "sales.view", "sales.create"];

describe("Phase 1D permission matrix", () => {
  it("only exactly four Phase 1D permission keys exist", async () => {
    const sql = createTestDbClient();
    try {
      const rows = await sql<{ key: string }[]>`
        select key from public.permissions where key like 'customers.%' or key like 'sales.%'
      `;
      expect(rows.map((r) => r.key).sort()).toEqual([...PHASE_1D_PERMISSION_KEYS].sort());
      // Explicitly NOT present — added only alongside a future reporting
      // phase (correction 13/16).
      expect(rows.some((r) => r.key === "sales.view_cost")).toBe(false);
      expect(rows.some((r) => r.key === "sales.manage")).toBe(false);
    } finally {
      await sql.end();
    }
  });

  for (const [role, expectedKeys] of Object.entries(EXPECTED)) {
    it(`${role} has exactly: ${expectedKeys.length ? expectedKeys.join(", ") : "(none)"}`, async () => {
      const sql = createTestDbClient();
      try {
        const rows = await sql<{ key: string }[]>`
          select p.key
          from public.roles r
          join public.role_permissions rp on rp.role_id = r.id
          join public.permissions p on p.id = rp.permission_id
          where r.name = ${role} and p.key = any(${PHASE_1D_PERMISSION_KEYS})
        `;
        expect(rows.map((r) => r.key).sort()).toEqual([...expectedKeys].sort());
      } finally {
        await sql.end();
      }
    });
  }
});
