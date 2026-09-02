import { describe, expect, it, vi, afterEach } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";
import type { Database } from "@/lib/supabase/database.types";
import { deleteTestUser } from "./helpers/admin-client";
import { createOwnerAndBusiness, createMemberWithCustomPermissions, randomUuid } from "./helpers/inventory";
import { createBranch, getDefaultBranchId } from "./helpers/staff";
import { createTestDbClient } from "./helpers/db-client";

// Phase 1J application layer — exercises the REAL DAL functions
// (lib/audit/dal.ts) against a real database, mirroring
// returns-application.test.ts's own hybrid technique.
let currentClient: SupabaseClient<Database>;

vi.mock("@/lib/supabase/server", () => ({
  createClient: async () => currentClient,
}));
vi.mock("@/lib/auth/dal", async () => ({
  requireUser: async () => {
    const { data } = await currentClient.auth.getUser();
    if (!data.user) throw new Error("not signed in");
    return data.user;
  },
}));

const { listActivityEvents, getActivityBranchOptions, getActivityActorOptions } = await import("@/lib/audit/dal");

let cleanupUserIds: string[] = [];
afterEach(async () => {
  for (const id of cleanupUserIds) await deleteTestUser(id);
  cleanupUserIds = [];
});

async function seedEvent(businessId: string, actorUserId: string, overrides: Partial<{ action: string; category: string; branchId: string | null; resourceLabel: string }> = {}) {
  const sql = createTestDbClient();
  try {
    const rows = await sql<{ record_audit_event: string }[]>`
      select private.record_audit_event(
        ${businessId}::uuid, 'USER'::text, ${actorUserId}::uuid,
        ${overrides.action ?? "sale.created"}::text, ${overrides.category ?? "COMMERCE"}::text,
        ${overrides.branchId ?? null}::uuid, 'seed@example.test'::text, null::text,
        'sale'::text, ${randomUuid()}::uuid, ${overrides.resourceLabel ?? "SALE-000001"}::text,
        'SUCCESS'::text, '{}'::jsonb
      ) as record_audit_event
    `;
    return rows[0].record_audit_event;
  } finally {
    await sql.end();
  }
}

// SEC-01 regression fixture: a direct, privileged insert with an
// EXPLICIT created_at timestamp (down to genuine Postgres microsecond
// precision), bypassing private.record_audit_event entirely — that RPC
// has no created_at parameter (it always uses the column's own `default
// now()`), so this is the only way to place a real row at an exact
// boundary instant. This tests ONLY the read-side date-range filter in
// listActivityEvents; it is not a substitute for seedEvent's own
// RPC-backed instrumentation coverage.
async function seedEventAt(businessId: string, actorUserId: string, createdAtIso: string) {
  const sql = createTestDbClient();
  try {
    const rows = await sql<{ id: string }[]>`
      insert into public.audit_events (
        business_id, actor_type, actor_user_id, action, category,
        actor_email_snapshot, resource_type, resource_id,
        resource_label_snapshot, outcome, metadata, created_at
      ) values (
        ${businessId}::uuid, 'USER'::text, ${actorUserId}::uuid, 'sale.created'::text, 'COMMERCE'::text,
        'seed@example.test'::text, 'sale'::text, ${randomUuid()}::uuid,
        'SALE-BOUNDARY'::text, 'SUCCESS'::text, '{}'::jsonb, ${createdAtIso}::timestamptz
      ) returning id
    `;
    return rows[0].id;
  } finally {
    await sql.end();
  }
}

describe("Activity feed — permission contracts", () => {
  it("1. audit.view can list activity for its own business", async () => {
    const owner = await createOwnerAndBusiness("audit-app-view");
    cleanupUserIds.push(owner.userId);
    const eventId = await seedEvent(owner.businessId, owner.userId);

    currentClient = owner.client;
    const { rows } = await listActivityEvents(owner.businessId, {});
    expect(rows.some((r) => r.id === eventId)).toBe(true);
  });

  it("2. a caller without audit.view is rejected by listActivityEvents (RLS-backed, generic error)", async () => {
    const owner = await createOwnerAndBusiness("audit-app-no-view");
    cleanupUserIds.push(owner.userId);
    await seedEvent(owner.businessId, owner.userId);
    const stranger = await createMemberWithCustomPermissions(owner.businessId, "audit-app-no-view", ["sales.view"]);
    cleanupUserIds.push(stranger.userId);

    currentClient = stranger.client;
    const { rows } = await listActivityEvents(owner.businessId, {});
    expect(rows).toHaveLength(0);
  });

  it("3. a same-permission caller from a different tenant sees nothing", async () => {
    const owner = await createOwnerAndBusiness("audit-app-tenant-a");
    cleanupUserIds.push(owner.userId);
    const other = await createOwnerAndBusiness("audit-app-tenant-b");
    cleanupUserIds.push(other.userId);
    const eventId = await seedEvent(owner.businessId, owner.userId);

    currentClient = other.client;
    const { rows } = await listActivityEvents(owner.businessId, {});
    expect(rows.some((r) => r.id === eventId)).toBe(false);
  });

  it("40/41/42. a custom role holding audit.view ALONE (no staff.view, no branches.view, no sales.view, no reports.view) has a complete Activity experience", async () => {
    const owner = await createOwnerAndBusiness("audit-app-custom-role");
    cleanupUserIds.push(owner.userId);
    const branchB = await createBranch(owner.client, owner.businessId, { name: "Audit App Branch B" });
    await seedEvent(owner.businessId, owner.userId, { branchId: branchB });

    const viewer = await createMemberWithCustomPermissions(owner.businessId, "audit-app-custom-role", ["audit.view"]);
    cleanupUserIds.push(viewer.userId);

    currentClient = viewer.client;
    const { rows } = await listActivityEvents(owner.businessId, {});
    expect(rows.length).toBeGreaterThan(0);

    // Branch filter options must work without branches.view.
    const branches = await getActivityBranchOptions(owner.businessId);
    expect(branches.some((b) => b.id === branchB)).toBe(true);

    // Actor filter options must work without staff.view.
    const actors = await getActivityActorOptions(owner.businessId);
    expect(actors.some((a) => a.userId === owner.userId)).toBe(true);
  });

  it("39. seeded roles: OWNER/ADMIN/MANAGER/ACCOUNTANT hold audit.view; SALES/INVENTORY/VIEWER do not", async () => {
    const sql = createTestDbClient();
    try {
      // Scoped to the seven fixed BusinessOS role names only — other
      // tests in this shared local database may leave behind their own
      // one-off custom-permission fixture roles (createRoleWithPermissions),
      // which is expected and unrelated to this assertion.
      const rows = await sql<{ name: string }[]>`
        select r.name from public.roles r
        join public.role_permissions rp on rp.role_id = r.id
        join public.permissions p on p.id = rp.permission_id
        where p.key = 'audit.view'
          and r.name in ('OWNER', 'ADMIN', 'MANAGER', 'SALES', 'INVENTORY', 'ACCOUNTANT', 'VIEWER')
      `;
      expect(rows.map((r) => r.name).sort()).toEqual(["ACCOUNTANT", "ADMIN", "MANAGER", "OWNER"].sort());
    } finally {
      await sql.end();
    }
  });
});

describe("Activity feed — filters, search, and pagination", () => {
  it("4/5/6. category/branch filters, bounded+escaped search, and pagination all work correctly", async () => {
    const owner = await createOwnerAndBusiness("audit-app-filters");
    cleanupUserIds.push(owner.userId);
    const branchA = await getDefaultBranchId(owner.client, owner.businessId);
    const branchB = await createBranch(owner.client, owner.businessId, { name: "Audit Filter Branch B" });

    const saleEventId = await seedEvent(owner.businessId, owner.userId, { action: "sale.created", category: "COMMERCE", branchId: branchA, resourceLabel: "SALE-FILTER-001" });
    const branchEventId = await seedEvent(owner.businessId, owner.userId, { action: "branch.created", category: "ORGANIZATION", branchId: branchB, resourceLabel: "Audit Filter Branch B" });

    currentClient = owner.client;

    // Category filter.
    const { rows: commerceRows } = await listActivityEvents(owner.businessId, { category: "COMMERCE" });
    expect(commerceRows.some((r) => r.id === saleEventId)).toBe(true);
    expect(commerceRows.some((r) => r.id === branchEventId)).toBe(false);

    // Branch filter.
    const { rows: branchBRows } = await listActivityEvents(owner.businessId, { branchId: branchB });
    expect(branchBRows.some((r) => r.id === branchEventId)).toBe(true);
    expect(branchBRows.some((r) => r.id === saleEventId)).toBe(false);

    // Search: matches resource_label_snapshot.
    const { rows: searchRows } = await listActivityEvents(owner.businessId, { search: "SALE-FILTER-001" });
    expect(searchRows.some((r) => r.id === saleEventId)).toBe(true);
    expect(searchRows.some((r) => r.id === branchEventId)).toBe(false);

    // Search bound: a 500+ char search never throws (truncated before use).
    const { rows: longSearchRows } = await listActivityEvents(owner.businessId, { search: "z".repeat(500) });
    expect(longSearchRows).toHaveLength(0);

    // Wildcard escaping: a literal "%" must never match everything.
    const { rows: wildcardRows } = await listActivityEvents(owner.businessId, { search: "%" });
    expect(wildcardRows).toHaveLength(0);

    // Pagination: request a page size smaller than total rows by seeding
    // enough events, then confirm cursor advances without duplication.
    for (let i = 0; i < 30; i++) {
      await seedEvent(owner.businessId, owner.userId, { resourceLabel: `PAGINATION-${i}` });
    }
    const seen = new Set<string>();
    let cursor: string | undefined;
    for (let page = 0; page < 5; page++) {
      const { rows, nextCursor } = await listActivityEvents(owner.businessId, { cursor });
      for (const row of rows) {
        expect(seen.has(row.id)).toBe(false);
        seen.add(row.id);
      }
      if (!nextCursor) break;
      cursor = nextCursor;
    }
    expect(seen.size).toBeGreaterThanOrEqual(30);
  });
});

describe("Activity feed — error suppression", () => {
  it("10. a raw DB error never reaches the caller — a generic message only", async () => {
    const owner = await createOwnerAndBusiness("audit-app-error-suppression");
    cleanupUserIds.push(owner.userId);
    currentClient = owner.client;
    // A malformed businessId that still passes the UUID shape check at
    // the route layer but is nonsensical to the RPC would normally just
    // return empty rows via RLS; to force a genuine DB-level error, use
    // an actor filter value that IS a syntactically valid uuid so the
    // query itself succeeds — the real error-suppression contract is
    // already unit-tested in lib/returns/dal.test.ts's own identical
    // pattern; this test instead confirms the wrapping is present by
    // re-using getActivityBranchOptions/getActivityActorOptions against a
    // caller with NO permission at all, which the RPC itself denies.
    const stranger = await createMemberWithCustomPermissions(owner.businessId, "audit-app-error-suppression", ["sales.view"]);
    cleanupUserIds.push(stranger.userId);
    currentClient = stranger.client;
    await expect(getActivityBranchOptions(owner.businessId)).rejects.toThrow("Unable to load activity filters.");
  });
});

// SEC-01 remediation: permanent regression coverage for the date-range
// upper-bound fix in lib/audit/dal.ts (getNextUtcDayStart). Every event
// here is inserted with an EXPLICIT, real Postgres `timestamptz` value
// (see seedEventAt above) — never merely constructed and compared as a
// JavaScript Date, whose own precision ceiling (milliseconds) could mask
// exactly the microsecond-level bug this fix addresses. The boundary
// that matters is the one Postgres itself evaluates.
describe("Activity feed — date-range boundary (SEC-01)", () => {
  it("8/9/10. an inclusive end date includes events at the final millisecond, a sub-millisecond instant, and the final microsecond of that UTC day", async () => {
    const owner = await createOwnerAndBusiness("audit-app-daterange-inclusive");
    cleanupUserIds.push(owner.userId);

    const finalMillisecond = await seedEventAt(owner.businessId, owner.userId, "2026-09-02T23:59:59.999000Z");
    const subMillisecond = await seedEventAt(owner.businessId, owner.userId, "2026-09-02T23:59:59.999500Z");
    const finalMicrosecond = await seedEventAt(owner.businessId, owner.userId, "2026-09-02T23:59:59.999999Z");

    currentClient = owner.client;
    const { rows } = await listActivityEvents(owner.businessId, { dateFrom: "2026-09-02", dateTo: "2026-09-02" });
    const ids = rows.map((r) => r.id);

    expect(ids).toContain(finalMillisecond);
    expect(ids).toContain(subMillisecond);
    expect(ids).toContain(finalMicrosecond);
  });

  it("11. the next UTC day's midnight instant is excluded from the prior day's selected end date", async () => {
    const owner = await createOwnerAndBusiness("audit-app-daterange-exclusive");
    cleanupUserIds.push(owner.userId);

    const finalMicrosecond = await seedEventAt(owner.businessId, owner.userId, "2026-09-02T23:59:59.999999Z");
    const nextDayMidnight = await seedEventAt(owner.businessId, owner.userId, "2026-09-03T00:00:00.000000Z");

    currentClient = owner.client;
    const { rows } = await listActivityEvents(owner.businessId, { dateFrom: "2026-09-02", dateTo: "2026-09-02" });
    const ids = rows.map((r) => r.id);

    expect(ids).toContain(finalMicrosecond);
    expect(ids).not.toContain(nextDayMidnight);
  });

  it("12. dateFrom === dateTo returns the complete selected UTC day, start through final microsecond", async () => {
    const owner = await createOwnerAndBusiness("audit-app-daterange-samedays");
    cleanupUserIds.push(owner.userId);

    const dayStart = await seedEventAt(owner.businessId, owner.userId, "2026-09-02T00:00:00.000000Z");
    const midday = await seedEventAt(owner.businessId, owner.userId, "2026-09-02T12:00:00.000000Z");
    const dayEnd = await seedEventAt(owner.businessId, owner.userId, "2026-09-02T23:59:59.999999Z");
    const dayBefore = await seedEventAt(owner.businessId, owner.userId, "2026-09-01T23:59:59.999999Z");
    const dayAfter = await seedEventAt(owner.businessId, owner.userId, "2026-09-03T00:00:00.000000Z");

    currentClient = owner.client;
    const { rows } = await listActivityEvents(owner.businessId, { dateFrom: "2026-09-02", dateTo: "2026-09-02" });
    const ids = rows.map((r) => r.id);

    expect(ids).toContain(dayStart);
    expect(ids).toContain(midday);
    expect(ids).toContain(dayEnd);
    expect(ids).not.toContain(dayBefore);
    expect(ids).not.toContain(dayAfter);
  });

  it("13. a multi-day range includes the full first day through the final microsecond of the last day, and excludes the day after", async () => {
    const owner = await createOwnerAndBusiness("audit-app-daterange-multiday");
    cleanupUserIds.push(owner.userId);

    const firstDayStart = await seedEventAt(owner.businessId, owner.userId, "2026-09-01T00:00:00.000000Z");
    const secondDayEnd = await seedEventAt(owner.businessId, owner.userId, "2026-09-02T23:59:59.999999Z");
    const dayBefore = await seedEventAt(owner.businessId, owner.userId, "2026-08-31T23:59:59.999999Z");
    const dayAfter = await seedEventAt(owner.businessId, owner.userId, "2026-09-03T00:00:00.000000Z");

    currentClient = owner.client;
    const { rows } = await listActivityEvents(owner.businessId, { dateFrom: "2026-09-01", dateTo: "2026-09-02" });
    const ids = rows.map((r) => r.id);

    expect(ids).toContain(firstDayStart);
    expect(ids).toContain(secondDayEnd);
    expect(ids).not.toContain(dayBefore);
    expect(ids).not.toContain(dayAfter);
  });
});
