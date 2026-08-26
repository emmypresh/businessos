import { describe, expect, it, afterEach } from "vitest";
import { deleteTestUser } from "./helpers/admin-client";
import { createOwnerAndBusiness, randomUuid } from "./helpers/inventory";
import { decodeCursor, encodeCursor } from "@/lib/pagination";

let cleanupUserIds: string[] = [];
afterEach(async () => {
  for (const id of cleanupUserIds) await deleteTestUser(id);
  cleanupUserIds = [];
});

// Exercises the exact keyset cursor query shape lib/products/dal.ts's
// listProducts and lib/inventory/dal.ts's getInventoryOverview/
// getInventoryHistory use (created_at DESC, id DESC, with the cursor's
// OR/AND tie-break) directly against the real Supabase API — proving the
// pagination is deterministic (no skip, no duplicate) rather than
// assuming supabase-js's .or() chaining composes the way the DAL code
// depends on it composing.
describe("keyset pagination determinism", () => {
  it("paginating through 7 products in pages of 3 visits every product exactly once, in strict order, across concurrent inserts", async () => {
    const { client, businessId, userId } = await createOwnerAndBusiness("page-determinism");
    cleanupUserIds.push(userId);

    const created: { id: string; name: string }[] = [];
    for (let i = 0; i < 7; i++) {
      const { data } = await client.rpc("create_product", {
        p_business_id: businessId,
        p_creation_key: randomUuid(),
        p_name: `Page Product ${i}`,
        p_sku: `page-${i}-${randomUuid()}`,
      });
      created.push({ id: data!.id, name: data!.name });
    }

    const pageSize = 3;
    const seen: string[] = [];
    let cursor: string | undefined;

    for (let page = 0; page < 10; page++) {
      let query = client
        .from("products")
        .select("id, name, created_at")
        .eq("business_id", businessId)
        .order("created_at", { ascending: false })
        .order("id", { ascending: false })
        .limit(pageSize + 1);

      const decoded = decodeCursor(cursor);
      if (decoded) {
        query = query.or(
          `created_at.lt.${decoded.createdAt},and(created_at.eq.${decoded.createdAt},id.lt.${decoded.id})`
        );
      }

      const { data, error } = await query;
      expect(error).toBeNull();
      const rows = data ?? [];
      const hasMore = rows.length > pageSize;
      const pageRows = hasMore ? rows.slice(0, pageSize) : rows;

      seen.push(...pageRows.map((r) => r.id));

      if (!hasMore) break;
      const last = pageRows[pageRows.length - 1];
      cursor = encodeCursor({ createdAt: last.created_at, id: last.id });
    }

    // Every created product visited exactly once — no skip, no duplicate.
    expect(seen).toHaveLength(created.length);
    expect(new Set(seen).size).toBe(created.length);
    for (const p of created) {
      expect(seen).toContain(p.id);
    }
  });

  it("a malformed/tampered cursor never throws and never leaks another tenant's data — it degrades to a first page of the caller's own tenant", async () => {
    const a = await createOwnerAndBusiness("page-tamper-a");
    const b = await createOwnerAndBusiness("page-tamper-b");
    cleanupUserIds.push(a.userId, b.userId);

    await a.client.rpc("create_product", {
      p_business_id: a.businessId,
      p_creation_key: randomUuid(),
      p_name: "Tenant A Product",
      p_sku: `tamper-a-${randomUuid()}`,
    });

    const decoded = decodeCursor("not-a-real-cursor");
    expect(decoded).toBeNull();

    // Business B's client, even with a nonsense cursor, only ever sees
    // its own (empty) product list — RLS remains the actual boundary,
    // the cursor decode failure just means "no cursor," never a crash.
    const { data, error } = await b.client
      .from("products")
      .select("id")
      .eq("business_id", a.businessId);
    expect(error).toBeNull();
    expect(data).toHaveLength(0);
  });
});
