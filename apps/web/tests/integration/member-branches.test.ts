import { describe, expect, it, afterEach } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";
import type { Database } from "@/lib/supabase/database.types";
import { createConfirmedTestUser, createUserClient, deleteTestUser } from "./helpers/admin-client";
import { createOwnerAndBusiness, randomUuid } from "./helpers/inventory";
import { createTestDbClient } from "./helpers/db-client";
import { createBranch, getDefaultBranchId, inviteMember, acceptInvitation, randomEmail } from "./helpers/staff";

let cleanupUserIds: string[] = [];
afterEach(async () => {
  for (const id of cleanupUserIds) await deleteTestUser(id);
  cleanupUserIds = [];
});

async function makeAcceptedMember(
  owner: { client: SupabaseClient<Database>; businessId: string },
  prefix: string,
  role = "MANAGER"
) {
  const email = randomEmail(prefix);
  const user = await createConfirmedTestUser(email, "Password1234");
  const client = createUserClient();
  await client.auth.signInWithPassword({ email, password: "Password1234" });
  const invitationId = await inviteMember(owner.client, owner.businessId, email, role);
  await acceptInvitation(client, invitationId);
  const { data } = await owner.client
    .from("business_members")
    .select("id")
    .eq("business_id", owner.businessId)
    .eq("user_id", user.id)
    .single();
  return { userId: user.id, email, client, memberId: data!.id as string };
}

describe("member branch assignment — same-tenant", () => {
  it("replace_member_branches assigns branches belonging to the same business", async () => {
    const owner = await createOwnerAndBusiness("mb-same-tenant");
    cleanupUserIds.push(owner.userId);
    const member = await makeAcceptedMember(owner, "mb-same-tenant");
    cleanupUserIds.push(member.userId);
    const branchId = await createBranch(owner.client, owner.businessId, { name: "Assign Me" });

    const { error } = await owner.client.rpc("replace_member_branches", {
      p_business_id: owner.businessId,
      p_member_id: member.memberId,
      p_branch_ids: [branchId],
      p_primary_branch_id: branchId,
    });
    expect(error).toBeNull();

    const { data } = await owner.client
      .from("business_member_branches")
      .select("branch_id, is_primary")
      .eq("member_id", member.memberId);
    expect(data).toHaveLength(1);
    expect(data![0].branch_id).toBe(branchId);
    expect(data![0].is_primary).toBe(true);
  });
});

describe("member branch assignment — cross-tenant rejection", () => {
  it("rejects a branch belonging to a DIFFERENT business (BRANCH_NOT_FOUND, non-disclosure)", async () => {
    const owner = await createOwnerAndBusiness("mb-cross-tenant-a");
    const foreign = await createOwnerAndBusiness("mb-cross-tenant-b");
    cleanupUserIds.push(owner.userId, foreign.userId);
    const member = await makeAcceptedMember(owner, "mb-cross-tenant");
    cleanupUserIds.push(member.userId);
    const foreignBranchId = await createBranch(foreign.client, foreign.businessId, { name: "Foreign Branch" });

    // The member was accepted with the business's own default branch
    // (inviteMember's default — see its own comment) — capture that
    // baseline so the assertion below proves the rejected call left it
    // completely untouched, rather than assuming a freshly-accepted
    // member starts with zero branches (it can't: acceptance itself now
    // requires at least one).
    const { data: before } = await owner.client.from("business_member_branches").select("branch_id").eq("member_id", member.memberId);

    const { error } = await owner.client.rpc("replace_member_branches", {
      p_business_id: owner.businessId,
      p_member_id: member.memberId,
      p_branch_ids: [foreignBranchId],
      p_primary_branch_id: foreignBranchId,
    });
    expect(error?.message).toContain("BRANCH_NOT_FOUND");

    const { data } = await owner.client.from("business_member_branches").select("branch_id").eq("member_id", member.memberId);
    expect(data).toEqual(before);
  });

  it("cross-tenant assignment is structurally unrepresentable even via a direct (privileged) insert — the composite FK rejects it", async () => {
    const owner = await createOwnerAndBusiness("mb-structural-a");
    const foreign = await createOwnerAndBusiness("mb-structural-b");
    cleanupUserIds.push(owner.userId, foreign.userId);
    const member = await makeAcceptedMember(owner, "mb-structural");
    cleanupUserIds.push(member.userId);
    const foreignBranchId = await createBranch(foreign.client, foreign.businessId, { name: "Foreign Branch 2" });

    const sql = createTestDbClient();
    try {
      await expect(
        sql`
          insert into public.business_member_branches (business_id, member_id, branch_id, assigned_by)
          values (${owner.businessId}, ${member.memberId}, ${foreignBranchId}, ${owner.userId})
        `
      ).rejects.toThrow();
    } finally {
      await sql.end();
    }
  });
});

describe("inactive branch rejection", () => {
  it("rejects assigning a branch that is INACTIVE (real, same-tenant, but not usable)", async () => {
    const owner = await createOwnerAndBusiness("mb-inactive-branch");
    cleanupUserIds.push(owner.userId);
    const member = await makeAcceptedMember(owner, "mb-inactive-branch");
    cleanupUserIds.push(member.userId);
    const branchId = await createBranch(owner.client, owner.businessId, { name: "Will Deactivate" });
    await owner.client.rpc("deactivate_business_branch", { p_business_id: owner.businessId, p_branch_id: branchId });

    const { error } = await owner.client.rpc("replace_member_branches", {
      p_business_id: owner.businessId,
      p_member_id: member.memberId,
      p_branch_ids: [branchId],
      p_primary_branch_id: branchId,
    });
    expect(error?.message).toContain("BRANCH_NOT_ACTIVE");
  });
});

describe("one primary branch per member", () => {
  it("the partial unique index rejects two primary rows for the same member", async () => {
    const owner = await createOwnerAndBusiness("mb-one-primary");
    cleanupUserIds.push(owner.userId);
    const member = await makeAcceptedMember(owner, "mb-one-primary");
    cleanupUserIds.push(member.userId);
    const branchA = await createBranch(owner.client, owner.businessId, { name: "Primary A" });
    const branchB = await createBranch(owner.client, owner.businessId, { name: "Primary B" });

    // Establish a known, single-row baseline (exactly one primary = branchA)
    // via the RPC first — a freshly-accepted member already carries a
    // primary row for the business's default branch (inviteMember's own
    // default), so this replaces that starting state rather than adding
    // to it, giving the direct-SQL probe below a clean single row to
    // attempt a SECOND primary against.
    await owner.client.rpc("replace_member_branches", {
      p_business_id: owner.businessId, p_member_id: member.memberId, p_branch_ids: [branchA], p_primary_branch_id: branchA,
    });

    const sql = createTestDbClient();
    try {
      await expect(
        sql`
          insert into public.business_member_branches (business_id, member_id, branch_id, is_primary, assigned_by)
          values (${owner.businessId}, ${member.memberId}, ${branchB}, true, ${owner.userId})
        `
      ).rejects.toThrow();
    } finally {
      await sql.end();
    }
  });

  it("replace_member_branches enforces exactly one primary among the assigned set via the RPC itself", async () => {
    const owner = await createOwnerAndBusiness("mb-one-primary-rpc");
    cleanupUserIds.push(owner.userId);
    const member = await makeAcceptedMember(owner, "mb-one-primary-rpc");
    cleanupUserIds.push(member.userId);
    const branchA = await createBranch(owner.client, owner.businessId, { name: "RPC Primary A" });
    const branchB = await createBranch(owner.client, owner.businessId, { name: "RPC Primary B" });

    await owner.client.rpc("replace_member_branches", {
      p_business_id: owner.businessId,
      p_member_id: member.memberId,
      p_branch_ids: [branchA, branchB],
      p_primary_branch_id: branchA,
    });

    const { data } = await owner.client
      .from("business_member_branches")
      .select("branch_id, is_primary")
      .eq("member_id", member.memberId);
    expect(data!.filter((r) => r.is_primary)).toHaveLength(1);
    expect(data!.find((r) => r.is_primary)?.branch_id).toBe(branchA);
  });

  it("primary_branch_id must be a member of the assigned set", async () => {
    const owner = await createOwnerAndBusiness("mb-primary-not-in-set");
    cleanupUserIds.push(owner.userId);
    const member = await makeAcceptedMember(owner, "mb-primary-not-in-set");
    cleanupUserIds.push(member.userId);
    const branchA = await createBranch(owner.client, owner.businessId, { name: "In Set" });
    const branchB = await createBranch(owner.client, owner.businessId, { name: "Not In Set" });

    const { error } = await owner.client.rpc("replace_member_branches", {
      p_business_id: owner.businessId,
      p_member_id: member.memberId,
      p_branch_ids: [branchA],
      p_primary_branch_id: branchB,
    });
    expect(error?.message).toContain("INVALID_BRANCH_ASSIGNMENT");
  });
});

describe("deterministic replacement", () => {
  it("calling replace_member_branches twice with the identical set produces the identical end state (no duplicates)", async () => {
    const owner = await createOwnerAndBusiness("mb-deterministic");
    cleanupUserIds.push(owner.userId);
    const member = await makeAcceptedMember(owner, "mb-deterministic");
    cleanupUserIds.push(member.userId);
    const branchId = await createBranch(owner.client, owner.businessId, { name: "Deterministic Branch" });

    await owner.client.rpc("replace_member_branches", {
      p_business_id: owner.businessId, p_member_id: member.memberId, p_branch_ids: [branchId], p_primary_branch_id: branchId,
    });
    await owner.client.rpc("replace_member_branches", {
      p_business_id: owner.businessId, p_member_id: member.memberId, p_branch_ids: [branchId], p_primary_branch_id: branchId,
    });

    const { data } = await owner.client.from("business_member_branches").select("id").eq("member_id", member.memberId);
    expect(data).toHaveLength(1);
  });

  it("replacing with a NEW set removes branches no longer included and adds the new ones", async () => {
    const owner = await createOwnerAndBusiness("mb-replace-new-set");
    cleanupUserIds.push(owner.userId);
    const member = await makeAcceptedMember(owner, "mb-replace-new-set");
    cleanupUserIds.push(member.userId);
    const branchA = await createBranch(owner.client, owner.businessId, { name: "Was Assigned" });
    const branchB = await createBranch(owner.client, owner.businessId, { name: "Now Assigned" });

    await owner.client.rpc("replace_member_branches", {
      p_business_id: owner.businessId, p_member_id: member.memberId, p_branch_ids: [branchA], p_primary_branch_id: branchA,
    });
    await owner.client.rpc("replace_member_branches", {
      p_business_id: owner.businessId, p_member_id: member.memberId, p_branch_ids: [branchB], p_primary_branch_id: branchB,
    });

    const { data } = await owner.client.from("business_member_branches").select("branch_id").eq("member_id", member.memberId);
    expect(data).toHaveLength(1);
    expect(data![0].branch_id).toBe(branchB);
  });

  // Codex adversarial review, Finding 3 (LOCKED INVARIANT): an ACTIVE
  // member must always retain at least one branch assignment with exactly
  // one primary among them — access can never be re-derived correctly for
  // a member with zero branches, so "replace with empty" is no longer a
  // valid mutation at all. This replaces the PRIOR (now-invalid) test
  // that asserted an empty replacement succeeded and cleared every row —
  // that behavior was the exact bug this invariant closes.
  it("replacing with an empty branch set is rejected — the invariant forbids a branch-less active member, so the prior (valid) assignment is left completely untouched", async () => {
    const owner = await createOwnerAndBusiness("mb-replace-empty-rejected");
    cleanupUserIds.push(owner.userId);
    const member = await makeAcceptedMember(owner, "mb-replace-empty-rejected");
    cleanupUserIds.push(member.userId);
    const branchId = await createBranch(owner.client, owner.businessId, { name: "Must Survive" });
    await owner.client.rpc("replace_member_branches", {
      p_business_id: owner.businessId, p_member_id: member.memberId, p_branch_ids: [branchId], p_primary_branch_id: branchId,
    });

    const { error } = await owner.client.rpc("replace_member_branches", {
      p_business_id: owner.businessId, p_member_id: member.memberId, p_branch_ids: [],
    });
    expect(error?.message).toContain("INVALID_BRANCH_ASSIGNMENT");

    // Rejected atomically — the pre-existing assignment is untouched, not
    // partially cleared.
    const { data } = await owner.client.from("business_member_branches").select("branch_id, is_primary").eq("member_id", member.memberId);
    expect(data).toHaveLength(1);
    expect(data![0].branch_id).toBe(branchId);
    expect(data![0].is_primary).toBe(true);
  });

  // Codex adversarial review, Finding 8A: exhaustive coverage of every way
  // the "exactly one primary among a non-empty set" invariant can be
  // violated, each asserting the SAME controlled error and NO partial
  // write — distinct from the "empty set" case above and the
  // "primary outside the set" case below.
  it("a non-empty branch set with NO primary specified (omitted parameter) is rejected", async () => {
    const owner = await createOwnerAndBusiness("mb-primary-omitted");
    cleanupUserIds.push(owner.userId);
    const member = await makeAcceptedMember(owner, "mb-primary-omitted");
    cleanupUserIds.push(member.userId);
    const branchId = await createBranch(owner.client, owner.businessId, { name: "Omitted Primary" });

    const { data: before } = await owner.client.from("business_member_branches").select("branch_id").eq("member_id", member.memberId);

    const { error } = await owner.client.rpc("replace_member_branches", {
      p_business_id: owner.businessId, p_member_id: member.memberId, p_branch_ids: [branchId],
    });
    expect(error?.message).toContain("INVALID_BRANCH_ASSIGNMENT");
    const { data } = await owner.client.from("business_member_branches").select("branch_id").eq("member_id", member.memberId);
    expect(data).toEqual(before);
  });

  it("a non-empty branch set with primary explicitly null is rejected", async () => {
    const owner = await createOwnerAndBusiness("mb-primary-explicit-null");
    cleanupUserIds.push(owner.userId);
    const member = await makeAcceptedMember(owner, "mb-primary-explicit-null");
    cleanupUserIds.push(member.userId);
    const branchId = await createBranch(owner.client, owner.businessId, { name: "Null Primary" });

    // The generated RPC type models the optional uuid parameter as
    // `string | undefined` (omission, not an explicit JSON null) — cast
    // to bypass that for this test, which exists specifically to prove
    // an explicit null is rejected exactly like omission is, not merely
    // that omission is.
    const { error } = await owner.client.rpc("replace_member_branches", {
      p_business_id: owner.businessId, p_member_id: member.memberId, p_branch_ids: [branchId], p_primary_branch_id: null,
    } as never);
    expect(error?.message).toContain("INVALID_BRANCH_ASSIGNMENT");
  });

  it("a valid call stores EXACTLY one primary row, never zero and never more than one", async () => {
    const owner = await createOwnerAndBusiness("mb-exactly-one-primary");
    cleanupUserIds.push(owner.userId);
    const member = await makeAcceptedMember(owner, "mb-exactly-one-primary");
    cleanupUserIds.push(member.userId);
    const branchA = await createBranch(owner.client, owner.businessId, { name: "Exactly One A" });
    const branchB = await createBranch(owner.client, owner.businessId, { name: "Exactly One B" });
    const branchC = await createBranch(owner.client, owner.businessId, { name: "Exactly One C" });

    const { error } = await owner.client.rpc("replace_member_branches", {
      p_business_id: owner.businessId,
      p_member_id: member.memberId,
      p_branch_ids: [branchA, branchB, branchC],
      p_primary_branch_id: branchC,
    });
    expect(error).toBeNull();

    const { data } = await owner.client.from("business_member_branches").select("branch_id, is_primary").eq("member_id", member.memberId);
    expect(data).toHaveLength(3);
    const primaries = data!.filter((r) => r.is_primary);
    expect(primaries).toHaveLength(1);
    expect(primaries[0].branch_id).toBe(branchC);
  });
});

describe("suspended member behavior", () => {
  it("suspending a member preserves their branch-assignment rows (historical visibility)", async () => {
    const owner = await createOwnerAndBusiness("mb-suspend-preserve");
    cleanupUserIds.push(owner.userId);
    const member = await makeAcceptedMember(owner, "mb-suspend-preserve");
    cleanupUserIds.push(member.userId);
    const branchId = await createBranch(owner.client, owner.businessId, { name: "Preserved Branch" });
    await owner.client.rpc("replace_member_branches", {
      p_business_id: owner.businessId, p_member_id: member.memberId, p_branch_ids: [branchId], p_primary_branch_id: branchId,
    });

    await owner.client.rpc("suspend_member", { p_business_id: owner.businessId, p_member_id: member.memberId });

    const { data } = await owner.client.from("business_member_branches").select("branch_id").eq("member_id", member.memberId);
    expect(data).toHaveLength(1);
    expect(data![0].branch_id).toBe(branchId);
  });

  it("a suspended member can still see their OWN branch assignment rows", async () => {
    const owner = await createOwnerAndBusiness("mb-suspend-self-view");
    cleanupUserIds.push(owner.userId);
    const member = await makeAcceptedMember(owner, "mb-suspend-self-view");
    cleanupUserIds.push(member.userId);
    const branchId = await createBranch(owner.client, owner.businessId, { name: "Self View Branch" });
    await owner.client.rpc("replace_member_branches", {
      p_business_id: owner.businessId, p_member_id: member.memberId, p_branch_ids: [branchId], p_primary_branch_id: branchId,
    });
    await owner.client.rpc("suspend_member", { p_business_id: owner.businessId, p_member_id: member.memberId });

    const { data, error } = await member.client
      .from("business_member_branches")
      .select("branch_id")
      .eq("member_id", member.memberId);
    expect(error).toBeNull();
    expect(data).toHaveLength(1);
  });

  it("a suspended member loses branch-access despite the row still existing", async () => {
    const owner = await createOwnerAndBusiness("mb-suspend-loses-access");
    cleanupUserIds.push(owner.userId);
    const member = await makeAcceptedMember(owner, "mb-suspend-loses-access");
    cleanupUserIds.push(member.userId);
    const branchId = await createBranch(owner.client, owner.businessId, { name: "Access Branch" });
    await owner.client.rpc("replace_member_branches", {
      p_business_id: owner.businessId, p_member_id: member.memberId, p_branch_ids: [branchId], p_primary_branch_id: branchId,
    });

    const { data: before } = await member.client.rpc("has_branch_access", {
      p_business_id: owner.businessId, p_branch_id: branchId,
    });
    expect(before).toBe(true);

    await owner.client.rpc("suspend_member", { p_business_id: owner.businessId, p_member_id: member.memberId });

    const { data: after } = await member.client.rpc("has_branch_access", {
      p_business_id: owner.businessId, p_branch_id: branchId,
    });
    expect(after).toBe(false);
  });
});

describe("branch-access helper (private.has_branch_access / public.has_branch_access)", () => {
  it("returns true for a real, active assignment", async () => {
    const owner = await createOwnerAndBusiness("mb-access-positive");
    cleanupUserIds.push(owner.userId);
    const member = await makeAcceptedMember(owner, "mb-access-positive");
    cleanupUserIds.push(member.userId);
    const branchId = await createBranch(owner.client, owner.businessId, { name: "Access Positive Branch" });
    await owner.client.rpc("replace_member_branches", {
      p_business_id: owner.businessId, p_member_id: member.memberId, p_branch_ids: [branchId], p_primary_branch_id: branchId,
    });

    const { data } = await member.client.rpc("has_branch_access", { p_business_id: owner.businessId, p_branch_id: branchId });
    expect(data).toBe(true);
  });

  // Codex adversarial review, Finding 1: has_branch_access must be
  // re-derived from CURRENT branch status, not just the existence of an
  // assignment row — a branch deactivated after assignment must
  // immediately revoke access, exactly like membership suspension does.
  it("returns false once the assigned branch itself is deactivated, despite the assignment row still existing", async () => {
    const owner = await createOwnerAndBusiness("mb-access-inactive-branch");
    cleanupUserIds.push(owner.userId);
    const member = await makeAcceptedMember(owner, "mb-access-inactive-branch");
    cleanupUserIds.push(member.userId);
    const branchId = await createBranch(owner.client, owner.businessId, { name: "Will Deactivate After Assign" });
    await owner.client.rpc("replace_member_branches", {
      p_business_id: owner.businessId, p_member_id: member.memberId, p_branch_ids: [branchId], p_primary_branch_id: branchId,
    });

    const { data: before } = await member.client.rpc("has_branch_access", { p_business_id: owner.businessId, p_branch_id: branchId });
    expect(before).toBe(true);

    await owner.client.rpc("deactivate_business_branch", { p_business_id: owner.businessId, p_branch_id: branchId });

    const { data: after } = await member.client.rpc("has_branch_access", { p_business_id: owner.businessId, p_branch_id: branchId });
    expect(after).toBe(false);

    // The assignment row itself is untouched — access is re-derived live,
    // never by mutating historical assignment rows.
    const { data: row } = await owner.client.from("business_member_branches").select("branch_id").eq("member_id", member.memberId);
    expect(row).toHaveLength(1);
    expect(row![0].branch_id).toBe(branchId);
  });

  it("returns false for a branch the member is not assigned to", async () => {
    const owner = await createOwnerAndBusiness("mb-access-negative");
    cleanupUserIds.push(owner.userId);
    const member = await makeAcceptedMember(owner, "mb-access-negative");
    cleanupUserIds.push(member.userId);
    const branchId = await createBranch(owner.client, owner.businessId, { name: "Unassigned Branch" });

    const { data } = await member.client.rpc("has_branch_access", { p_business_id: owner.businessId, p_branch_id: branchId });
    expect(data).toBe(false);
  });

  it("returns false for a forged/foreign business_id, even with a real branch_id from that foreign business", async () => {
    const owner = await createOwnerAndBusiness("mb-access-forged-a");
    const stranger = await createOwnerAndBusiness("mb-access-forged-b");
    cleanupUserIds.push(owner.userId, stranger.userId);
    const branchId = await getDefaultBranchId(owner.client, owner.businessId);

    const { data } = await stranger.client.rpc("has_branch_access", { p_business_id: owner.businessId, p_branch_id: branchId });
    expect(data).toBe(false);
  });

  it("returns false entirely for a random, nonexistent branch_id", async () => {
    const owner = await createOwnerAndBusiness("mb-access-random-branch");
    cleanupUserIds.push(owner.userId);

    const { data } = await owner.client.rpc("has_branch_access", { p_business_id: owner.businessId, p_branch_id: randomUuid() });
    expect(data).toBe(false);
  });
});

// Codex adversarial review, Finding 2 / Finding 8G: replace_member_branches
// was the one member-management RPC that did NOT already reject
// self-targeting, unlike change_member_role/suspend_member — an ADMIN (or
// even the OWNER) could reassign their OWN branch access, which is
// exactly the kind of self-privilege-management every other mutation in
// this family blocks. Covers both an ADMIN and the OWNER themselves,
// mirroring staff-hierarchy.test.ts's own self-targeting coverage for the
// other two RPCs.
describe("self-targeting blocked (replace_member_branches)", () => {
  it("an ADMIN cannot reassign their own branch access", async () => {
    const owner = await createOwnerAndBusiness("mb-self-target-admin");
    cleanupUserIds.push(owner.userId);
    const admin = await makeAcceptedMember(owner, "mb-self-target-admin", "ADMIN");
    cleanupUserIds.push(admin.userId);
    const branchId = await createBranch(owner.client, owner.businessId, { name: "Admin Self Target" });
    const { data: before } = await owner.client.from("business_member_branches").select("branch_id").eq("member_id", admin.memberId);

    const { error } = await admin.client.rpc("replace_member_branches", {
      p_business_id: owner.businessId,
      p_member_id: admin.memberId,
      p_branch_ids: [branchId],
      p_primary_branch_id: branchId,
    });
    expect(error?.message).toContain("CANNOT_MANAGE_SELF");

    const { data } = await owner.client.from("business_member_branches").select("branch_id").eq("member_id", admin.memberId);
    expect(data).toEqual(before);
  });

  // Codex adversarial review round 3, Finding D: the ORIGINAL version of
  // this test only proved the RPC call itself was rejected
  // (CANNOT_MANAGE_SELF) — it never proved the OWNER's branch-assignment
  // state was actually left unchanged, which is the real security
  // property (a rejected call that still silently mutated state would be
  // worse than no protection at all). Strengthened to the full
  // establish/capture/attempt/verify sequence: a known assignment set is
  // seeded first (via a privileged direct-SQL insert — there is no RPC
  // path to assign branches to the OWNER's OWN membership at all, since
  // that is exactly the restriction under test), the exact before-state
  // is captured, the self-targeting call is attempted and confirmed
  // rejected, and the after-state is asserted byte-for-byte equal to the
  // before-state.
  it("the OWNER cannot reassign their own branch access either, and a rejected attempt leaves their existing assignment completely unchanged", async () => {
    const owner = await createOwnerAndBusiness("mb-self-target-owner");
    cleanupUserIds.push(owner.userId);
    const knownBranch = await createBranch(owner.client, owner.businessId, { name: "Owner Known Assignment" });
    const attemptedBranch = await createBranch(owner.client, owner.businessId, { name: "Owner Self Target Attempt" });
    const { data: ownerMember } = await owner.client
      .from("business_members")
      .select("id")
      .eq("business_id", owner.businessId)
      .eq("user_id", owner.userId)
      .single();

    // 1) Establish a known assignment set — direct SQL, since no RPC can
    // ever write to the OWNER's own business_member_branches row. The
    // OWNER already has a real assignment to the business's default
    // branch (Phase 1G's ensure_member_branch_access.sql), so that row is
    // replaced wholesale here first — otherwise this INSERT would collide
    // with it on the "at most one primary per member" partial unique
    // index, since both would claim is_primary = true.
    const sql = createTestDbClient();
    try {
      await sql`delete from public.business_member_branches where member_id = ${ownerMember!.id}`;
      await sql`
        insert into public.business_member_branches (business_id, member_id, branch_id, is_primary, assigned_by)
        values (${owner.businessId}, ${ownerMember!.id}, ${knownBranch}, true, ${owner.userId})
      `;
    } finally {
      await sql.end();
    }

    // 2) Capture the before-state.
    const { data: before } = await owner.client
      .from("business_member_branches")
      .select("branch_id, is_primary")
      .eq("member_id", ownerMember!.id);
    expect(before).toHaveLength(1);
    expect(before![0].branch_id).toBe(knownBranch);

    // 3/4) Attempt the self-targeting call — expect exact CANNOT_MANAGE_SELF.
    const { error } = await owner.client.rpc("replace_member_branches", {
      p_business_id: owner.businessId,
      p_member_id: ownerMember!.id,
      p_branch_ids: [attemptedBranch],
      p_primary_branch_id: attemptedBranch,
    });
    expect(error?.message).toContain("CANNOT_MANAGE_SELF");

    // 5/6) The after-state is byte-for-byte identical to the before-state
    // — the rejected call mutated nothing at all.
    const { data: after } = await owner.client
      .from("business_member_branches")
      .select("branch_id, is_primary")
      .eq("member_id", ownerMember!.id);
    expect(after).toEqual(before);
  });
});
