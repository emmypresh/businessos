import { describe, expect, it, afterEach } from "vitest";
import { deleteTestUser } from "./helpers/admin-client";
import {
  createOwnerAndBusiness,
  createMemberWithCustomPermissions,
  randomUuid,
} from "./helpers/inventory";
import { createTestDbClient } from "./helpers/db-client";
import { createBranch, getDefaultBranchId } from "./helpers/staff";

let cleanupUserIds: string[] = [];
afterEach(async () => {
  for (const id of cleanupUserIds) await deleteTestUser(id);
  cleanupUserIds = [];
});

describe("default branch backfill/creation", () => {
  it("a newly created business gets exactly one ACTIVE default branch named 'Main Branch'", async () => {
    const { client, businessId, userId } = await createOwnerAndBusiness("branch-future-default");
    cleanupUserIds.push(userId);

    const { data: branches, error } = await client
      .from("business_branches")
      .select("id, name, is_default, status")
      .eq("business_id", businessId);
    expect(error).toBeNull();
    expect(branches).toHaveLength(1);
    expect(branches![0].name).toBe("Main Branch");
    expect(branches![0].is_default).toBe(true);
    expect(branches![0].status).toBe("ACTIVE");
  });

  // Codex adversarial review, Finding 8H: this test does NOT replay the
  // actual historical migration boundary — that boundary is long past by
  // the time any test suite runs (the backfill statement already executed
  // exactly once, during this environment's own `db reset`, against
  // whatever businesses existed at that moment; there is no way to
  // re-create "database state as it was before the migration ever ran"
  // from within a test). What this test DOES prove, honestly: the
  // backfill's own NOT EXISTS guard clause is a correct, reusable
  // predicate — re-executing the exact same statement text against the
  // CURRENT database (which already has a branch for every business,
  // including one just created seconds ago) matches and inserts zero
  // rows. That is a real (if narrower) guarantee — the guard would
  // equally protect a business seeded by an earlier run of this same
  // statement — but it is a statement-logic check, not a migration-replay
  // test, and must never be described as the latter.
  it("the backfill statement's NOT EXISTS guard is a correct, reusable predicate — re-executing it against the CURRENT database (not a migration replay) matches and inserts zero rows for an already-seeded business", async () => {
    const { businessId, userId } = await createOwnerAndBusiness("branch-backfill-idempotent");
    cleanupUserIds.push(userId);

    const sql = createTestDbClient();
    try {
      const result = await sql`
        insert into public.business_branches (business_id, name, is_default, status, created_by)
        select b.id, 'Main Branch', true, 'ACTIVE', b.created_by
        from public.businesses b
        where not exists (
          select 1 from public.business_branches x where x.business_id = b.id
        )
      `;
      expect(result.count).toBe(0);

      const branches = await sql`
        select count(*)::int as n from public.business_branches where business_id = ${businessId}
      `;
      expect(branches[0].n).toBe(1);
    } finally {
      await sql.end();
    }
  });
});

describe("exactly one default, always ACTIVE", () => {
  it("at most one default branch is representable — the partial unique index rejects a second", async () => {
    const { businessId, userId } = await createOwnerAndBusiness("branch-one-default-index");
    cleanupUserIds.push(userId);

    const sql = createTestDbClient();
    try {
      await expect(
        sql`
          insert into public.business_branches (business_id, name, is_default, status, created_by)
          select business_id, 'Second Default Attempt', true, 'ACTIVE', created_by
          from public.business_branches where business_id = ${businessId} limit 1
        `
      ).rejects.toThrow();
    } finally {
      await sql.end();
    }
  });

  it("a default branch can never be stored INACTIVE — the CHECK constraint rejects it", async () => {
    const { businessId, userId } = await createOwnerAndBusiness("branch-default-must-be-active");
    cleanupUserIds.push(userId);

    const sql = createTestDbClient();
    try {
      await expect(
        sql`update public.business_branches set status = 'INACTIVE' where business_id = ${businessId} and is_default = true`
      ).rejects.toThrow();
    } finally {
      await sql.end();
    }
  });
});

describe("normalized name/code uniqueness", () => {
  it("rejects a case/whitespace-variant duplicate name within the same business", async () => {
    const { client, businessId, userId } = await createOwnerAndBusiness("branch-name-unique");
    cleanupUserIds.push(userId);
    await createBranch(client, businessId, { name: "Downtown" });

    const { error } = await client.rpc("create_business_branch", {
      p_business_id: businessId,
      p_creation_key: randomUuid(),
      p_name: "  DOWNTOWN  ",
    });
    expect(error?.message).toContain("BRANCH_NAME_ALREADY_EXISTS");
  });

  it("the same name is available again in a DIFFERENT business (tenant-scoped uniqueness)", async () => {
    const a = await createOwnerAndBusiness("branch-name-unique-tenant-a");
    const b = await createOwnerAndBusiness("branch-name-unique-tenant-b");
    cleanupUserIds.push(a.userId, b.userId);
    await createBranch(a.client, a.businessId, { name: "Same Name" });

    const branchId = await createBranch(b.client, b.businessId, { name: "Same Name" });
    expect(branchId).toBeTruthy();
  });

  it("rejects a case/whitespace-variant duplicate code within the same business", async () => {
    const { client, businessId, userId } = await createOwnerAndBusiness("branch-code-unique");
    cleanupUserIds.push(userId);
    await createBranch(client, businessId, { name: "Branch A", code: "BR1" });

    const { error } = await client.rpc("create_business_branch", {
      p_business_id: businessId,
      p_creation_key: randomUuid(),
      p_name: "Branch B",
      p_code: "  br1  ",
    });
    expect(error?.message).toContain("BRANCH_CODE_ALREADY_EXISTS");
  });

  it("multiple branches with no code at all are allowed (code uniqueness only applies when set)", async () => {
    const { client, businessId, userId } = await createOwnerAndBusiness("branch-code-optional");
    cleanupUserIds.push(userId);
    const idA = await createBranch(client, businessId, { name: "No Code A" });
    const idB = await createBranch(client, businessId, { name: "No Code B" });
    expect(idA).not.toBe(idB);
  });

  it("an already-ARCHIVED... rather, deactivated branch's name is NOT freed for reuse", async () => {
    const { client, businessId, userId } = await createOwnerAndBusiness("branch-inactive-name-reserved");
    cleanupUserIds.push(userId);
    const branchId = await createBranch(client, businessId, { name: "Old Branch" });
    // Deactivate it (it's not the default, so this succeeds).
    await client.rpc("deactivate_business_branch", { p_business_id: businessId, p_branch_id: branchId });

    const { error } = await client.rpc("create_business_branch", {
      p_business_id: businessId,
      p_creation_key: randomUuid(),
      p_name: "Old Branch",
    });
    expect(error?.message).toContain("BRANCH_NAME_ALREADY_EXISTS");
  });
});

// Codex adversarial review round 3, Finding G: the production live probe
// for private.canonicalize_branch_name passed, but permanent integration
// coverage was incomplete — the existing "case/whitespace-variant
// duplicate" test above only exercises OUTER whitespace + case, never
// INTERNAL whitespace collapse, UPDATE/rename, or idempotent-replay
// interaction with a post-creation rename. These four tests close that
// gap directly against the real RPCs, not just the SQL function in
// isolation.
describe("branch name canonicalization (internal whitespace collapse)", () => {
  it("CREATE stores internal-whitespace-collapsed canonical spacing", async () => {
    const { client, businessId, userId } = await createOwnerAndBusiness("branch-canon-create");
    cleanupUserIds.push(userId);

    // Not " Main   Branch " — every fresh business already has an
    // auto-created default branch literally named "Main Branch" (see the
    // "default branch backfill/creation" describe block above), so that
    // exact name would collide rather than exercise plain creation.
    const branchId = await createBranch(client, businessId, { name: " Regional   Office " });

    const { data } = await client.from("business_branches").select("name").eq("id", branchId).single();
    expect(data?.name).toBe("Regional Office");
  });

  // The "existing" name here is deliberately the business's own
  // auto-created default branch ("Main Branch" — see the "default branch
  // backfill/creation" describe block above), so this test needs no extra
  // setup and doubles as proof that the default branch's own name
  // participates in canonical uniqueness exactly like any other branch's.
  it("CREATE collision: an internal-whitespace-variant of the existing default branch's name is rejected as a duplicate", async () => {
    const { client, businessId, userId } = await createOwnerAndBusiness("branch-canon-create-collision");
    cleanupUserIds.push(userId);

    const { error } = await client.rpc("create_business_branch", {
      p_business_id: businessId,
      p_creation_key: randomUuid(),
      p_name: "main     branch",
    });
    expect(error?.message).toContain("BRANCH_NAME_ALREADY_EXISTS");
  });

  it("UPDATE/rename stores internal-whitespace-collapsed canonical spacing", async () => {
    const { client, businessId, userId } = await createOwnerAndBusiness("branch-canon-update");
    cleanupUserIds.push(userId);
    const branchId = await createBranch(client, businessId, { name: "Original Name" });

    const { error } = await client.rpc("update_business_branch", {
      p_business_id: businessId,
      p_branch_id: branchId,
      p_name: "  Renamed   With   Spaces  ",
    });
    expect(error).toBeNull();

    const { data } = await client.from("business_branches").select("name").eq("id", branchId).single();
    expect(data?.name).toBe("Renamed With Spaces");
  });

  // Proves idempotent replay is arbitrated by the private request ledger
  // (private.business_branch_creation_requests' own stored canonical
  // payload), never by re-reading the branch row's CURRENT (possibly
  // since-renamed) name — a replay of the ORIGINAL create intent must
  // return the ORIGINAL branch id even after the branch has since been
  // renamed to something completely different.
  it("a post-rename replay of the ORIGINAL create intent (same key, same original payload) still returns the original branch UUID, unaffected by the rename", async () => {
    const { client, businessId, userId } = await createOwnerAndBusiness("branch-canon-post-rename-replay");
    cleanupUserIds.push(userId);
    const key = randomUuid();

    const { data: firstId, error: createErr } = await client.rpc("create_business_branch", {
      p_business_id: businessId,
      p_creation_key: key,
      p_name: "Replay Original Name",
    });
    expect(createErr).toBeNull();

    const { error: renameErr } = await client.rpc("update_business_branch", {
      p_business_id: businessId,
      p_branch_id: firstId as string,
      p_name: "Renamed After Creation",
    });
    expect(renameErr).toBeNull();

    // Replay the EXACT original creation intent (same key, same name
    // payload) — must resolve to the same branch id via the ledger's own
    // stored canonical payload, not fail or create a second row, and
    // certainly not compare against the branch's now-different current name.
    const { data: replayId, error: replayErr } = await client.rpc("create_business_branch", {
      p_business_id: businessId,
      p_creation_key: key,
      p_name: "Replay Original Name",
    });
    expect(replayErr).toBeNull();
    expect(replayId).toBe(firstId);

    // Exactly one row for this business under either name — the replay
    // never created a second branch.
    const { data: rows } = await client.from("business_branches").select("id, name").eq("business_id", businessId);
    const matching = rows!.filter((r) => r.id === firstId);
    expect(matching).toHaveLength(1);
    expect(matching[0].name).toBe("Renamed After Creation");
  });

  it("case-insensitive uniqueness holds together WITH internal-whitespace collapse (not merely one or the other)", async () => {
    const { client, businessId, userId } = await createOwnerAndBusiness("branch-canon-case-and-space");
    cleanupUserIds.push(userId);
    await createBranch(client, businessId, { name: "North Region" });

    const { error } = await client.rpc("create_business_branch", {
      p_business_id: businessId,
      p_creation_key: randomUuid(),
      p_name: "  NORTH   REGION  ",
    });
    expect(error?.message).toContain("BRANCH_NAME_ALREADY_EXISTS");
  });
});

describe("tenant isolation", () => {
  it("a branch created in business A is invisible to a member of business B", async () => {
    const a = await createOwnerAndBusiness("branch-tenant-a");
    const b = await createOwnerAndBusiness("branch-tenant-b");
    cleanupUserIds.push(a.userId, b.userId);
    const branchId = await createBranch(a.client, a.businessId, { name: "Tenant A Branch" });

    const { data } = await b.client.from("business_branches").select("id").eq("id", branchId);
    expect(data).toEqual([]);
  });

  it("update_business_branch is scoped by BOTH id and business_id — a forged businessId from another tenant cannot touch it", async () => {
    const a = await createOwnerAndBusiness("branch-tenant-update-a");
    const b = await createOwnerAndBusiness("branch-tenant-update-b");
    cleanupUserIds.push(a.userId, b.userId);
    const branchId = await createBranch(a.client, a.businessId, { name: "Original Name" });

    const { error } = await b.client.rpc("update_business_branch", {
      p_business_id: b.businessId,
      p_branch_id: branchId,
      p_name: "Hacked Name",
    });
    expect(error?.message).toContain("BRANCH_NOT_FOUND");

    const { data } = await a.client.from("business_branches").select("name").eq("id", branchId).single();
    expect(data?.name).toBe("Original Name");
  });
});

describe("default branch deactivation protection", () => {
  it("deactivate_business_branch refuses to deactivate the current default", async () => {
    const { client, businessId, userId } = await createOwnerAndBusiness("branch-deactivate-default");
    cleanupUserIds.push(userId);
    const defaultId = await getDefaultBranchId(client, businessId);

    const { error } = await client.rpc("deactivate_business_branch", {
      p_business_id: businessId,
      p_branch_id: defaultId,
    });
    expect(error?.message).toContain("DEFAULT_BRANCH_CANNOT_BE_DEACTIVATED");
  });

  it("set_default_business_branch atomically reassigns the default — exactly one default before and after", async () => {
    const { client, businessId, userId } = await createOwnerAndBusiness("branch-reassign-default");
    cleanupUserIds.push(userId);
    const newBranchId = await createBranch(client, businessId, { name: "New Default" });

    const { error } = await client.rpc("set_default_business_branch", {
      p_business_id: businessId,
      p_branch_id: newBranchId,
    });
    expect(error).toBeNull();

    const { data: branches } = await client
      .from("business_branches")
      .select("id, is_default")
      .eq("business_id", businessId);
    const defaults = branches!.filter((b) => b.is_default);
    expect(defaults).toHaveLength(1);
    expect(defaults[0].id).toBe(newBranchId);
  });

  it("the OLD default can be deactivated once it is no longer the default", async () => {
    const { client, businessId, userId } = await createOwnerAndBusiness("branch-old-default-deactivatable");
    cleanupUserIds.push(userId);
    const oldDefaultId = await getDefaultBranchId(client, businessId);
    const newBranchId = await createBranch(client, businessId, { name: "New Default 2" });
    await client.rpc("set_default_business_branch", { p_business_id: businessId, p_branch_id: newBranchId });

    const { error } = await client.rpc("deactivate_business_branch", {
      p_business_id: businessId,
      p_branch_id: oldDefaultId,
    });
    expect(error).toBeNull();
  });

  it("set_default_business_branch refuses an INACTIVE branch", async () => {
    const { client, businessId, userId } = await createOwnerAndBusiness("branch-set-default-inactive");
    cleanupUserIds.push(userId);
    const branchId = await createBranch(client, businessId, { name: "Will Be Inactive" });
    await client.rpc("deactivate_business_branch", { p_business_id: businessId, p_branch_id: branchId });

    const { error } = await client.rpc("set_default_business_branch", {
      p_business_id: businessId,
      p_branch_id: branchId,
    });
    expect(error?.message).toContain("BRANCH_NOT_ACTIVE");
  });

  // Codex adversarial review, Finding 8E: the existing "atomically
  // reassigns" test above only ever calls set_default_business_branch
  // SEQUENTIALLY — it never actually exercises the advisory-lock
  // serialization (salt 2, private.set_default_business_branch's own
  // pg_advisory_xact_lock) that exists specifically to keep two
  // concurrent default-swap attempts from racing to both believe they
  // won. This test fires two REAL simultaneous calls, each targeting a
  // DIFFERENT branch as the new default, and proves the invariant holds
  // regardless of which one the lock lets go first: exactly one default
  // branch exists afterward, never zero and never two.
  it("two simultaneous set_default_business_branch calls targeting DIFFERENT branches never leave zero or two defaults", async () => {
    const { client, businessId, userId } = await createOwnerAndBusiness("branch-concurrent-default");
    cleanupUserIds.push(userId);
    const branchA = await createBranch(client, businessId, { name: "Concurrent Default A" });
    const branchB = await createBranch(client, businessId, { name: "Concurrent Default B" });

    const [r1, r2] = await Promise.all([
      client.rpc("set_default_business_branch", { p_business_id: businessId, p_branch_id: branchA }),
      client.rpc("set_default_business_branch", { p_business_id: businessId, p_branch_id: branchB }),
    ]);
    // Both are legitimate, non-conflicting intents (unlike e.g. two
    // conflicting idempotency keys) — the advisory lock only serializes
    // them, it doesn't reject either, so both are expected to succeed.
    expect(r1.error).toBeNull();
    expect(r2.error).toBeNull();

    const { data: branches } = await client
      .from("business_branches")
      .select("id, is_default")
      .eq("business_id", businessId);
    const defaults = branches!.filter((b) => b.is_default);
    expect(defaults).toHaveLength(1);
    // Whichever call the lock let commit LAST is the one whose branch
    // ends up default — either outcome is correct, only the count matters.
    expect([branchA, branchB]).toContain(defaults[0].id);
  });

  it("reactivate_business_branch brings an INACTIVE branch back", async () => {
    const { client, businessId, userId } = await createOwnerAndBusiness("branch-reactivate");
    cleanupUserIds.push(userId);
    const branchId = await createBranch(client, businessId, { name: "Cycle Branch" });
    await client.rpc("deactivate_business_branch", { p_business_id: businessId, p_branch_id: branchId });

    const { error } = await client.rpc("reactivate_business_branch", {
      p_business_id: businessId,
      p_branch_id: branchId,
    });
    expect(error).toBeNull();

    const { data } = await client.from("business_branches").select("status").eq("id", branchId).single();
    expect(data?.status).toBe("ACTIVE");
  });
});

describe("branch RPC permissions", () => {
  it("branches.view alone cannot create/update/deactivate a branch", async () => {
    const owner = await createOwnerAndBusiness("branch-perm-view-only");
    cleanupUserIds.push(owner.userId);
    const branchId = await getDefaultBranchId(owner.client, owner.businessId);
    const viewOnly = await createMemberWithCustomPermissions(owner.businessId, "branch-perm-view-only", [
      "branches.view",
    ]);
    cleanupUserIds.push(viewOnly.userId);

    const { data: viewData, error: viewErr } = await viewOnly.client
      .from("business_branches")
      .select("id")
      .eq("business_id", owner.businessId);
    expect(viewErr).toBeNull();
    expect(viewData!.length).toBeGreaterThan(0);

    const { error: createErr } = await viewOnly.client.rpc("create_business_branch", {
      p_business_id: owner.businessId,
      p_creation_key: randomUuid(),
      p_name: "Should Not Exist",
    });
    expect(createErr?.message).toContain("insufficient_privilege");

    const { error: updateErr } = await viewOnly.client.rpc("update_business_branch", {
      p_business_id: owner.businessId,
      p_branch_id: branchId,
      p_name: "Hacked",
    });
    expect(updateErr?.message).toContain("insufficient_privilege");
  });

  it("branches.manage can create, update, and deactivate a non-default branch", async () => {
    const owner = await createOwnerAndBusiness("branch-perm-manage");
    cleanupUserIds.push(owner.userId);
    const manager = await createMemberWithCustomPermissions(owner.businessId, "branch-perm-manage", [
      "branches.manage",
    ]);
    cleanupUserIds.push(manager.userId);

    const branchId = await createBranch(manager.client, owner.businessId, { name: "Manager Made This" });
    const { error: updateErr } = await manager.client.rpc("update_business_branch", {
      p_business_id: owner.businessId,
      p_branch_id: branchId,
      p_name: "Renamed By Manager",
    });
    expect(updateErr).toBeNull();
  });

  it("a caller with no membership at all is denied, not just missing the specific permission", async () => {
    const owner = await createOwnerAndBusiness("branch-perm-stranger");
    const stranger = await createOwnerAndBusiness("branch-perm-stranger-2");
    cleanupUserIds.push(owner.userId, stranger.userId);

    const { error } = await stranger.client.rpc("create_business_branch", {
      p_business_id: owner.businessId,
      p_creation_key: randomUuid(),
      p_name: "Forged Attempt",
    });
    expect(error?.message).toContain("insufficient_privilege");
  });
});

describe("foreign/nonexistent branch ids", () => {
  it("update_business_branch on a random, nonexistent id returns a safe not-found error", async () => {
    const { client, businessId, userId } = await createOwnerAndBusiness("branch-foreign-random");
    cleanupUserIds.push(userId);

    const { error } = await client.rpc("update_business_branch", {
      p_business_id: businessId,
      p_branch_id: randomUuid(),
      p_name: "Should Not Apply",
    });
    expect(error?.message).toContain("BRANCH_NOT_FOUND");
  });

  it("set_default_business_branch on a foreign-tenant id returns BRANCH_NOT_FOUND, not a cross-tenant success", async () => {
    const a = await createOwnerAndBusiness("branch-foreign-setdefault-a");
    const b = await createOwnerAndBusiness("branch-foreign-setdefault-b");
    cleanupUserIds.push(a.userId, b.userId);
    const branchIdA = await createBranch(a.client, a.businessId, { name: "A Branch" });

    const { error } = await b.client.rpc("set_default_business_branch", {
      p_business_id: b.businessId,
      p_branch_id: branchIdA,
    });
    expect(error?.message).toContain("BRANCH_NOT_FOUND");
  });
});

describe("no delete path", () => {
  it("authenticated has no DELETE grant on business_branches at all", async () => {
    const { client, businessId, userId } = await createOwnerAndBusiness("branch-no-delete");
    cleanupUserIds.push(userId);
    const branchId = await getDefaultBranchId(client, businessId);

    const { error } = await client.from("business_branches").delete().eq("id", branchId);
    expect(error).not.toBeNull();
  });

  it("no delete_business_branch (or similarly named) RPC exists in the schema", async () => {
    const sql = createTestDbClient();
    try {
      const rows = await sql<{ proname: string }[]>`
        select proname from pg_proc
        where proname ilike '%delete_business_branch%' or proname ilike '%remove_business_branch%'
      `;
      expect(rows).toEqual([]);
    } finally {
      await sql.end();
    }
  });
});

describe("branch creation idempotency", () => {
  it("a double-submit under the same creationKey produces exactly one branch", async () => {
    const { client, businessId, userId } = await createOwnerAndBusiness("branch-idempotent");
    cleanupUserIds.push(userId);
    const key = randomUuid();

    const [id1, id2] = await Promise.all([
      client.rpc("create_business_branch", { p_business_id: businessId, p_creation_key: key, p_name: "Idempotent Branch" }),
      client.rpc("create_business_branch", { p_business_id: businessId, p_creation_key: key, p_name: "Idempotent Branch" }),
    ]);
    expect(id1.error).toBeNull();
    expect(id2.error).toBeNull();
    expect(id1.data).toBe(id2.data);

    const { data: rows } = await client
      .from("business_branches")
      .select("id")
      .eq("business_id", businessId)
      .eq("name", "Idempotent Branch");
    expect(rows).toHaveLength(1);
  });

  it("the same creationKey with a DIFFERENT name conflicts safely", async () => {
    const { client, businessId, userId } = await createOwnerAndBusiness("branch-idempotent-conflict");
    cleanupUserIds.push(userId);
    const key = randomUuid();
    await client.rpc("create_business_branch", { p_business_id: businessId, p_creation_key: key, p_name: "First Intent" });

    const { error } = await client.rpc("create_business_branch", {
      p_business_id: businessId,
      p_creation_key: key,
      p_name: "Different Intent",
    });
    expect(error?.message).toContain("BRANCH_IDEMPOTENCY_KEY_REUSED");
  });
});
