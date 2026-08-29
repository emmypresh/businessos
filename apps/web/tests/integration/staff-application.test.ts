import { describe, expect, it, vi, afterEach } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";
import type { Database } from "@/lib/supabase/database.types";
import { createConfirmedTestUser, createUserClient, deleteTestUser } from "./helpers/admin-client";
import { createOwnerAndBusiness, createMemberWithCustomPermissions, randomUuid } from "./helpers/inventory";
import { inviteMember, acceptInvitation as acceptInvitationViaRpc, expireInvitation, getDefaultBranchId, randomEmail } from "./helpers/staff";

// Same hybrid technique as tests/integration/branch-application.test.ts /
// tests/integration/expense-action-auth.test.ts.
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

const {
  inviteStaff,
  revokeInvitation,
  changeMemberRole,
  replaceMemberBranches,
  suspendMember,
  reactivateMember,
  acceptInvitation,
} = await import("@/lib/staff/actions");
const { listStaffMembers, getStaffMember, listInvitations } = await import("@/lib/staff/dal");

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

function formData(fields: Record<string, string | string[]>): FormData {
  const fd = new FormData();
  for (const [k, v] of Object.entries(fields)) {
    if (Array.isArray(v)) for (const item of v) fd.append(k, item);
    else fd.set(k, v);
  }
  return fd;
}

let cleanupUserIds: string[] = [];
afterEach(async () => {
  for (const id of cleanupUserIds) await deleteTestUser(id);
  cleanupUserIds = [];
});

async function makeAcceptedMember(owner: { client: SupabaseClient<Database>; businessId: string }, prefix: string, role = "MANAGER") {
  const email = randomEmail(prefix);
  const user = await createConfirmedTestUser(email, "Password1234");
  const client = createUserClient();
  await client.auth.signInWithPassword({ email, password: "Password1234" });
  currentClient = owner.client;
  const invitationId = await inviteMember(owner.client, owner.businessId, email, role);
  currentClient = client;
  const businessId = await acceptInvitationViaRpc(client, invitationId);
  void businessId;
  const { data } = await owner.client.from("business_members").select("id").eq("business_id", owner.businessId).eq("user_id", user.id).single();
  return { userId: user.id, email, client, memberId: data!.id as string };
}

describe("inviteStaff action boundary", () => {
  it("rejects without mutating when staff.invite is absent", async () => {
    const owner = await createOwnerAndBusiness("sapp-invite-denied");
    cleanupUserIds.push(owner.userId);
    const viewOnly = await createMemberWithCustomPermissions(owner.businessId, "sapp-invite-denied", ["staff.view"]);
    cleanupUserIds.push(viewOnly.userId);
    currentClient = owner.client;
    const branchId = await getDefaultBranchId(owner.client, owner.businessId);

    currentClient = viewOnly.client;
    const result = await inviteStaff(
      undefined,
      formData({ businessId: owner.businessId, creationKey: randomUuid(), email: "x@example.test", role: "VIEWER", branchIds: [branchId], primaryBranchId: branchId })
    );
    expect(result?.error).toBe("You don't have permission to do this.");
  });

  it("rejects an invalid branch-assignment shape (no primary) before ever reaching the RPC", async () => {
    const owner = await createOwnerAndBusiness("sapp-invite-invalid-branches");
    cleanupUserIds.push(owner.userId);
    currentClient = owner.client;
    const branchId = await getDefaultBranchId(owner.client, owner.businessId);

    const result = await inviteStaff(
      undefined,
      formData({ businessId: owner.businessId, creationKey: randomUuid(), email: "x@example.test", role: "VIEWER", branchIds: [branchId] })
    );
    expect(result?.fieldErrors?.primaryBranchId).toBeTruthy();
  });

  it("succeeds and redirects to the invitations tab when the caller has staff.view too", async () => {
    const owner = await createOwnerAndBusiness("sapp-invite-success");
    cleanupUserIds.push(owner.userId);
    currentClient = owner.client;
    const branchId = await getDefaultBranchId(owner.client, owner.businessId);

    const target = await expectRedirect(() =>
      inviteStaff(undefined, formData({ businessId: owner.businessId, creationKey: randomUuid(), email: randomEmail("invited"), role: "VIEWER", branchIds: [branchId], primaryBranchId: branchId }))
    );
    expect(target).toBe(`/${owner.businessId}/staff?tab=invitations`);
  });

  // Codex: staff.invite does NOT imply staff.view — an invite-only caller
  // who successfully sends an invitation must never be redirected to the
  // staff page (which independently requires staff.view and would 404
  // them).
  it("invite-only (no staff.view) redirects to the independent /staff/invitations route, not the staff page", async () => {
    const owner = await createOwnerAndBusiness("sapp-invite-only");
    cleanupUserIds.push(owner.userId);
    const inviteOnly = await createMemberWithCustomPermissions(owner.businessId, "sapp-invite-only", ["staff.invite"]);
    cleanupUserIds.push(inviteOnly.userId);
    currentClient = owner.client;
    const branchId = await getDefaultBranchId(owner.client, owner.businessId);

    currentClient = inviteOnly.client;
    const email = randomEmail("invite-only-target");
    const target = await expectRedirect(() =>
      inviteStaff(undefined, formData({ businessId: owner.businessId, creationKey: randomUuid(), email, role: "VIEWER", branchIds: [branchId], primaryBranchId: branchId }))
    );
    // Codex adversarial review, application-layer round 2, Medium 1: the
    // independent, staff.invite-gated-only /staff/invitations route —
    // reachable and genuinely useful for this caller — not the old
    // generic-banner /staff/invite?invited=1.
    expect(target).toBe(`/${owner.businessId}/staff/invitations`);

    currentClient = owner.client;
    const { data } = await owner.client.from("business_invitations").select("id").eq("business_id", owner.businessId).eq("email", email);
    expect(data).toHaveLength(1);
  });

  it("ADMIN cannot invite as OWNER — the hierarchy error is mapped to a safe message", async () => {
    const owner = await createOwnerAndBusiness("sapp-invite-owner-denied");
    cleanupUserIds.push(owner.userId);
    const admin = await makeAcceptedMember(owner, "sapp-invite-owner-denied", "ADMIN");
    cleanupUserIds.push(admin.userId);
    currentClient = owner.client;
    const branchId = await getDefaultBranchId(owner.client, owner.businessId);

    currentClient = admin.client;
    const result = await inviteStaff(
      undefined,
      formData({ businessId: owner.businessId, creationKey: randomUuid(), email: randomEmail("blocked-owner"), role: "OWNER", branchIds: [branchId], primaryBranchId: branchId })
    );
    expect(result?.fieldErrors?.role?.[0]).toMatch(/owner/i);
  });
});

describe("revokeInvitation action boundary", () => {
  it("requires staff.invite independently", async () => {
    const owner = await createOwnerAndBusiness("sapp-revoke-denied");
    cleanupUserIds.push(owner.userId);
    currentClient = owner.client;
    const branchId = await getDefaultBranchId(owner.client, owner.businessId);
    const invId = await inviteMember(owner.client, owner.businessId, randomEmail("revoke-target"), "VIEWER", { branchIds: [branchId], primaryBranchId: branchId });

    const viewOnly = await createMemberWithCustomPermissions(owner.businessId, "sapp-revoke-denied", ["staff.view"]);
    cleanupUserIds.push(viewOnly.userId);
    currentClient = viewOnly.client;
    const result = await revokeInvitation(undefined, formData({ businessId: owner.businessId, invitationId: invId }));
    expect(result?.error).toBe("You don't have permission to do this.");
  });

  it("succeeds and the invitation is no longer usable", async () => {
    const owner = await createOwnerAndBusiness("sapp-revoke-success");
    cleanupUserIds.push(owner.userId);
    currentClient = owner.client;
    const branchId = await getDefaultBranchId(owner.client, owner.businessId);
    const invId = await inviteMember(owner.client, owner.businessId, randomEmail("revoke-me"), "VIEWER", { branchIds: [branchId], primaryBranchId: branchId });

    await expectRedirect(() => revokeInvitation(undefined, formData({ businessId: owner.businessId, invitationId: invId })));
    const { data } = await owner.client.from("business_invitations").select("status").eq("id", invId).single();
    expect(data?.status).toBe("REVOKED");
  });
});

describe("changeMemberRole / replaceMemberBranches / suspendMember / reactivateMember action boundaries", () => {
  it("requires staff.manage independently for each of the four mutations", async () => {
    const owner = await createOwnerAndBusiness("sapp-manage-denied");
    cleanupUserIds.push(owner.userId);
    const target = await makeAcceptedMember(owner, "sapp-manage-denied-target", "VIEWER");
    cleanupUserIds.push(target.userId);
    const viewOnly = await createMemberWithCustomPermissions(owner.businessId, "sapp-manage-denied", ["staff.view"]);
    cleanupUserIds.push(viewOnly.userId);
    currentClient = owner.client;
    const branchId = await getDefaultBranchId(owner.client, owner.businessId);

    currentClient = viewOnly.client;
    expect((await changeMemberRole(undefined, formData({ businessId: owner.businessId, memberId: target.memberId, role: "MANAGER" })))?.error).toBe(
      "You don't have permission to do this."
    );
    expect(
      (await replaceMemberBranches(undefined, formData({ businessId: owner.businessId, memberId: target.memberId, branchIds: [branchId], primaryBranchId: branchId })))?.error
    ).toBe("You don't have permission to do this.");
    expect((await suspendMember(undefined, formData({ businessId: owner.businessId, memberId: target.memberId })))?.error).toBe(
      "You don't have permission to do this."
    );
    expect((await reactivateMember(undefined, formData({ businessId: owner.businessId, memberId: target.memberId })))?.error).toBe(
      "You don't have permission to do this."
    );
  });

  // Codex adversarial review, application-layer round 2, Low 10.B: the
  // PREVIOUS title here claimed "each of the four mutations" but the body
  // only ever exercised three — changeMemberRole, replaceMemberBranches,
  // suspendMember. reactivate_member (member_management_rpcs.sql) has NO
  // CANNOT_MANAGE_SELF check at all, verified directly against that
  // migration's own function body — it doesn't need one: a caller must
  // be ACTIVE to pass the staff.manage permission check in the first
  // place, so a self-targeting reactivate attempt always finds its own
  // row already active and is naturally rejected by the ordinary
  // MEMBER_NOT_SUSPENDED precondition instead, with no privilege-
  // escalation gap either way. Split into two honestly-titled tests: the
  // three RPCs that genuinely implement CANNOT_MANAGE_SELF, and a
  // separate proof that reactivate's self-targeting case is closed by a
  // different, equally safe mechanism.
  it("CANNOT_MANAGE_SELF is mapped to a safe message for each of the THREE mutations that implement it (changeMemberRole, replaceMemberBranches, suspendMember)", async () => {
    const owner = await createOwnerAndBusiness("sapp-self-denied");
    cleanupUserIds.push(owner.userId);
    const admin = await makeAcceptedMember(owner, "sapp-self-denied", "ADMIN");
    cleanupUserIds.push(admin.userId);
    currentClient = owner.client;
    const branchId = await getDefaultBranchId(owner.client, owner.businessId);

    currentClient = admin.client;
    expect((await changeMemberRole(undefined, formData({ businessId: owner.businessId, memberId: admin.memberId, role: "VIEWER" })))?.error).toMatch(/own account/i);
    expect(
      (await replaceMemberBranches(undefined, formData({ businessId: owner.businessId, memberId: admin.memberId, branchIds: [branchId], primaryBranchId: branchId })))?.error
    ).toMatch(/own account/i);
    expect((await suspendMember(undefined, formData({ businessId: owner.businessId, memberId: admin.memberId })))?.error).toMatch(/own account/i);
  });

  it("reactivateMember has no CANNOT_MANAGE_SELF check by design — a self-targeting attempt is instead safely rejected because the caller (being active) is never actually suspended", async () => {
    const owner = await createOwnerAndBusiness("sapp-self-reactivate");
    cleanupUserIds.push(owner.userId);
    const admin = await makeAcceptedMember(owner, "sapp-self-reactivate", "ADMIN");
    cleanupUserIds.push(admin.userId);

    currentClient = admin.client;
    const result = await reactivateMember(undefined, formData({ businessId: owner.businessId, memberId: admin.memberId }));
    expect(result?.error).toMatch(/already active/i);
    expect(result?.error).not.toMatch(/own account/i);
  });

  it("CANNOT_MANAGE_OWNER is mapped to a safe message", async () => {
    const owner = await createOwnerAndBusiness("sapp-owner-denied");
    cleanupUserIds.push(owner.userId);
    const admin = await makeAcceptedMember(owner, "sapp-owner-denied", "ADMIN");
    cleanupUserIds.push(admin.userId);
    currentClient = owner.client;
    const { data: ownerMember } = await owner.client.from("business_members").select("id").eq("business_id", owner.businessId).eq("user_id", owner.userId).single();

    currentClient = admin.client;
    const result = await suspendMember(undefined, formData({ businessId: owner.businessId, memberId: ownerMember!.id }));
    expect(result?.error).toMatch(/owner/i);
  });

  it("replaceMemberBranches: an empty branch set is rejected client-side before reaching the RPC", async () => {
    const owner = await createOwnerAndBusiness("sapp-branches-empty");
    cleanupUserIds.push(owner.userId);
    const target = await makeAcceptedMember(owner, "sapp-branches-empty-target", "VIEWER");
    cleanupUserIds.push(target.userId);
    currentClient = owner.client;

    const result = await replaceMemberBranches(undefined, formData({ businessId: owner.businessId, memberId: target.memberId }));
    expect(result?.fieldErrors?.branchIds).toBeTruthy();
  });

  it("suspend then reactivate round-trips, preserving role and branch assignments", async () => {
    const owner = await createOwnerAndBusiness("sapp-suspend-reactivate");
    cleanupUserIds.push(owner.userId);
    const target = await makeAcceptedMember(owner, "sapp-suspend-reactivate-target", "MANAGER");
    cleanupUserIds.push(target.userId);
    currentClient = owner.client;
    const branchId = await getDefaultBranchId(owner.client, owner.businessId);
    await replaceMemberBranches(undefined, formData({ businessId: owner.businessId, memberId: target.memberId, branchIds: [branchId], primaryBranchId: branchId })).catch(() => {});

    await expectRedirect(() => suspendMember(undefined, formData({ businessId: owner.businessId, memberId: target.memberId })));
    const { data: suspended } = await owner.client.from("business_members").select("status, role_id").eq("id", target.memberId).single();
    expect(suspended?.status).toBe("suspended");

    await expectRedirect(() => reactivateMember(undefined, formData({ businessId: owner.businessId, memberId: target.memberId })));
    const { data: reactivated } = await owner.client.from("business_members").select("status, role_id").eq("id", target.memberId).single();
    expect(reactivated?.status).toBe("active");
    expect(reactivated?.role_id).toBe(suspended?.role_id);

    const { data: branches } = await owner.client.from("business_member_branches").select("branch_id").eq("member_id", target.memberId);
    expect(branches!.map((b) => b.branch_id)).toEqual([branchId]);
  });
});

describe("staff DAL", () => {
  it("listStaffMembers includes a member with ZERO branch assignments (the pre-Phase-1F owner row) — never silently dropped by the branch embed", async () => {
    const owner = await createOwnerAndBusiness("sapp-dal-zero-branches");
    cleanupUserIds.push(owner.userId);
    currentClient = owner.client;

    const rows = await listStaffMembers(owner.businessId);
    const ownerRow = rows.find((r) => r.user_id === owner.userId);
    expect(ownerRow).toBeTruthy();
    expect(ownerRow!.branches).toEqual([]);
    expect(ownerRow!.is_self).toBe(true);
  });

  it("listStaffMembers role filter matches only the resolved role", async () => {
    const owner = await createOwnerAndBusiness("sapp-dal-role-filter");
    cleanupUserIds.push(owner.userId);
    const manager = await makeAcceptedMember(owner, "sapp-dal-role-filter-mgr", "MANAGER");
    cleanupUserIds.push(manager.userId);
    currentClient = owner.client;

    const rows = await listStaffMembers(owner.businessId, { role: "MANAGER" });
    expect(rows.every((r) => r.role_name === "MANAGER")).toBe(true);
    expect(rows.some((r) => r.id === manager.memberId)).toBe(true);
  });

  it("listStaffMembers branchId filter excludes a member with zero assignments", async () => {
    const owner = await createOwnerAndBusiness("sapp-dal-branch-filter");
    cleanupUserIds.push(owner.userId);
    currentClient = owner.client;
    const branchId = await getDefaultBranchId(owner.client, owner.businessId);

    const rows = await listStaffMembers(owner.businessId, { branchId });
    // The owner's own pre-Phase-1F membership has zero assignments — it
    // must NOT appear when filtering by a specific branch.
    expect(rows.some((r) => r.user_id === owner.userId)).toBe(false);
  });

  it("getStaffMember 404s for a random nonexistent id", async () => {
    const owner = await createOwnerAndBusiness("sapp-dal-notfound");
    cleanupUserIds.push(owner.userId);
    currentClient = owner.client;
    await expect(getStaffMember(owner.businessId, randomUuid())).rejects.toThrow();
  });

  // Codex adversarial review, application-layer round 2, Low 3: a
  // malformed route identifier (e.g. /staff/not-a-uuid) must never reach
  // Postgres as a raw comparison value.
  it("getStaffMember 404s (never queries Postgres) for a malformed memberId", async () => {
    const owner = await createOwnerAndBusiness("sapp-dal-malformed-member");
    cleanupUserIds.push(owner.userId);
    currentClient = owner.client;
    await expect(getStaffMember(owner.businessId, "not-a-uuid")).rejects.toThrow();
  });

  it("getStaffMember 404s for a malformed businessId", async () => {
    const owner = await createOwnerAndBusiness("sapp-dal-malformed-business");
    cleanupUserIds.push(owner.userId);
    currentClient = owner.client;
    const { data: member } = await owner.client.from("business_members").select("id").eq("business_id", owner.businessId).single();
    await expect(getStaffMember("not-a-uuid", member!.id)).rejects.toThrow();
  });

  // Codex adversarial review, application-layer round 2, Low 6: unlike
  // expenses/branches, business_members' own RLS is broader than
  // staff.view (any active member can read SOME roster rows) — these DAL
  // functions now independently enforce staff.view themselves, per the
  // established "denied/empty" contract other .view-gated DAL functions
  // already follow.
  it("listStaffMembers returns empty (never throws, never leaks a row) for a caller without staff.view", async () => {
    const owner = await createOwnerAndBusiness("sapp-dal-staffview-denied-list");
    cleanupUserIds.push(owner.userId);
    const noStaffView = await createMemberWithCustomPermissions(owner.businessId, "sapp-dal-staffview-denied-list", ["branches.view"]);
    cleanupUserIds.push(noStaffView.userId);

    currentClient = noStaffView.client;
    const rows = await listStaffMembers(owner.businessId);
    expect(rows).toEqual([]);
  });

  it("getStaffMember 404s for a caller without staff.view, even targeting a real member", async () => {
    const owner = await createOwnerAndBusiness("sapp-dal-staffview-denied-detail");
    cleanupUserIds.push(owner.userId);
    const noStaffView = await createMemberWithCustomPermissions(owner.businessId, "sapp-dal-staffview-denied-detail", ["branches.view"]);
    cleanupUserIds.push(noStaffView.userId);
    currentClient = owner.client;
    const { data: ownerMember } = await owner.client.from("business_members").select("id").eq("business_id", owner.businessId).eq("user_id", owner.userId).single();

    currentClient = noStaffView.client;
    await expect(getStaffMember(owner.businessId, ownerMember!.id)).rejects.toThrow();
  });

  it("listInvitations returns only the requesting business's own invitations", async () => {
    const a = await createOwnerAndBusiness("sapp-dal-inv-tenant-a");
    const b = await createOwnerAndBusiness("sapp-dal-inv-tenant-b");
    cleanupUserIds.push(a.userId, b.userId);
    currentClient = a.client;
    const branchIdA = await getDefaultBranchId(a.client, a.businessId);
    await inviteMember(a.client, a.businessId, randomEmail("tenant-a-invite"), "VIEWER", { branchIds: [branchIdA], primaryBranchId: branchIdA });

    currentClient = b.client;
    const rows = await listInvitations(b.businessId);
    expect(rows).toEqual([]);
  });
});

describe("acceptInvitation action boundary — privacy contract", () => {
  it("a wrong-email caller and a nonexistent invitation id both fail with the SAME generic ActionState error", async () => {
    const owner = await createOwnerAndBusiness("sapp-accept-privacy");
    cleanupUserIds.push(owner.userId);
    currentClient = owner.client;
    const branchId = await getDefaultBranchId(owner.client, owner.businessId);
    const invId = await inviteMember(owner.client, owner.businessId, randomEmail("intended"), "VIEWER", { branchIds: [branchId], primaryBranchId: branchId });

    const wrongEmail = randomEmail("wrong-person");
    const wrongUser = await createConfirmedTestUser(wrongEmail, "Password1234");
    cleanupUserIds.push(wrongUser.id);
    const wrongClient = createUserClient();
    await wrongClient.auth.signInWithPassword({ email: wrongEmail, password: "Password1234" });

    currentClient = wrongClient;
    const wrongEmailResult = await acceptInvitation(undefined, formData({ invitationId: invId }));
    const nonexistentResult = await acceptInvitation(undefined, formData({ invitationId: randomUuid() }));
    expect(wrongEmailResult?.error).toBe(nonexistentResult?.error);
    expect(wrongEmailResult?.error).not.toMatch(/email/i);
  });

  // Codex adversarial review, application-layer round 2, Low 10.C: the
  // PREVIOUS version of this test only captured/compared role_id — it
  // claimed "role/branches are provably unchanged" without actually
  // proving the branches half at all, and never checked status either.
  // Now captures the FULL before/after state: status, role, the complete
  // branch assignment set (branch_id + is_primary for every row), so a
  // hypothetical bug that left role untouched but silently mutated
  // status or branch assignments would now be caught.
  it("already-a-member is rejected, and status/role/branch-set/primary are all provably unchanged", async () => {
    const owner = await createOwnerAndBusiness("sapp-accept-already-member");
    cleanupUserIds.push(owner.userId);
    const existing = await makeAcceptedMember(owner, "sapp-accept-already-member-target", "VIEWER");
    cleanupUserIds.push(existing.userId);
    currentClient = owner.client;
    const branchId = await getDefaultBranchId(owner.client, owner.businessId);
    const invId = await inviteMember(owner.client, owner.businessId, existing.email, "OWNER", { branchIds: [branchId], primaryBranchId: branchId });

    const { data: memberBefore } = await owner.client.from("business_members").select("status, role_id").eq("id", existing.memberId).single();
    const { data: branchesBefore } = await owner.client
      .from("business_member_branches")
      .select("branch_id, is_primary")
      .eq("member_id", existing.memberId)
      .order("branch_id");
    // Sanity: existing already has a real, non-empty assignment (via
    // makeAcceptedMember's own default-branch invite) — otherwise
    // "branches unchanged" below would be vacuously true.
    expect(branchesBefore!.length).toBeGreaterThan(0);

    currentClient = existing.client;
    const result = await acceptInvitation(undefined, formData({ invitationId: invId }));
    expect(result?.error).toMatch(/already a member/i);

    currentClient = owner.client;
    const { data: memberAfter } = await owner.client.from("business_members").select("status, role_id").eq("id", existing.memberId).single();
    expect(memberAfter).toEqual(memberBefore);
    const { data: branchesAfter } = await owner.client
      .from("business_member_branches")
      .select("branch_id, is_primary")
      .eq("member_id", existing.memberId)
      .order("branch_id");
    expect(branchesAfter).toEqual(branchesBefore);
  });

  it("a successful acceptance redirects to the newly joined business's root", async () => {
    const owner = await createOwnerAndBusiness("sapp-accept-success");
    cleanupUserIds.push(owner.userId);
    currentClient = owner.client;
    const branchId = await getDefaultBranchId(owner.client, owner.businessId);
    const email = randomEmail("accept-success");
    const invId = await inviteMember(owner.client, owner.businessId, email, "VIEWER", { branchIds: [branchId], primaryBranchId: branchId });

    const invitee = await createConfirmedTestUser(email, "Password1234");
    cleanupUserIds.push(invitee.id);
    const inviteeClient = createUserClient();
    await inviteeClient.auth.signInWithPassword({ email, password: "Password1234" });

    currentClient = inviteeClient;
    const target = await expectRedirect(() => acceptInvitation(undefined, formData({ invitationId: invId })));
    expect(target).toBe(`/${owner.businessId}`);
  });

  it("an expired invitation is rejected with a safe message, once identity is established", async () => {
    const owner = await createOwnerAndBusiness("sapp-accept-expired");
    cleanupUserIds.push(owner.userId);
    currentClient = owner.client;
    const branchId = await getDefaultBranchId(owner.client, owner.businessId);
    const email = randomEmail("accept-expired");
    const invId = await inviteMember(owner.client, owner.businessId, email, "VIEWER", { branchIds: [branchId], primaryBranchId: branchId });
    await expireInvitation(invId);

    const invitee = await createConfirmedTestUser(email, "Password1234");
    cleanupUserIds.push(invitee.id);
    const inviteeClient = createUserClient();
    await inviteeClient.auth.signInWithPassword({ email, password: "Password1234" });

    currentClient = inviteeClient;
    const result = await acceptInvitation(undefined, formData({ invitationId: invId }));
    expect(result?.error).toMatch(/expired/i);
  });
});
