import { describe, expect, it } from "vitest";
import { createTestDbClient } from "./helpers/db-client";

/**
 * The application layer's RPC-response-sanitization posture (see
 * lib/products/actions.ts / lib/inventory/actions.ts) is safe partly
 * because, today, every role holding products.manage or inventory.adjust
 * also holds inventory.view_cost — create_product/record_inventory_movement's
 * Returns composite includes cost_price/unit_cost regardless of the
 * caller's actual permission (RETURNING bypasses column GRANTs), but the
 * app never forwards those fields anyway (§3), so this coincidence isn't
 * a live vulnerability. It IS a latent assumption worth guarding: if a
 * future migration ever splits these permissions differently, this test
 * fails and forces a review of the RPC-response-sanitization contract
 * specifically, before that assumption's absence can matter.
 *
 * Queried directly against role_permissions/roles/permissions — the
 * actual seeded RBAC matrix, not application-layer constants that could
 * drift from it independently.
 */
describe("RBAC implication: products.manage/inventory.adjust => inventory.view_cost", () => {
  it("every role with products.manage also has inventory.view_cost", async () => {
    const sql = createTestDbClient();
    try {
      const violations = await sql`
        select r.name
        from public.roles r
        join public.role_permissions rp on rp.role_id = r.id
        join public.permissions p on p.id = rp.permission_id
        where p.key = 'products.manage'
          and not exists (
            select 1
            from public.role_permissions rp2
            join public.permissions p2 on p2.id = rp2.permission_id
            where rp2.role_id = r.id and p2.key = 'inventory.view_cost'
          )
      `;
      expect(
        violations,
        `Roles with products.manage but not inventory.view_cost: ${violations.map((v) => v.name).join(", ")}`
      ).toHaveLength(0);
    } finally {
      await sql.end();
    }
  });

  it("every role with inventory.adjust also has inventory.view_cost", async () => {
    const sql = createTestDbClient();
    try {
      const violations = await sql`
        select r.name
        from public.roles r
        join public.role_permissions rp on rp.role_id = r.id
        join public.permissions p on p.id = rp.permission_id
        where p.key = 'inventory.adjust'
          and not exists (
            select 1
            from public.role_permissions rp2
            join public.permissions p2 on p2.id = rp2.permission_id
            where rp2.role_id = r.id and p2.key = 'inventory.view_cost'
          )
      `;
      expect(
        violations,
        `Roles with inventory.adjust but not inventory.view_cost: ${violations.map((v) => v.name).join(", ")}`
      ).toHaveLength(0);
    } finally {
      await sql.end();
    }
  });

  it("sanity check: at least one role actually has each of the three permissions (the test above isn't vacuously true)", async () => {
    const sql = createTestDbClient();
    try {
      const [manage] = await sql`select count(*)::int as n from public.role_permissions rp join public.permissions p on p.id = rp.permission_id where p.key = 'products.manage'`;
      const [adjust] = await sql`select count(*)::int as n from public.role_permissions rp join public.permissions p on p.id = rp.permission_id where p.key = 'inventory.adjust'`;
      const [viewCost] = await sql`select count(*)::int as n from public.role_permissions rp join public.permissions p on p.id = rp.permission_id where p.key = 'inventory.view_cost'`;
      expect(manage.n).toBeGreaterThan(0);
      expect(adjust.n).toBeGreaterThan(0);
      expect(viewCost.n).toBeGreaterThan(0);
    } finally {
      await sql.end();
    }
  });
});
