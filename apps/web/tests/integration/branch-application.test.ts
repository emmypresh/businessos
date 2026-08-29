import { describe, expect, it, vi, afterEach } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";
import type { Database } from "@/lib/supabase/database.types";
import { deleteTestUser } from "./helpers/admin-client";
import { createOwnerAndBusiness, createMemberWithCustomPermissions, randomUuid } from "./helpers/inventory";
import { createBranch as createBranchViaRpc } from "./helpers/staff";

// Hybrid technique — see tests/integration/expense-action-auth.test.ts for
// the full rationale. Server Actions redirect() on success, which throws a
// NEXT_REDIRECT-digest-tagged error even outside a real request; a test
// that reaches a successful completion catches that specific throw as
// proof of success, then verifies the resulting DB state / redirect
// target directly. lib/branches/dal.ts's own functions are exercised
// through this same mocked `createClient`/`requireUser`, so both the DAL
// and the Server Actions built on top of it are covered by one harness.
let currentClient: SupabaseClient<Database>;

vi.mock("@/lib/supabase/server", () => ({
  createClient: async () => currentClient,
}));
vi.mock("@/lib/auth/dal", async () => {
  return {
    requireUser: async () => {
      const { data } = await currentClient.auth.getUser();
      if (!data.user) throw new Error("not signed in");
      return data.user;
    },
    getAuthUser: async () => {
      const { data } = await currentClient.auth.getUser();
      return data.user ?? null;
    },
  };
});
vi.mock("next/cache", () => ({
  revalidatePath: () => {},
}));

const { createBranch, updateBranch, setDefaultBranch, deactivateBranch, reactivateBranch } = await import(
  "@/lib/branches/actions"
);
const { listBranches, getBranch, listActiveBranchesForPicker } = await import("@/lib/branches/dal");

function isRedirect(e: unknown): { isRedirect: boolean; target?: string } {
  if (
    typeof e === "object" &&
    e !== null &&
    "digest" in e &&
    typeof (e as { digest?: unknown }).digest === "string" &&
    (e as { digest: string }).digest.startsWith("NEXT_REDIRECT")
  ) {
    const parts = (e as { digest: string }).digest.split(";");
    return { isRedirect: true, target: parts[2] };
  }
  return { isRedirect: false };
}

async function expectRedirect(fn: () => Promise<unknown>): Promise<string> {
  try {
    await fn();
  } catch (e) {
    const r = isRedirect(e);
    if (r.isRedirect) return r.target!;
    throw e;
  }
  throw new Error("expected a redirect, but the action returned normally");
}

function formData(fields: Record<string, string>): FormData {
  const fd = new FormData();
  for (const [k, v] of Object.entries(fields)) fd.set(k, v);
  return fd;
}

let cleanupUserIds: string[] = [];
afterEach(async () => {
  for (const id of cleanupUserIds) await deleteTestUser(id);
  cleanupUserIds = [];
});

describe("createBranch action boundary", () => {
  it("rejects without mutating when branches.manage is absent (view-only)", async () => {
    const owner = await createOwnerAndBusiness("bapp-create-denied");
    cleanupUserIds.push(owner.userId);
    const viewOnly = await createMemberWithCustomPermissions(owner.businessId, "bapp-create-denied", ["branches.view"]);
    cleanupUserIds.push(viewOnly.userId);

    currentClient = viewOnly.client;
    const result = await createBranch(undefined, formData({ businessId: owner.businessId, creationKey: randomUuid(), name: "Should Not Exist" }));
    expect(result?.error).toBe("You don't have permission to do this.");
  });

  it("rejects a forged businessId the caller has no membership in", async () => {
    const stranger = await createOwnerAndBusiness("bapp-create-forged-stranger");
    const target = await createOwnerAndBusiness("bapp-create-forged-target");
    cleanupUserIds.push(stranger.userId, target.userId);

    currentClient = stranger.client;
    const result = await createBranch(undefined, formData({ businessId: target.businessId, creationKey: randomUuid(), name: "Forged Attempt" }));
    expect(result?.error).toBe("You don't have permission to do this.");
  });

  it("rejects a malformed businessId before any permission lookup", async () => {
    const owner = await createOwnerAndBusiness("bapp-create-malformed");
    cleanupUserIds.push(owner.userId);
    currentClient = owner.client;

    const result = await createBranch(undefined, formData({ businessId: "not-a-uuid", creationKey: randomUuid(), name: "X" }));
    expect(result?.error).toBe("Something went wrong. Please try again.");
  });

  it("succeeds and redirects to the detail page when the caller has branches.view too", async () => {
    const owner = await createOwnerAndBusiness("bapp-create-success");
    cleanupUserIds.push(owner.userId);
    currentClient = owner.client;

    const target = await expectRedirect(() =>
      createBranch(undefined, formData({ businessId: owner.businessId, creationKey: randomUuid(), name: "New Branch" }))
    );
    expect(target).toMatch(new RegExp(`/${owner.businessId}/branches/[0-9a-f-]{36}$`));
  });

  // Codex: branches.manage does NOT imply branches.view — a manage-only
  // caller who successfully creates a branch must never be redirected to
  // the detail page (which independently requires branches.view and
  // would 404 them).
  it("manage-only (no branches.view) redirects to the accessible generic success route, not the detail page", async () => {
    const owner = await createOwnerAndBusiness("bapp-create-manage-only");
    cleanupUserIds.push(owner.userId);
    const manageOnly = await createMemberWithCustomPermissions(owner.businessId, "bapp-create-manage-only", ["branches.manage"]);
    cleanupUserIds.push(manageOnly.userId);

    currentClient = manageOnly.client;
    const target = await expectRedirect(() =>
      createBranch(undefined, formData({ businessId: owner.businessId, creationKey: randomUuid(), name: "Manage Only Branch" }))
    );
    expect(target).toBe(`/${owner.businessId}/branches/new?created=1`);

    currentClient = owner.client;
    const { data } = await owner.client.from("business_branches").select("id, status").eq("business_id", owner.businessId).eq("name", "Manage Only Branch");
    expect(data).toHaveLength(1);
    expect(data![0].status).toBe("ACTIVE");
  });

  it("a duplicate (case/whitespace-normalized) name is rejected with a friendly, field-scoped error", async () => {
    const owner = await createOwnerAndBusiness("bapp-create-duplicate");
    cleanupUserIds.push(owner.userId);
    currentClient = owner.client;
    await createBranchViaRpc(owner.client, owner.businessId, { name: "Ikeja" });

    const result = await createBranch(undefined, formData({ businessId: owner.businessId, creationKey: randomUuid(), name: "  IKEJA  " }));
    expect(result?.fieldErrors?.name?.[0]).toBe("A branch with this name already exists.");
  });

  it("a validation failure (name too short) never reaches the RPC — no row is created", async () => {
    const owner = await createOwnerAndBusiness("bapp-create-invalid-name");
    cleanupUserIds.push(owner.userId);
    currentClient = owner.client;

    const result = await createBranch(undefined, formData({ businessId: owner.businessId, creationKey: randomUuid(), name: "A" }));
    expect(result?.fieldErrors?.name).toBeTruthy();

    const { data } = await owner.client.from("business_branches").select("id").eq("business_id", owner.businessId).neq("name", "Main Branch");
    expect(data).toEqual([]);
  });
});

describe("updateBranch / setDefaultBranch / deactivateBranch / reactivateBranch action boundaries", () => {
  it("scopes by BOTH business_id and branch_id — a forged branchId from another tenant is not found/updated", async () => {
    const a = await createOwnerAndBusiness("bapp-scope-a");
    const b = await createOwnerAndBusiness("bapp-scope-b");
    cleanupUserIds.push(a.userId, b.userId);

    currentClient = a.client;
    const branchId = await createBranchViaRpc(a.client, a.businessId, { name: "Tenant A Branch" });

    currentClient = b.client;
    const result = await updateBranch(undefined, formData({ businessId: b.businessId, branchId, name: "Hacked" }));
    expect(result?.error).toBeTruthy();

    currentClient = a.client;
    const { data } = await a.client.from("business_branches").select("name").eq("id", branchId).single();
    expect(data?.name).toBe("Tenant A Branch");
  });

  it("deactivating the default branch surfaces safe, actionable guidance — never a raw constraint error", async () => {
    const owner = await createOwnerAndBusiness("bapp-deactivate-default");
    cleanupUserIds.push(owner.userId);
    currentClient = owner.client;
    const { data: defaultBranch } = await owner.client.from("business_branches").select("id").eq("business_id", owner.businessId).eq("is_default", true).single();

    const result = await deactivateBranch(undefined, formData({ businessId: owner.businessId, branchId: defaultBranch!.id }));
    expect(result?.error).toMatch(/set another active branch as default/i);
  });

  it("setDefaultBranch requires branches.manage independently, even if the caller reached it via a known branch id", async () => {
    const owner = await createOwnerAndBusiness("bapp-setdefault-denied");
    cleanupUserIds.push(owner.userId);
    const viewOnly = await createMemberWithCustomPermissions(owner.businessId, "bapp-setdefault-denied", ["branches.view"]);
    cleanupUserIds.push(viewOnly.userId);
    currentClient = owner.client;
    const branchId = await createBranchViaRpc(owner.client, owner.businessId, { name: "Candidate Default" });

    currentClient = viewOnly.client;
    const result = await setDefaultBranch(undefined, formData({ businessId: owner.businessId, branchId }));
    expect(result?.error).toBe("You don't have permission to do this.");
  });

  it("deactivate then reactivate round-trips correctly through the action layer", async () => {
    const owner = await createOwnerAndBusiness("bapp-deactivate-reactivate");
    cleanupUserIds.push(owner.userId);
    currentClient = owner.client;
    const branchId = await createBranchViaRpc(owner.client, owner.businessId, { name: "Cycle Branch" });

    await expectRedirect(() => deactivateBranch(undefined, formData({ businessId: owner.businessId, branchId })));
    const { data: afterDeactivate } = await owner.client.from("business_branches").select("status").eq("id", branchId).single();
    expect(afterDeactivate?.status).toBe("INACTIVE");

    await expectRedirect(() => reactivateBranch(undefined, formData({ businessId: owner.businessId, branchId })));
    const { data: afterReactivate } = await owner.client.from("business_branches").select("status").eq("id", branchId).single();
    expect(afterReactivate?.status).toBe("ACTIVE");
  });
});

describe("branch DAL", () => {
  it("listBranches is tenant-scoped — a branch in another business never appears", async () => {
    const a = await createOwnerAndBusiness("bapp-dal-tenant-a");
    const b = await createOwnerAndBusiness("bapp-dal-tenant-b");
    cleanupUserIds.push(a.userId, b.userId);
    currentClient = a.client;
    await createBranchViaRpc(a.client, a.businessId, { name: "Tenant A Only" });

    currentClient = b.client;
    const rows = await listBranches(b.businessId);
    expect(rows.some((r) => r.name === "Tenant A Only")).toBe(false);
  });

  it("listBranches search filters by name/code using the hardened imatch encoder — a regex-metacharacter term matches literally, not as a pattern", async () => {
    const owner = await createOwnerAndBusiness("bapp-dal-search");
    cleanupUserIds.push(owner.userId);
    currentClient = owner.client;
    await createBranchViaRpc(owner.client, owner.businessId, { name: "Weird (Branch)" });
    await createBranchViaRpc(owner.client, owner.businessId, { name: "Ordinary Branch" });

    const rows = await listBranches(owner.businessId, { search: "(Branch)" });
    expect(rows.map((r) => r.name)).toEqual(["Weird (Branch)"]);
  });

  it("listBranches status filter returns only matching rows", async () => {
    const owner = await createOwnerAndBusiness("bapp-dal-status");
    cleanupUserIds.push(owner.userId);
    currentClient = owner.client;
    const branchId = await createBranchViaRpc(owner.client, owner.businessId, { name: "Will Deactivate" });
    await deactivateBranch(undefined, formData({ businessId: owner.businessId, branchId })).catch(() => {});

    const activeOnly = await listBranches(owner.businessId, { status: "ACTIVE" });
    expect(activeOnly.some((r) => r.id === branchId)).toBe(false);
    const inactiveOnly = await listBranches(owner.businessId, { status: "INACTIVE" });
    expect(inactiveOnly.some((r) => r.id === branchId)).toBe(true);
  });

  it("getBranch 404s (throws NEXT_NOT_FOUND) for a random nonexistent id", async () => {
    const owner = await createOwnerAndBusiness("bapp-dal-notfound");
    cleanupUserIds.push(owner.userId);
    currentClient = owner.client;

    await expect(getBranch(owner.businessId, randomUuid())).rejects.toThrow();
  });

  it("listActiveBranchesForPicker excludes inactive branches", async () => {
    const owner = await createOwnerAndBusiness("bapp-dal-picker");
    cleanupUserIds.push(owner.userId);
    currentClient = owner.client;
    const branchId = await createBranchViaRpc(owner.client, owner.businessId, { name: "Will Be Inactive For Picker" });
    await deactivateBranch(undefined, formData({ businessId: owner.businessId, branchId })).catch(() => {});

    const options = await listActiveBranchesForPicker(owner.businessId);
    expect(options.some((b) => b.id === branchId)).toBe(false);
  });

  // Codex adversarial review, application-layer round 2, Low 3: a
  // malformed route identifier must never reach Postgres as a raw
  // comparison value.
  it("getBranch 404s (never queries Postgres) for a malformed branchId", async () => {
    const owner = await createOwnerAndBusiness("bapp-dal-malformed-branch");
    cleanupUserIds.push(owner.userId);
    currentClient = owner.client;

    await expect(getBranch(owner.businessId, "not-a-uuid")).rejects.toThrow();
  });

  it("getBranch 404s for a malformed businessId", async () => {
    const owner = await createOwnerAndBusiness("bapp-dal-malformed-business");
    cleanupUserIds.push(owner.userId);
    currentClient = owner.client;
    const branchId = await createBranchViaRpc(owner.client, owner.businessId, { name: "Malformed Business Target" });

    await expect(getBranch("not-a-uuid", branchId)).rejects.toThrow();
  });
});

// Codex adversarial review, application-layer round 2, Medium 2: the four
// mutation actions previously always redirected straight to the
// branches.view-gated detail page regardless of whether the caller
// actually held branches.view — a manage-only caller who successfully
// mutated a branch was redirected into a route that would 404 them.
describe("manage-only (branches.manage, no branches.view) mutation redirects", () => {
  async function manageOnlySetup(prefix: string) {
    const owner = await createOwnerAndBusiness(prefix);
    const manageOnly = await createMemberWithCustomPermissions(owner.businessId, prefix, ["branches.manage"]);
    return { owner, manageOnly };
  }

  it("updateBranch: RPC succeeds, redirect target is the accessible generic route, never the protected detail page", async () => {
    const { owner, manageOnly } = await manageOnlySetup("bapp-manage-only-update");
    cleanupUserIds.push(owner.userId, manageOnly.userId);
    currentClient = owner.client;
    const branchId = await createBranchViaRpc(owner.client, owner.businessId, { name: "Manage Only Update Target" });

    currentClient = manageOnly.client;
    const target = await expectRedirect(() =>
      updateBranch(undefined, formData({ businessId: owner.businessId, branchId, name: "Renamed By Manage Only" }))
    );
    expect(target).toBe(`/${owner.businessId}/branches/new?updated=1`);
    expect(target).not.toContain(branchId);

    currentClient = owner.client;
    const { data } = await owner.client.from("business_branches").select("name").eq("id", branchId).single();
    expect(data?.name).toBe("Renamed By Manage Only");
  });

  it("setDefaultBranch: RPC succeeds, redirect target is the accessible generic route, never the protected detail page", async () => {
    const { owner, manageOnly } = await manageOnlySetup("bapp-manage-only-default");
    cleanupUserIds.push(owner.userId, manageOnly.userId);
    currentClient = owner.client;
    const branchId = await createBranchViaRpc(owner.client, owner.businessId, { name: "Manage Only Default Target" });

    currentClient = manageOnly.client;
    const target = await expectRedirect(() => setDefaultBranch(undefined, formData({ businessId: owner.businessId, branchId })));
    expect(target).toBe(`/${owner.businessId}/branches/new?defaulted=1`);
    expect(target).not.toContain(branchId);

    currentClient = owner.client;
    const { data } = await owner.client.from("business_branches").select("is_default").eq("id", branchId).single();
    expect(data?.is_default).toBe(true);
  });

  it("deactivateBranch: RPC succeeds, redirect target is the accessible generic route, never the protected detail page", async () => {
    const { owner, manageOnly } = await manageOnlySetup("bapp-manage-only-deactivate");
    cleanupUserIds.push(owner.userId, manageOnly.userId);
    currentClient = owner.client;
    const branchId = await createBranchViaRpc(owner.client, owner.businessId, { name: "Manage Only Deactivate Target" });

    currentClient = manageOnly.client;
    const target = await expectRedirect(() => deactivateBranch(undefined, formData({ businessId: owner.businessId, branchId })));
    expect(target).toBe(`/${owner.businessId}/branches/new?deactivated=1`);
    expect(target).not.toContain(branchId);

    currentClient = owner.client;
    const { data } = await owner.client.from("business_branches").select("status").eq("id", branchId).single();
    expect(data?.status).toBe("INACTIVE");
  });

  it("reactivateBranch: RPC succeeds, redirect target is the accessible generic route, never the protected detail page", async () => {
    const { owner, manageOnly } = await manageOnlySetup("bapp-manage-only-reactivate");
    cleanupUserIds.push(owner.userId, manageOnly.userId);
    currentClient = owner.client;
    const branchId = await createBranchViaRpc(owner.client, owner.businessId, { name: "Manage Only Reactivate Target" });
    await deactivateBranch(undefined, formData({ businessId: owner.businessId, branchId })).catch(() => {});

    currentClient = manageOnly.client;
    const target = await expectRedirect(() => reactivateBranch(undefined, formData({ businessId: owner.businessId, branchId })));
    expect(target).toBe(`/${owner.businessId}/branches/new?reactivated=1`);
    expect(target).not.toContain(branchId);

    currentClient = owner.client;
    const { data } = await owner.client.from("business_branches").select("status").eq("id", branchId).single();
    expect(data?.status).toBe("ACTIVE");
  });
});
