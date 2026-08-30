import { describe, expect, it, afterEach } from "vitest";
import { deleteTestUser } from "./helpers/admin-client";
import { createOwnerAndBusiness, createMemberWithCustomPermissions, randomUuid } from "./helpers/inventory";
import { makeSaleProduct, saleItem } from "./helpers/sales";
import { getDefaultBranchId, createBranch, getBranchLocationId, assignMemberToBranch, getMemberId } from "./helpers/staff";
import { createTestDbClient } from "./helpers/db-client";

// Phase 1G, Codex adversarial review round 2, Medium 3:
// set_default_business_branch (20260829080000_branch_aware_inventory_locations.sql)
// now atomically syncs the LEGACY, business-wide inventory_locations.is_default
// flag to the new default branch's own canonical location, inside the SAME
// advisory-lock-protected transaction as the business_branches.is_default
// swap — never leaving a half-updated state, and never two (or zero)
// business-wide inventory defaults.

let cleanupUserIds: string[] = [];
afterEach(async () => {
  for (const id of cleanupUserIds) await deleteTestUser(id);
  cleanupUserIds = [];
});

describe("set_default_business_branch — Medium 3: legacy inventory default stays synced", () => {
  it("switching the business default branch atomically flips inventory_locations.is_default to the new branch's own canonical location — exactly one of each exists afterward, and they correspond", async () => {
    const owner = await createOwnerAndBusiness("bsync-basic");
    cleanupUserIds.push(owner.userId);
    const branchB = await createBranch(owner.client, owner.businessId, { name: "Branch B" });
    const branchBLocationId = await getBranchLocationId(owner.businessId, branchB);

    const { error } = await owner.client.rpc("set_default_business_branch", {
      p_business_id: owner.businessId,
      p_branch_id: branchB,
    });
    expect(error).toBeNull();

    const { data: branches } = await owner.client
      .from("business_branches")
      .select("id, is_default")
      .eq("business_id", owner.businessId);
    const defaultBranches = branches!.filter((b) => b.is_default);
    expect(defaultBranches).toHaveLength(1);
    expect(defaultBranches[0].id).toBe(branchB);

    const sql = createTestDbClient();
    try {
      const defaultLocations = await sql<{ id: string; branch_id: string }[]>`
        select id, branch_id from public.inventory_locations
        where business_id = ${owner.businessId} and is_default = true
      `;
      expect(defaultLocations).toHaveLength(1);
      expect(defaultLocations[0].id).toBe(branchBLocationId);
      expect(defaultLocations[0].branch_id).toBe(branchB);
    } finally {
      await sql.end();
    }
  });

  it("switching the default and then deactivating the OLD default branch never causes stale-default targeting — the OWNER's own still-primary (now-inactive) branch is correctly DENIED by create_sale's omitted-branch guard, never silently redirected to the new default", async () => {
    const owner = await createOwnerAndBusiness("bsync-old-default-inactive");
    cleanupUserIds.push(owner.userId);
    const oldDefaultBranchId = await getDefaultBranchId(owner.client, owner.businessId);
    const branchB = await createBranch(owner.client, owner.businessId, { name: "New Default Branch" });
    const productId = (await makeSaleProduct(owner.client, owner.businessId, { trackInventory: false })).id;

    await owner.client.rpc("set_default_business_branch", { p_business_id: owner.businessId, p_branch_id: branchB });
    // The OWNER can never re-target their OWN branch assignment
    // (replace_member_branches forbids self-targeting — CANNOT_MANAGE_SELF,
    // a frozen Phase 1F rule) — their primary stays the ORIGINAL default
    // branch even after the business-wide default moves to Branch B.
    await owner.client.rpc("deactivate_business_branch", { p_business_id: owner.businessId, p_branch_id: oldDefaultBranchId });

    const { error } = await owner.client.rpc("create_sale", {
      p_business_id: owner.businessId,
      p_creation_key: randomUuid(),
      p_items: [saleItem(productId, 1)],
    });
    // Medium 2A's own resolution is via the caller's own primary branch,
    // never the business default — an inactive primary must be a
    // controlled denial, never a silent fallback to whatever the current
    // business default happens to be.
    expect(error?.message).toContain("insufficient_privilege");
  });

  it("a default-branch switch is correctly picked up by the Medium 2C legacy-alias compatibility path — it resolves against the CURRENT (post-switch) business default, never a stale one", async () => {
    const owner = await createOwnerAndBusiness("bsync-2c-live");
    cleanupUserIds.push(owner.userId);
    const productId = (await makeSaleProduct(owner.client, owner.businessId, { openingQuantity: 0 })).id;
    const originalDefaultBranchId = await getDefaultBranchId(owner.client, owner.businessId);
    const originalDefaultLocationId = await getBranchLocationId(owner.businessId, originalDefaultBranchId);
    const branchB = await createBranch(owner.client, owner.businessId, { name: "Branch B" });
    const branchBLocationId = await getBranchLocationId(owner.businessId, branchB);

    // A worker assigned ONLY to the ORIGINAL default branch (now about to
    // stop being the business-wide default) as their primary.
    const worker = await createMemberWithCustomPermissions(owner.businessId, "bsync-2c-live", [
      "inventory.adjust",
      "inventory.view_cost",
    ]);
    cleanupUserIds.push(worker.userId);
    const workerMemberId = await getMemberId(owner.businessId, worker.userId);
    await assignMemberToBranch(owner.client, owner.businessId, workerMemberId, [originalDefaultBranchId]);

    // Switch the business-wide default to Branch B — the legacy
    // inventory_locations.is_default flag now lives on branchBLocationId,
    // not originalDefaultLocationId.
    await owner.client.rpc("set_default_business_branch", { p_business_id: owner.businessId, p_branch_id: branchB });

    // The exact current, UNMODIFIED Phase 1F application's own calling
    // shape: always supplies "the business's current default location" —
    // which, dynamically, is now branchBLocationId. The worker has no
    // access to Branch B, but their own primary (the former default
    // branch) still has a valid canonical location, so Medium 2C's alias
    // must resolve there — tracking the LIVE default, never a stale one.
    const { data: ledgerRow, error } = await worker.client.rpc("record_inventory_movement", {
      p_business_id: owner.businessId,
      p_product_id: productId,
      p_inventory_location_id: branchBLocationId,
      p_movement_type: "ADJUSTMENT_IN",
      p_quantity: 4,
      p_idempotency_key: randomUuid(),
      p_reason: "Legacy-app stock count post-default-switch",
    });
    expect(error).toBeNull();
    expect(ledgerRow!.inventory_location_id).toBe(originalDefaultLocationId);
  });

  // Codex adversarial review Phase 1G round 2 (focused re-review), Low 2:
  // the ORIGINAL version of this test launched two real RPC calls via
  // Promise.all and asserted only on the final state. That only proves
  // Postgres's OWN row-locking/blocking semantics happen to produce a
  // consistent result under THIS particular network/scheduling — it never
  // actually observes the two calls contend for the SAME advisory lock at
  // all; both could just as easily have run fully sequentially with no
  // real overlap, and the test would look identical. This replaces that
  // with a REAL deterministic barrier, built from the exact primitive
  // already used by this suite's own Phase 1F precedent
  // (staff-hierarchy.test.ts's runDeterministicLastOwnerRace) — reused as
  // a narrow, LOCAL helper here rather than promoted into a shared
  // generic framework, since this is the only place in this file that
  // needs it:
  //
  //   1. Connection 1 impersonates the OWNER (set_config
  //      ('request.jwt.claim.sub', ..., true) — the exact JWT claim
  //      private.current_uid() reads) and calls set_default_business_branch
  //      targeting Branch A. Fully AWAITED — its own advisory-lock
  //      acquisition, both UPDATE pairs, and the whole function body have
  //      already run server-side — but the transaction is deliberately
  //      left UNCOMMITTED, so the advisory lock (salt 2) it holds stays
  //      held.
  //   2. Connection 2 (same owner, same business — the lock is keyed by
  //      business_id, not caller) dispatches, but does not yet await, the
  //      identical call targeting Branch B. It blocks immediately trying
  //      to acquire the SAME advisory lock connection 1 holds.
  //   3. We POLL pg_stat_activity (bounded, real state — never an
  //      arbitrary sleep) until connection 2's own backend PID is OBSERVED
  //      wait_event = 'advisory' — i.e. proof the two calls are genuinely
  //      contending for the same lock, not merely proof of a plausible
  //      final state. If this is never observed, the test fails outright
  //      rather than silently passing on an unproven schedule.
  //   4. Only THEN do we commit connection 1. Connection 2 unblocks,
  //      proceeds against the now-committed state, and completes.
  //
  // Because we control commit order explicitly, the final state is fully
  // deterministic every run (Branch B — whichever call we let go SECOND —
  // always ends up the winner), not merely "either A or B, only the count
  // matters" as the old test had to hedge.
  async function runDeterministicDefaultSwitchRace(params: {
    businessId: string;
    ownerUid: string;
    branchAId: string;
    branchBId: string;
  }) {
    const c1 = createTestDbClient();
    const c2 = createTestDbClient();
    try {
      await c1`begin`;
      await c1`select set_config('request.jwt.claim.sub', ${params.ownerUid}, true)`;
      const r1 = await c1`select set_default_business_branch(${params.businessId}, ${params.branchAId})`;

      const [{ pid: c2pid }] = await c2<{ pid: number }[]>`select pg_backend_pid() as pid`;
      await c2`begin`;
      await c2`select set_config('request.jwt.claim.sub', ${params.ownerUid}, true)`;
      // Dispatched but NOT awaited yet — attaching .catch() immediately is
      // what actually flushes the query onto the wire promptly (same
      // empirically-confirmed requirement as the Phase 1F precedent).
      const p2 = c2`select set_default_business_branch(${params.businessId}, ${params.branchBId})`;
      p2.catch(() => {});

      let blocked = false;
      for (let i = 0; i < 400; i++) {
        const rows = await c1<{ wait_event: string | null }[]>`
          select wait_event from pg_stat_activity where pid = ${c2pid}
        `;
        if (rows[0]?.wait_event && /advisory/i.test(rows[0].wait_event)) {
          blocked = true;
          break;
        }
        await new Promise((resolve) => setTimeout(resolve, 5));
      }
      if (!blocked) {
        throw new Error(
          "test harness error: the second transaction never reached the advisory-lock wait within the poll window — the barrier was not established, so this run cannot claim determinism"
        );
      }

      await c1`commit`;

      let err2: { message: string } | null = null;
      try {
        await p2;
      } catch (e) {
        err2 = e as { message: string };
      }
      try {
        await c2`commit`;
      } catch {
        await c2`rollback`.catch(() => {});
      }

      return { r1, err2 };
    } finally {
      await c1.end();
      await c2.end();
    }
  }

  it("two set_default_business_branch calls DETERMINISTICALLY OBSERVED contending for the same advisory lock never leave zero/two business defaults or zero/two inventory defaults — the survivors always correspond, and each branch's own canonical is_branch_default is untouched", async () => {
    const owner = await createOwnerAndBusiness("bsync-concurrent");
    cleanupUserIds.push(owner.userId);
    const branchA = await createBranch(owner.client, owner.businessId, { name: "Concurrent Sync A" });
    const branchB = await createBranch(owner.client, owner.businessId, { name: "Concurrent Sync B" });
    const branchALocationId = await getBranchLocationId(owner.businessId, branchA);
    const branchBLocationId = await getBranchLocationId(owner.businessId, branchB);

    const { err2 } = await runDeterministicDefaultSwitchRace({
      businessId: owner.businessId,
      ownerUid: owner.userId,
      branchAId: branchA,
      branchBId: branchB,
    });
    // Both are legitimate, non-conflicting intents (unlike e.g. two
    // conflicting idempotency keys) — the advisory lock only serializes
    // them, it never rejects either.
    expect(err2).toBeNull();

    const { data: branches } = await owner.client
      .from("business_branches")
      .select("id, is_default")
      .eq("business_id", owner.businessId);
    const defaultBranches = branches!.filter((b) => b.is_default);
    expect(defaultBranches).toHaveLength(1);
    // Deterministic, not "either" — connection 1 (Branch A) committed
    // first, so connection 2 (Branch B), unblocked and completed second,
    // is the one whose write is the final, surviving state.
    expect(defaultBranches[0].id).toBe(branchB);

    const sql = createTestDbClient();
    try {
      const defaultLocations = await sql<{ id: string; branch_id: string }[]>`
        select id, branch_id from public.inventory_locations
        where business_id = ${owner.businessId} and is_default = true
      `;
      expect(defaultLocations).toHaveLength(1);
      expect(defaultLocations[0].branch_id).toBe(branchB);
      expect(defaultLocations[0].id).toBe(branchBLocationId);

      // Every branch's own PER-BRANCH canonical location assignment is
      // completely untouched by the race — only the ONE business-wide
      // legacy is_default flag ever moves.
      const branchDefaults = await sql<{ branch_id: string; is_branch_default: boolean }[]>`
        select branch_id, is_branch_default from public.inventory_locations
        where id in (${branchALocationId}, ${branchBLocationId})
      `;
      for (const row of branchDefaults) {
        expect(row.is_branch_default, row.branch_id).toBe(true);
      }
    } finally {
      await sql.end();
    }
  });

  it("a target branch with no canonical location at all is rejected atomically with NO_CANONICAL_LOCATION_FOR_BRANCH — neither the business default nor the legacy inventory default move", async () => {
    const owner = await createOwnerAndBusiness("bsync-no-canonical");
    cleanupUserIds.push(owner.userId);
    const originalDefaultBranchId = await getDefaultBranchId(owner.client, owner.businessId);
    const branchB = await createBranch(owner.client, owner.businessId, { name: "Locationless Branch" });
    const branchBLocationId = await getBranchLocationId(owner.businessId, branchB);
    const originalDefaultLocationId = await getBranchLocationId(owner.businessId, originalDefaultBranchId);

    // Defense-in-depth fixture only: force Branch B into the structurally
    // unexpected "no canonical location" state directly via SQL — every
    // branch created through the real RPC always gets one automatically
    // (private.create_default_branch_inventory_location's own trigger),
    // so this state can only be reconstructed, never legitimately reached.
    const sql = createTestDbClient();
    try {
      await sql`delete from public.inventory_locations where id = ${branchBLocationId}`;
    } finally {
      await sql.end();
    }

    const { error } = await owner.client.rpc("set_default_business_branch", {
      p_business_id: owner.businessId,
      p_branch_id: branchB,
    });
    expect(error?.message).toContain("NO_CANONICAL_LOCATION_FOR_BRANCH");

    const { data: branches } = await owner.client
      .from("business_branches")
      .select("id, is_default")
      .eq("business_id", owner.businessId);
    const defaultBranches = branches!.filter((b) => b.is_default);
    expect(defaultBranches).toHaveLength(1);
    expect(defaultBranches[0].id).toBe(originalDefaultBranchId);

    const sql2 = createTestDbClient();
    try {
      const defaultLocations = await sql2<{ id: string }[]>`
        select id from public.inventory_locations
        where business_id = ${owner.businessId} and is_default = true
      `;
      expect(defaultLocations).toHaveLength(1);
      expect(defaultLocations[0].id).toBe(originalDefaultLocationId);
    } finally {
      await sql2.end();
    }
  });
});
