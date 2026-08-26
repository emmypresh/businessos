import { describe, expect, it, afterEach } from "vitest";
import { deleteTestUser } from "./helpers/admin-client";
import { createTestDbClient } from "./helpers/db-client";
import { createOwnerAndBusiness } from "./helpers/inventory";

let cleanupUserIds: string[] = [];
afterEach(async () => {
  for (const id of cleanupUserIds) await deleteTestUser(id);
  cleanupUserIds = [];
});

describe("inventory_locations", () => {
  it("a future business receives exactly one active default location", async () => {
    const { client, businessId, userId } = await createOwnerAndBusiness("loc-future");
    cleanupUserIds.push(userId);

    const { data, error } = await client
      .from("inventory_locations")
      .select("id, name, is_default, status")
      .eq("business_id", businessId);

    expect(error).toBeNull();
    expect(data).toHaveLength(1);
    expect(data![0].is_default).toBe(true);
    expect(data![0].status).toBe("active");
    expect(data![0].name).toBe("Main Store");
  });

  it("backfill: an existing business that predates location provisioning receives exactly one, idempotently", async () => {
    const { businessId, userId } = await createOwnerAndBusiness("loc-backfill");
    cleanupUserIds.push(userId);

    const sql = createTestDbClient();
    try {
      // Reproduce "predates provisioning": delete the location the trigger
      // already gave this business — no Supabase API role has a write
      // grant on this table, so this needs the raw connection, matching
      // this repo's established fixture-setup convention. The
      // last-active-location trigger correctly refuses to let this
      // business's only location be removed via ordinary means (that's
      // exactly its job) — this fixture bypasses it for one statement,
      // purely to construct the synthetic "predates migration" state, and
      // re-enables it immediately after in a finally block so the
      // invariant is never actually weakened for any other test sharing
      // this database.
      await sql`alter table public.inventory_locations disable trigger inventory_locations_protect_last_active`;
      try {
        await sql`delete from public.inventory_locations where business_id = ${businessId}`;
      } finally {
        await sql`alter table public.inventory_locations enable trigger inventory_locations_protect_last_active`;
      }

      const backfill = () => sql`
        insert into public.inventory_locations (business_id, name, is_default, status, created_by)
        select b.id, 'Main Store', true, 'active', b.created_by
        from public.businesses b
        where not exists (
          select 1 from public.inventory_locations l where l.business_id = b.id
        )
        and b.id = ${businessId}
      `;

      await backfill();
      let rows = await sql`select id, is_default, status, name from public.inventory_locations where business_id = ${businessId}`;
      expect(rows).toHaveLength(1);
      expect(rows[0].is_default).toBe(true);
      expect(rows[0].status).toBe("active");
      expect(rows[0].name).toBe("Main Store");

      // Re-run: idempotent, still exactly one row.
      await backfill();
      rows = await sql`select id from public.inventory_locations where business_id = ${businessId}`;
      expect(rows).toHaveLength(1);
    } finally {
      await sql.end();
    }
  });

  it("the default location must remain active (CHECK constraint)", async () => {
    const { businessId, userId } = await createOwnerAndBusiness("loc-default-active");
    cleanupUserIds.push(userId);

    const sql = createTestDbClient();
    try {
      await expect(
        sql`update public.inventory_locations set status = 'archived' where business_id = ${businessId} and is_default = true`
      ).rejects.toThrow();
    } finally {
      await sql.end();
    }
  });

  it("the last active location cannot be removed while the business remains", async () => {
    const { businessId, userId } = await createOwnerAndBusiness("loc-last-active");
    cleanupUserIds.push(userId);

    const sql = createTestDbClient();
    try {
      // is_default must be unset before archiving is even attemptable
      // given the is_default->active CHECK; unset it first to isolate the
      // last-active-location trigger's own behavior specifically.
      await sql`update public.inventory_locations set is_default = false where business_id = ${businessId}`;
      await expect(
        sql`update public.inventory_locations set status = 'archived' where business_id = ${businessId}`
      ).rejects.toThrow(/cannot remove the last active inventory location/);

      await expect(
        sql`delete from public.inventory_locations where business_id = ${businessId}`
      ).rejects.toThrow(/cannot remove the last active inventory location/);
    } finally {
      await sql.end();
    }
  });

  it("business cascade deletion is not blocked by the last-active-location trigger", async () => {
    const { businessId, userId } = await createOwnerAndBusiness("loc-cascade");
    cleanupUserIds.push(userId);

    const sql = createTestDbClient();
    try {
      await sql`delete from public.businesses where id = ${businessId}`;
      const remaining = await sql`select id from public.inventory_locations where business_id = ${businessId}`;
      expect(remaining).toHaveLength(0);
    } finally {
      await sql.end();
    }
  });
});
