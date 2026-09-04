import { describe, expect, it, vi, afterEach } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";
import type { Database } from "@/lib/supabase/database.types";
import { deleteTestUser } from "./helpers/admin-client";
import { createOwnerAndBusiness } from "./helpers/inventory";
import { createTestDbClient } from "./helpers/db-client";
import { encodeCursor } from "@/lib/pagination";

// SEC-1K-APP-01 remediation: permanent regression coverage proving a
// forged/tampered keyset cursor can never reach the notifications DAL's
// own PostgREST `.or(...)` filter construction, and that real,
// legitimate multi-page (including equal-timestamp) pagination still
// works exactly as before. Uses the SAME privileged direct-SQL insert
// technique already established in notifications-foundation.test.ts
// (bypassing private.create_notification entirely) — this round needs
// explicit, controlled `created_at` values (including exact ties) that
// the trusted writer's own `now()`-only design cannot produce, exactly
// like that file's own metadata-CHECK tests needed a direct insert for
// an equivalent reason.

let cleanupUserIds: string[] = [];
afterEach(async () => {
  for (const id of cleanupUserIds) await deleteTestUser(id);
  cleanupUserIds = [];
});

// `postgres.js` (the driver, not Postgres itself) silently pre-parses a
// BOUND parameter that looks like an ISO timestamp through its own
// internal JS Date encoder before ever sending it — collapsing genuine
// sub-millisecond precision (".999999") down to milliseconds (".999")
// even though a plain `${value}::timestamptz` tagged-template parameter
// looks like it should pass the literal text straight through (verified
// live: it does not). `sql.unsafe(...)` with the value embedded directly
// as SQL literal TEXT bypasses that driver-side parameter-type
// inference entirely, letting POSTGRES's own timestamptz parser (which
// has no such limitation) see the exact original string — this is safe
// here specifically because `createdAt` is always an internally-
// controlled test constant, never external/attacker-controlled input.
async function seedNotificationAt(businessId: string, userId: string, createdAt: string, title = "x") {
  const sql = createTestDbClient();
  try {
    const rows = (await sql.unsafe(
      `insert into public.notifications (business_id, category, notification_type, title, created_at)
       values ('${businessId}', 'FINANCE', 'expense.posted', '${title}', '${createdAt}'::timestamptz)
       returning id`
    )) as unknown as { id: string }[];
    const row = rows[0];
    await sql`
      insert into public.notification_recipients (notification_id, business_id, user_id)
      values (${row.id}, ${businessId}, ${userId})
    `;
    return row.id;
  } finally {
    await sql.end();
  }
}

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

const { listNotificationsForCurrentUser } = await import("@/lib/notifications/dal");

describe("Notification cursor — forged/malformed input never reaches PostgREST grammar", () => {
  const forgedIds = [
    ["a comma-injected id", "11111111-1111-1111-1111-111111111111,x.eq.1"],
    ["a closing-paren-injected id", "11111111-1111-1111-1111-111111111111)"],
    ["a dot/operator-shaped id", "11111111-1111-1111-1111-111111111111.eq.1"],
    ["a quote-injected id", "11111111-1111-1111-1111-111111111111'"],
    ["a backslash-injected id", "11111111-1111-1111-1111-111111111111\\"],
  ] as const;

  for (const [label, forgedId] of forgedIds) {
    it(`rejects ${label} — falls back to the first page, never a raw PostgREST error`, async () => {
      const owner = await createOwnerAndBusiness("notif-cursor-forged-id");
      cleanupUserIds.push(owner.userId);
      await seedNotificationAt(owner.businessId, owner.userId, "2026-09-04T10:00:00+00:00", "real one");

      currentClient = owner.client;
      const cursor = encodeCursor({ createdAt: "2026-09-04T10:00:00+00:00", id: forgedId });
      const { rows } = await listNotificationsForCurrentUser(owner.businessId, { cursor });

      // The forged id is structurally invalid, so the whole cursor is
      // discarded (matches decodeCursor's own established "malformed ->
      // no cursor" convention) — the real, legitimate row is still
      // returned as page one, never a thrown/raw database error.
      expect(rows.map((r) => r.title)).toContain("real one");
    });
  }

  const forgedTimestamps = [
    ["a comma-injected timestamp", "2026-09-04T10:00:00+00:00,x.eq.1"],
    ["a closing-paren-injected timestamp", "2026-09-04T10:00:00+00:00)"],
    ["arbitrary text", "'; drop table notifications; --"],
    ["a malformed timestamp (hour 24)", "2026-09-04T24:00:00+00:00"],
    ["an overly long timestamp", "2026-09-04T10:00:00.657079+00:00" + "0".repeat(50)],
  ] as const;

  for (const [label, forgedCreatedAt] of forgedTimestamps) {
    it(`rejects ${label} — falls back to the first page, never a raw PostgREST error`, async () => {
      const owner = await createOwnerAndBusiness("notif-cursor-forged-ts");
      cleanupUserIds.push(owner.userId);
      await seedNotificationAt(owner.businessId, owner.userId, "2026-09-04T10:00:00+00:00", "real one");

      currentClient = owner.client;
      const cursor = encodeCursor({ createdAt: forgedCreatedAt, id: crypto.randomUUID() });
      const { rows } = await listNotificationsForCurrentUser(owner.businessId, { cursor });

      expect(rows.map((r) => r.title)).toContain("real one");
    });
  }

  it("a well-formed cursor from a real prior page is still honored (the fix does not break legitimate pagination)", async () => {
    const owner = await createOwnerAndBusiness("notif-cursor-legitimate");
    cleanupUserIds.push(owner.userId);
    await seedNotificationAt(owner.businessId, owner.userId, "2026-09-04T10:00:00+00:00", "older");
    const newerId = await seedNotificationAt(owner.businessId, owner.userId, "2026-09-04T11:00:00+00:00", "newer");

    currentClient = owner.client;
    const cursor = encodeCursor({ createdAt: "2026-09-04T11:00:00+00:00", id: newerId });
    const { rows } = await listNotificationsForCurrentUser(owner.businessId, { cursor });

    // Paging past "newer" returns only "older" — the legitimate cursor
    // was honored, not silently discarded.
    expect(rows.map((r) => r.title)).toEqual(["older"]);
  });
});

describe("Notification cursor — real multi-page pagination (>25 rows, forces a genuine second page)", () => {
  it("traverses every row exactly once, in stable (created_at desc, id desc) order, across multiple real pages", async () => {
    const owner = await createOwnerAndBusiness("notif-cursor-multipage");
    cleanupUserIds.push(owner.userId);

    const ids: string[] = [];
    const base = new Date("2026-09-04T00:00:00.000000+00:00").getTime();
    for (let i = 0; i < 30; i++) {
      const createdAt = new Date(base + i * 1000).toISOString().replace("Z", "+00:00");
      ids.push(await seedNotificationAt(owner.businessId, owner.userId, createdAt, `row-${i}`));
    }

    currentClient = owner.client;
    const seen = new Set<string>();
    let cursor: string | undefined;
    let pages = 0;
    for (let page = 0; page < 10; page++) {
      const { rows, nextCursor } = await listNotificationsForCurrentUser(owner.businessId, { cursor });
      pages++;
      for (const row of rows) {
        expect(seen.has(row.id)).toBe(false);
        seen.add(row.id);
      }
      if (!nextCursor) break;
      cursor = nextCursor;
    }

    // DEFAULT_NOTIFICATION_PAGE_SIZE is 25 — 30 rows genuinely requires a
    // second page; this is NOT the previously-flagged "only 5 rows,
    // never forces page 2" gap.
    expect(pages).toBeGreaterThanOrEqual(2);
    for (const id of ids) {
      expect(seen.has(id)).toBe(true);
    }
    expect(seen.size).toBe(30);
  });
});

describe("Notification cursor — equal-timestamp pagination (id tie-breaker)", () => {
  it("correctly traverses a page boundary that falls INSIDE a group of rows sharing the exact same created_at", async () => {
    const owner = await createOwnerAndBusiness("notif-cursor-equal-ts");
    cleanupUserIds.push(owner.userId);

    // 20 rows at one shared instant, then 15 more at an EARLIER shared
    // instant — the default page size (25) boundary falls INSIDE the
    // first group of 20, forcing the (created_at, id) tie-breaker to do
    // real work at the exact page-2 boundary.
    const sharedLater = "2026-09-04T12:00:00.500000+00:00";
    const sharedEarlier = "2026-09-04T11:00:00.500000+00:00";
    const laterIds: string[] = [];
    const earlierIds: string[] = [];
    for (let i = 0; i < 20; i++) {
      laterIds.push(await seedNotificationAt(owner.businessId, owner.userId, sharedLater, `later-${i}`));
    }
    for (let i = 0; i < 15; i++) {
      earlierIds.push(await seedNotificationAt(owner.businessId, owner.userId, sharedEarlier, `earlier-${i}`));
    }

    currentClient = owner.client;
    const seen = new Set<string>();
    let cursor: string | undefined;
    let pages = 0;
    for (let page = 0; page < 10; page++) {
      const { rows, nextCursor } = await listNotificationsForCurrentUser(owner.businessId, { cursor });
      pages++;
      for (const row of rows) {
        // No duplicate id is ever returned across page boundaries, even
        // though dozens of rows share an identical created_at.
        expect(seen.has(row.id)).toBe(false);
        seen.add(row.id);
      }
      if (!nextCursor) break;
      cursor = nextCursor;
    }

    expect(pages).toBeGreaterThanOrEqual(2);
    for (const id of [...laterIds, ...earlierIds]) {
      expect(seen.has(id)).toBe(true);
    }
    expect(seen.size).toBe(35);
  });
});

describe("Notification cursor — genuine microsecond precision survives validation and pagination unchanged", () => {
  it("a cursor built from a real stored .999999-precision created_at round-trips and paginates correctly", async () => {
    const owner = await createOwnerAndBusiness("notif-cursor-microsecond");
    cleanupUserIds.push(owner.userId);

    const boundaryId = await seedNotificationAt(
      owner.businessId,
      owner.userId,
      "2026-09-04T23:59:59.999999+00:00",
      "boundary"
    );
    await seedNotificationAt(owner.businessId, owner.userId, "2026-09-04T23:59:59.999500+00:00", "just-before");

    currentClient = owner.client;
    // Fetch the real stored row to get the EXACT string PostgREST itself
    // emits for this value (never a value we constructed by hand) —
    // this is the authentic round-trip the fix must not break.
    const sql = createTestDbClient();
    let storedCreatedAt: string;
    try {
      const [row] = await sql<{ created_at: string }[]>`
        select to_json(created_at)#>>'{}' as created_at from public.notifications where id = ${boundaryId}
      `;
      storedCreatedAt = row.created_at;
    } finally {
      await sql.end();
    }
    expect(storedCreatedAt).toContain("999999");

    const cursor = encodeCursor({ createdAt: storedCreatedAt, id: boundaryId });
    const { rows } = await listNotificationsForCurrentUser(owner.businessId, { cursor });

    expect(rows.map((r) => r.title)).toEqual(["just-before"]);
  });
});
