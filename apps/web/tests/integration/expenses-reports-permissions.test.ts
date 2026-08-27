import { describe, expect, it } from "vitest";
import { createTestDbClient } from "./helpers/db-client";

/**
 * The exact Phase 1E role matrix, queried directly against the seeded
 * role_permissions/roles/permissions rows — not application-layer
 * constants that could drift from it independently. Matches
 * expenses_reports_permissions.sql's own role assignment exactly.
 */
const EXPECTED: Record<string, string[]> = {
  OWNER: ["expenses.view", "expenses.manage", "reports.view"],
  ADMIN: ["expenses.view", "expenses.manage", "reports.view"],
  MANAGER: ["expenses.view", "expenses.manage", "reports.view"],
  ACCOUNTANT: ["expenses.view", "expenses.manage", "reports.view"],
  SALES: [],
  INVENTORY: [],
  VIEWER: [],
};

const PHASE_1E_PERMISSION_KEYS = ["expenses.view", "expenses.manage", "reports.view"];

describe("Phase 1E permission matrix", () => {
  it("only exactly three Phase 1E permission keys exist", async () => {
    const sql = createTestDbClient();
    try {
      const rows = await sql<{ key: string }[]>`
        select key from public.permissions where key like 'expenses.%' or key like 'reports.%'
      `;
      expect(rows.map((r) => r.key).sort()).toEqual([...PHASE_1E_PERMISSION_KEYS].sort());
      // Explicitly NOT present — no delete/approve workflow, no
      // accounting.*/profit.* capability exists to gate.
      expect(rows.some((r) => r.key === "expenses.delete")).toBe(false);
      expect(rows.some((r) => r.key === "expenses.approve")).toBe(false);
      expect(rows.some((r) => r.key === "reports.manage")).toBe(false);
      expect(rows.some((r) => r.key.startsWith("accounting."))).toBe(false);
      expect(rows.some((r) => r.key.startsWith("profit."))).toBe(false);
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
          where r.name = ${role} and p.key = any(${PHASE_1E_PERMISSION_KEYS})
        `;
        expect(rows.map((r) => r.key).sort()).toEqual([...expectedKeys].sort());
      } finally {
        await sql.end();
      }
    });
  }
});
