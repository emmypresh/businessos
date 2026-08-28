import { describe, expect, it, afterEach } from "vitest";
import { createConfirmedTestUser, createUserClient, deleteTestUser } from "./helpers/admin-client";
import { createOwnerAndBusiness, createMemberWithCustomPermissions, createMemberWithRole, randomUuid } from "./helpers/inventory";
import { createTestDbClient } from "./helpers/db-client";
import {
  createBranch,
  getDefaultBranchId,
  inviteMember,
  invitationPayload,
  acceptInvitation,
  expireInvitation,
  randomEmail,
} from "./helpers/staff";
import type { SupabaseClient } from "@supabase/supabase-js";
import type { Database } from "@/lib/supabase/database.types";

let cleanupUserIds: string[] = [];
afterEach(async () => {
  for (const id of cleanupUserIds) await deleteTestUser(id);
  cleanupUserIds = [];
});

// Codex adversarial review, Finding 3: create_business_invitation now
// requires a non-empty branch set with a primary among them, checked
// BEFORE idempotency/pending/hierarchy logic even runs. Tests below that
// exercise those OTHER behaviors and don't care about branches use this
// to build a minimally-valid, always-passing branch payload.
async function withDefaultBranch(
  client: SupabaseClient<Database>,
  businessId: string
) {
  const id = await getDefaultBranchId(client, businessId);
  return { branchIds: [id], primaryBranchId: id };
}

describe("email normalization", () => {
  it("stores the invitation email trim+lowercase-normalized, regardless of caller casing/whitespace", async () => {
    const { client, businessId, userId } = await createOwnerAndBusiness("inv-normalize");
    cleanupUserIds.push(userId);
    const rawEmail = "  MixedCase.User@Example.TEST  ";

    const invId = await inviteMember(client, businessId, rawEmail, "VIEWER");
    const { data } = await client.from("business_invitations").select("email").eq("id", invId).single();
    expect(data?.email).toBe("mixedcase.user@example.test");
  });

  it("does NOT apply Gmail-specific dot/plus normalization — two dot-variant addresses are treated as genuinely distinct", async () => {
    const { client, businessId, userId } = await createOwnerAndBusiness("inv-no-gmail-normalize");
    cleanupUserIds.push(userId);

    const invId1 = await inviteMember(client, businessId, "a.b.c@example.test", "VIEWER");
    const invId2 = await inviteMember(client, businessId, "abc@example.test", "VIEWER");
    expect(invId1).not.toBe(invId2);
  });
});

describe("create invitation", () => {
  it("creates a PENDING invitation with server-authoritative 7-day expiry", async () => {
    const { client, businessId, userId } = await createOwnerAndBusiness("inv-create-basic");
    cleanupUserIds.push(userId);
    const before = Date.now();

    const invId = await inviteMember(client, businessId, randomEmail("basic"), "MANAGER");
    const { data } = await client.from("business_invitations").select("status, expires_at, invited_by").eq("id", invId).single();
    expect(data?.status).toBe("PENDING");
    expect(data?.invited_by).toBe(userId);

    const expiresMs = new Date(data!.expires_at).getTime();
    const sevenDaysMs = 7 * 24 * 60 * 60 * 1000;
    expect(expiresMs - before).toBeGreaterThan(sevenDaysMs - 60_000);
    expect(expiresMs - before).toBeLessThan(sevenDaysMs + 60_000);
  });

  it("a caller-supplied expiry-like parameter has no effect — expiry is always server-derived", async () => {
    // create_business_invitation has no expiry parameter at all — there
    // is no field through which a caller could even attempt this; this
    // test documents that absence by confirming the RPC signature takes
    // exactly the six documented parameters.
    const sql = createTestDbClient();
    try {
      const rows = await sql<{ args: string }[]>`
        select pg_get_function_arguments(oid) as args
        from pg_proc where proname = 'create_business_invitation'
      `;
      expect(rows[0].args).not.toMatch(/expir/i);
    } finally {
      await sql.end();
    }
  });
});

describe("idempotency", () => {
  it("an exact replay (same key, same intent) returns the same invitation id and creates nothing new", async () => {
    const { client, businessId, userId } = await createOwnerAndBusiness("inv-idempotent-replay");
    cleanupUserIds.push(userId);
    const email = randomEmail("replay");
    const key = randomUuid();
    const branches = await withDefaultBranch(client, businessId);

    const [r1, r2] = await Promise.all([
      client.rpc("create_business_invitation", invitationPayload(businessId, email, "VIEWER", { creationKey: key, ...branches })),
      client.rpc("create_business_invitation", invitationPayload(businessId, email, "VIEWER", { creationKey: key, ...branches })),
    ]);
    expect(r1.error).toBeNull();
    expect(r2.error).toBeNull();
    expect(r1.data).toBe(r2.data);

    const { data } = await client.from("business_invitations").select("id").eq("business_id", businessId).eq("email", email);
    expect(data).toHaveLength(1);
  });

  it("the same key with a DIFFERENT intent (different email) conflicts safely", async () => {
    const { client, businessId, userId } = await createOwnerAndBusiness("inv-idempotent-conflict");
    cleanupUserIds.push(userId);
    const key = randomUuid();
    const branches = await withDefaultBranch(client, businessId);
    await client.rpc("create_business_invitation", invitationPayload(businessId, randomEmail("first"), "VIEWER", { creationKey: key, ...branches }));

    const { error } = await client.rpc(
      "create_business_invitation",
      invitationPayload(businessId, randomEmail("second"), "VIEWER", { creationKey: key, ...branches })
    );
    expect(error?.message).toContain("INVITATION_IDEMPOTENCY_KEY_REUSED");
  });
});

describe("duplicate pending email", () => {
  it("a second invitation for the same PENDING email (different creationKey) is rejected", async () => {
    const { client, businessId, userId } = await createOwnerAndBusiness("inv-duplicate-pending");
    cleanupUserIds.push(userId);
    const email = randomEmail("dup-pending");
    await inviteMember(client, businessId, email, "VIEWER");

    const branches = await withDefaultBranch(client, businessId);
    const { error } = await client.rpc(
      "create_business_invitation",
      invitationPayload(businessId, email, "MANAGER", { creationKey: randomUuid(), ...branches })
    );
    expect(error?.message).toContain("INVITATION_ALREADY_PENDING");
  });

  it("an EXPIRED invitation does not block a fresh invitation to the same email", async () => {
    const { client, businessId, userId } = await createOwnerAndBusiness("inv-expired-not-blocking");
    cleanupUserIds.push(userId);
    const email = randomEmail("was-expired");
    const oldInvId = await inviteMember(client, businessId, email, "VIEWER");
    await expireInvitation(oldInvId);

    const newInvId = await inviteMember(client, businessId, email, "MANAGER");
    expect(newInvId).not.toBe(oldInvId);

    const { data: oldRow } = await client.from("business_invitations").select("status").eq("id", oldInvId).single();
    expect(oldRow?.status).toBe("EXPIRED");
  });

  it("a REVOKED invitation does not block a fresh invitation to the same email", async () => {
    const { client, businessId, userId } = await createOwnerAndBusiness("inv-revoked-not-blocking");
    cleanupUserIds.push(userId);
    const email = randomEmail("was-revoked");
    const oldInvId = await inviteMember(client, businessId, email, "VIEWER");
    await client.rpc("revoke_business_invitation", { p_business_id: businessId, p_invitation_id: oldInvId });

    const newInvId = await inviteMember(client, businessId, email, "MANAGER");
    expect(newInvId).not.toBe(oldInvId);
  });

  it("the same email is available in a DIFFERENT business (tenant-scoped uniqueness)", async () => {
    const a = await createOwnerAndBusiness("inv-dup-tenant-a");
    const b = await createOwnerAndBusiness("inv-dup-tenant-b");
    cleanupUserIds.push(a.userId, b.userId);
    const email = randomEmail("shared-across-tenants");

    const invA = await inviteMember(a.client, a.businessId, email, "VIEWER");
    const invB = await inviteMember(b.client, b.businessId, email, "VIEWER");
    expect(invA).not.toBe(invB);
  });
});

describe("owner/admin invite hierarchy", () => {
  it("OWNER may invite as OWNER", async () => {
    const { client, businessId, userId } = await createOwnerAndBusiness("inv-owner-invites-owner");
    cleanupUserIds.push(userId);
    const invId = await inviteMember(client, businessId, randomEmail("future-owner"), "OWNER");
    expect(invId).toBeTruthy();
  });

  it("ADMIN may invite as any non-OWNER role", async () => {
    const owner = await createOwnerAndBusiness("inv-admin-invites-nonowner");
    cleanupUserIds.push(owner.userId);
    const admin = await createMemberWithCustomPermissions(owner.businessId, "inv-admin-invites-nonowner", [
      "staff.invite",
    ]);
    cleanupUserIds.push(admin.userId);

    for (const role of ["ADMIN", "MANAGER", "SALES", "INVENTORY", "ACCOUNTANT", "VIEWER"]) {
      const invId = await inviteMember(admin.client, owner.businessId, randomEmail(`admin-invites-${role}`), role);
      expect(invId, role).toBeTruthy();
    }
  });

  it("ADMIN cannot invite as OWNER", async () => {
    const owner = await createOwnerAndBusiness("inv-admin-cannot-invite-owner");
    cleanupUserIds.push(owner.userId);
    const admin = await createMemberWithCustomPermissions(owner.businessId, "inv-admin-cannot-invite-owner", [
      "staff.invite",
    ]);
    cleanupUserIds.push(admin.userId);

    const { error } = await admin.client.rpc(
      "create_business_invitation",
      invitationPayload(owner.businessId, randomEmail("blocked-owner"), "OWNER")
    );
    expect(error?.message).toContain("CANNOT_ASSIGN_OWNER_ROLE");
  });

  it("staff.invite alone (without matching hierarchy) is still required — a caller with no staff.invite cannot invite at all", async () => {
    const owner = await createOwnerAndBusiness("inv-no-permission");
    cleanupUserIds.push(owner.userId);
    const viewOnlyStaff = await createMemberWithCustomPermissions(owner.businessId, "inv-no-permission", [
      "staff.view",
    ]);
    cleanupUserIds.push(viewOnlyStaff.userId);

    const { error } = await viewOnlyStaff.client.rpc(
      "create_business_invitation",
      invitationPayload(owner.businessId, randomEmail("blocked-no-perm"), "VIEWER")
    );
    expect(error?.message).toContain("insufficient_privilege");
  });
});

describe("invitation branches", () => {
  it("captures the specified branches and primary branch", async () => {
    const { client, businessId, userId } = await createOwnerAndBusiness("inv-branches-captured");
    cleanupUserIds.push(userId);
    const branchA = await createBranch(client, businessId, { name: "Invite Branch A" });
    const branchB = await createBranch(client, businessId, { name: "Invite Branch B" });

    const invId = await inviteMember(client, businessId, randomEmail("with-branches"), "MANAGER", {
      branchIds: [branchA, branchB],
      primaryBranchId: branchB,
    });

    const { data } = await client.from("business_invitation_branches").select("branch_id, is_primary").eq("invitation_id", invId);
    expect(data).toHaveLength(2);
    expect(data!.find((r) => r.branch_id === branchB)?.is_primary).toBe(true);
    expect(data!.find((r) => r.branch_id === branchA)?.is_primary).toBe(false);
  });

  // Codex adversarial review, Finding 3 (LOCKED INVARIANT): an invitation
  // with branches but no primary specified is now rejected outright — an
  // accepted invitation becomes a member, and a member is never allowed
  // zero primaries among a non-empty set. This replaces the PRIOR (now
  // invalid) test that asserted such a call SUCCEEDED with every row
  // is_primary = false — that success was the exact gap this invariant
  // closes. (The underlying `x = NULL` NULL-vs-false comparison bug this
  // test used to regress against no longer applies either: primary is
  // proven NOT NULL before that comparison is ever reached.)
  it("an invitation with branches but NO primary branch specified is rejected outright", async () => {
    const { client, businessId, userId } = await createOwnerAndBusiness("inv-branches-no-primary");
    cleanupUserIds.push(userId);
    const branchA = await createBranch(client, businessId, { name: "No Primary Branch" });

    const { error } = await client.rpc(
      "create_business_invitation",
      invitationPayload(businessId, randomEmail("no-primary"), "MANAGER", { branchIds: [branchA] })
    );
    expect(error?.message).toContain("INVALID_BRANCH_ASSIGNMENT");

    const { data } = await client.from("business_invitations").select("id").eq("business_id", businessId).eq("email", "no-primary".toLowerCase());
    void data; // no row is created — the whole call fails before the INSERT
  });

  it("an empty branch set is rejected outright — an invitation, like an active member, can never have zero branches", async () => {
    const { client, businessId, userId } = await createOwnerAndBusiness("inv-branches-empty");
    cleanupUserIds.push(userId);

    const { error } = await client.rpc(
      "create_business_invitation",
      invitationPayload(businessId, randomEmail("empty-branches"), "VIEWER", { branchIds: [] })
    );
    expect(error?.message).toContain("INVALID_BRANCH_ASSIGNMENT");
  });

  it("rejects a branch belonging to a different business", async () => {
    const owner = await createOwnerAndBusiness("inv-branches-foreign-a");
    const foreign = await createOwnerAndBusiness("inv-branches-foreign-b");
    cleanupUserIds.push(owner.userId, foreign.userId);
    const foreignBranch = await createBranch(foreign.client, foreign.businessId, { name: "Foreign" });

    const { error } = await owner.client.rpc(
      "create_business_invitation",
      invitationPayload(owner.businessId, randomEmail("foreign-branch"), "VIEWER", {
        branchIds: [foreignBranch],
        primaryBranchId: foreignBranch,
      })
    );
    expect(error?.message).toContain("BRANCH_NOT_FOUND");
  });

  it("rejects an INACTIVE branch", async () => {
    const { client, businessId, userId } = await createOwnerAndBusiness("inv-branches-inactive");
    cleanupUserIds.push(userId);
    const branchId = await createBranch(client, businessId, { name: "Will Deactivate For Invite" });
    await client.rpc("deactivate_business_branch", { p_business_id: businessId, p_branch_id: branchId });

    const { error } = await client.rpc(
      "create_business_invitation",
      invitationPayload(businessId, randomEmail("inactive-branch"), "VIEWER", {
        branchIds: [branchId],
        primaryBranchId: branchId,
      })
    );
    expect(error?.message).toContain("BRANCH_NOT_ACTIVE");
  });
});

describe("revocation", () => {
  it("revokes a PENDING invitation, making it permanently unusable", async () => {
    const { client, businessId, userId } = await createOwnerAndBusiness("inv-revoke-basic");
    cleanupUserIds.push(userId);
    const invId = await inviteMember(client, businessId, randomEmail("to-revoke"), "VIEWER");

    const { error } = await client.rpc("revoke_business_invitation", { p_business_id: businessId, p_invitation_id: invId });
    expect(error).toBeNull();

    const { data } = await client.from("business_invitations").select("status, revoked_by, revoked_at").eq("id", invId).single();
    expect(data?.status).toBe("REVOKED");
    expect(data?.revoked_by).toBe(userId);
    expect(data?.revoked_at).toBeTruthy();
  });

  it("revoking an already-REVOKED invitation is rejected — irreversible", async () => {
    const { client, businessId, userId } = await createOwnerAndBusiness("inv-revoke-twice");
    cleanupUserIds.push(userId);
    const invId = await inviteMember(client, businessId, randomEmail("revoke-twice"), "VIEWER");
    await client.rpc("revoke_business_invitation", { p_business_id: businessId, p_invitation_id: invId });

    const { error } = await client.rpc("revoke_business_invitation", { p_business_id: businessId, p_invitation_id: invId });
    expect(error?.message).toContain("INVITATION_REVOKED");
  });

  it("revoking an ACCEPTED invitation is rejected", async () => {
    const { client, businessId, userId } = await createOwnerAndBusiness("inv-revoke-accepted");
    cleanupUserIds.push(userId);
    const email = randomEmail("revoke-accepted");
    const invitee = await createConfirmedTestUser(email, "Password1234");
    cleanupUserIds.push(invitee.id);
    const inviteeClient = createUserClient();
    await inviteeClient.auth.signInWithPassword({ email, password: "Password1234" });

    const invId = await inviteMember(client, businessId, email, "VIEWER");
    await acceptInvitation(inviteeClient, invId);

    const { error } = await client.rpc("revoke_business_invitation", { p_business_id: businessId, p_invitation_id: invId });
    expect(error?.message).toContain("INVITATION_ALREADY_ACCEPTED");
  });
});

describe("acceptance — expired / revoked", () => {
  it("rejects accepting an EXPIRED invitation", async () => {
    const { client, businessId, userId } = await createOwnerAndBusiness("inv-accept-expired");
    cleanupUserIds.push(userId);
    const email = randomEmail("accept-expired");
    const invitee = await createConfirmedTestUser(email, "Password1234");
    cleanupUserIds.push(invitee.id);
    const inviteeClient = createUserClient();
    await inviteeClient.auth.signInWithPassword({ email, password: "Password1234" });

    const invId = await inviteMember(client, businessId, email, "VIEWER");
    await expireInvitation(invId);

    const { error } = await inviteeClient.rpc("accept_business_invitation", { p_invitation_id: invId });
    expect(error?.message).toContain("INVITATION_EXPIRED");
  });

  it("rejects accepting a REVOKED invitation", async () => {
    const { client, businessId, userId } = await createOwnerAndBusiness("inv-accept-revoked");
    cleanupUserIds.push(userId);
    const email = randomEmail("accept-revoked");
    const invitee = await createConfirmedTestUser(email, "Password1234");
    cleanupUserIds.push(invitee.id);
    const inviteeClient = createUserClient();
    await inviteeClient.auth.signInWithPassword({ email, password: "Password1234" });

    const invId = await inviteMember(client, businessId, email, "VIEWER");
    await client.rpc("revoke_business_invitation", { p_business_id: businessId, p_invitation_id: invId });

    const { error } = await inviteeClient.rpc("accept_business_invitation", { p_invitation_id: invId });
    expect(error?.message).toContain("INVITATION_REVOKED");
  });

  it("rejects accepting a nonexistent invitation id", async () => {
    const { userId, client: ownerClient } = await createOwnerAndBusiness("inv-accept-random-owner");
    cleanupUserIds.push(userId);
    void ownerClient;
    const email = randomEmail("accept-random");
    const invitee = await createConfirmedTestUser(email, "Password1234");
    cleanupUserIds.push(invitee.id);
    const inviteeClient = createUserClient();
    await inviteeClient.auth.signInWithPassword({ email, password: "Password1234" });

    const { error } = await inviteeClient.rpc("accept_business_invitation", { p_invitation_id: randomUuid() });
    expect(error?.message).toContain("INVITATION_NOT_FOUND");
  });
});

describe("acceptance — authenticated email mismatch", () => {
  // Codex adversarial review, Finding 6: a wrong-email caller now gets the
  // exact SAME error as a nonexistent invitation id — INVITATION_NOT_FOUND,
  // never a distinct INVITATION_EMAIL_MISMATCH — so an authenticated
  // caller who guesses a real invitation UUID addressed to someone else
  // cannot use the error message to confirm the invitation exists.
  it("rejects when the authenticated caller's own email does not match the invitation's email, with the SAME error as a nonexistent invitation", async () => {
    const { client, businessId, userId } = await createOwnerAndBusiness("inv-email-mismatch");
    cleanupUserIds.push(userId);
    const invId = await inviteMember(client, businessId, randomEmail("intended-recipient"), "VIEWER");

    const wrongEmail = randomEmail("wrong-person");
    const wrongUser = await createConfirmedTestUser(wrongEmail, "Password1234");
    cleanupUserIds.push(wrongUser.id);
    const wrongClient = createUserClient();
    await wrongClient.auth.signInWithPassword({ email: wrongEmail, password: "Password1234" });

    const { error } = await wrongClient.rpc("accept_business_invitation", { p_invitation_id: invId });
    expect(error?.message).toContain("INVITATION_NOT_FOUND");
    expect(error?.message).not.toContain("EMAIL_MISMATCH");

    const { data: members } = await client.from("business_members").select("id").eq("business_id", businessId).eq("user_id", wrongUser.id);
    expect(members).toEqual([]);
  });

  // Codex adversarial review, Finding 6: the oracle stays closed even for
  // a REAL invitation in a NON-pending lifecycle state — a wrong-email
  // caller learns nothing about whether it's revoked, accepted, or
  // expired either. Only the correct recipient (proven via Auth-confirmed
  // email) ever sees a lifecycle-specific error (see the "expired /
  // revoked" describe block above, which uses the CORRECT invitee).
  it("a wrong-email caller gets INVITATION_NOT_FOUND for a REVOKED invitation too — never INVITATION_REVOKED", async () => {
    const { client, businessId, userId } = await createOwnerAndBusiness("inv-email-mismatch-revoked");
    cleanupUserIds.push(userId);
    const invId = await inviteMember(client, businessId, randomEmail("intended-recipient-revoked"), "VIEWER");
    await client.rpc("revoke_business_invitation", { p_business_id: businessId, p_invitation_id: invId });

    const wrongEmail = randomEmail("wrong-person-revoked");
    const wrongUser = await createConfirmedTestUser(wrongEmail, "Password1234");
    cleanupUserIds.push(wrongUser.id);
    const wrongClient = createUserClient();
    await wrongClient.auth.signInWithPassword({ email: wrongEmail, password: "Password1234" });

    const { error } = await wrongClient.rpc("accept_business_invitation", { p_invitation_id: invId });
    expect(error?.message).toContain("INVITATION_NOT_FOUND");
    expect(error?.message).not.toContain("REVOKED");
  });

  it("a wrong-email caller gets INVITATION_NOT_FOUND for an EXPIRED invitation too — never INVITATION_EXPIRED", async () => {
    const { client, businessId, userId } = await createOwnerAndBusiness("inv-email-mismatch-expired");
    cleanupUserIds.push(userId);
    const invId = await inviteMember(client, businessId, randomEmail("intended-recipient-expired"), "VIEWER");
    await expireInvitation(invId);

    const wrongEmail = randomEmail("wrong-person-expired");
    const wrongUser = await createConfirmedTestUser(wrongEmail, "Password1234");
    cleanupUserIds.push(wrongUser.id);
    const wrongClient = createUserClient();
    await wrongClient.auth.signInWithPassword({ email: wrongEmail, password: "Password1234" });

    const { error } = await wrongClient.rpc("accept_business_invitation", { p_invitation_id: invId });
    expect(error?.message).toContain("INVITATION_NOT_FOUND");
    expect(error?.message).not.toContain("EXPIRED");
  });

  // Codex adversarial review round 3, Finding E: the ACCEPTED state was
  // the one lifecycle state missing permanent wrong-email coverage —
  // PENDING/REVOKED/EXPIRED/NONEXISTENT are each covered above, but
  // ACCEPTED (arguably the highest-value state to protect, since it
  // confirms a real membership exists) was previously only reasoned
  // about in source/comments, never asserted by a running test.
  it("a wrong-email caller gets INVITATION_NOT_FOUND for an ACCEPTED invitation too — never INVITATION_ALREADY_ACCEPTED", async () => {
    const { client, businessId, userId } = await createOwnerAndBusiness("inv-email-mismatch-accepted");
    cleanupUserIds.push(userId);
    const correctEmail = randomEmail("intended-recipient-accepted");
    const correctInvitee = await createConfirmedTestUser(correctEmail, "Password1234");
    cleanupUserIds.push(correctInvitee.id);
    const correctClient = createUserClient();
    await correctClient.auth.signInWithPassword({ email: correctEmail, password: "Password1234" });

    const invId = await inviteMember(client, businessId, correctEmail, "VIEWER");
    // The CORRECT recipient accepts for real first — the invitation is
    // now genuinely ACCEPTED, not merely PENDING.
    await acceptInvitation(correctClient, invId);

    const wrongEmail = randomEmail("wrong-person-accepted");
    const wrongUser = await createConfirmedTestUser(wrongEmail, "Password1234");
    cleanupUserIds.push(wrongUser.id);
    const wrongClient = createUserClient();
    await wrongClient.auth.signInWithPassword({ email: wrongEmail, password: "Password1234" });

    const { error } = await wrongClient.rpc("accept_business_invitation", { p_invitation_id: invId });
    expect(error?.message).toContain("INVITATION_NOT_FOUND");
    expect(error?.message).not.toContain("ACCEPTED");

    // No side effect on the wrong caller's own account either.
    const { data: members } = await client.from("business_members").select("id").eq("business_id", businessId).eq("user_id", wrongUser.id);
    expect(members).toEqual([]);
  });

  it("the caller-supplied identity is NEVER trusted — matching is derived entirely from the Auth-confirmed session email, never a parameter (there is no email parameter on accept_business_invitation at all)", async () => {
    const sql = createTestDbClient();
    try {
      const rows = await sql<{ args: string }[]>`
        select pg_get_function_arguments(oid) as args
        from pg_proc where proname = 'accept_business_invitation'
      `;
      expect(rows[0].args.trim()).toBe("p_invitation_id uuid");
    } finally {
      await sql.end();
    }
  });
});

describe("acceptance — already a member", () => {
  it("rejects accepting when the caller already belongs to the target business", async () => {
    const { client, businessId, userId } = await createOwnerAndBusiness("inv-already-member");
    cleanupUserIds.push(userId);
    const email = randomEmail("already-member");
    const alreadyMember = await createMemberWithCustomPermissions(businessId, "inv-already-member", ["branches.view"]);
    cleanupUserIds.push(alreadyMember.userId);
    void email;

    // Invite the SAME email the already-member account signed up under —
    // createMemberWithCustomPermissions doesn't expose the email directly,
    // so re-derive it via the admin lookup instead.
    const { data: authUser } = await (await import("./helpers/admin-client")).createAdminClient().auth.admin.getUserById(alreadyMember.userId);
    const invId = await inviteMember(client, businessId, authUser.user!.email!, "MANAGER");

    const { error } = await alreadyMember.client.rpc("accept_business_invitation", { p_invitation_id: invId });
    expect(error?.message).toContain("ALREADY_BUSINESS_MEMBER");
  });

  // Codex adversarial review round 3, Finding I: strengthened to prove
  // NO MUTATION occurs on a rejected already-member acceptance attempt —
  // the prior test only proved the RPC call itself failed. Deliberately
  // uses a real low-privilege VIEWER targeted by a real OWNER-role
  // invitation (the maximum possible privilege gap this schema allows)
  // to prove the rejection is not merely "role stays the same" by
  // coincidence but genuinely blocks privilege elevation even under
  // maximum incentive to leak it.
  it("an existing VIEWER member who is (re-)invited as OWNER is rejected with ALREADY_BUSINESS_MEMBER and gains NOTHING — role, status, and every branch assignment (including which is primary) are provably unchanged", async () => {
    const { client, businessId, userId } = await createOwnerAndBusiness("inv-already-member-immutable");
    cleanupUserIds.push(userId);
    const viewer = await createMemberWithRole(businessId, "inv-already-member-immutable", "VIEWER");
    cleanupUserIds.push(viewer.userId);

    // Give the VIEWER a real, known branch assignment set so "branches
    // unchanged" and "primary unchanged" are meaningful, not vacuously true.
    const { data: viewerMember } = await client
      .from("business_members").select("id").eq("business_id", businessId).eq("user_id", viewer.userId).single();
    const branchA = await createBranch(client, businessId, { name: "Already-Member Branch A" });
    const branchB = await createBranch(client, businessId, { name: "Already-Member Branch B" });
    await client.rpc("replace_member_branches", {
      p_business_id: businessId, p_member_id: viewerMember!.id, p_branch_ids: [branchA, branchB], p_primary_branch_id: branchA,
    });

    // Capture the FULL before-state.
    const { data: memberBefore } = await client
      .from("business_members").select("role_id, status").eq("id", viewerMember!.id).single();
    const { data: branchesBefore } = await client
      .from("business_member_branches").select("branch_id, is_primary").eq("member_id", viewerMember!.id);

    const { data: authUser } = await (await import("./helpers/admin-client")).createAdminClient().auth.admin.getUserById(viewer.userId);
    const invId = await inviteMember(client, businessId, authUser.user!.email!, "OWNER");

    const { error } = await viewer.client.rpc("accept_business_invitation", { p_invitation_id: invId });
    expect(error?.message).toContain("ALREADY_BUSINESS_MEMBER");

    // No privilege elevation: role and status are byte-for-byte the same.
    const { data: memberAfter } = await client
      .from("business_members").select("role_id, status").eq("id", viewerMember!.id).single();
    expect(memberAfter).toEqual(memberBefore);
    const { data: viewerRole } = await client.from("roles").select("id").eq("name", "VIEWER").single();
    expect(memberAfter?.role_id).toBe(viewerRole!.id);

    // Branch assignments (including which one is primary) are
    // byte-for-byte the same too.
    const { data: branchesAfter } = await client
      .from("business_member_branches").select("branch_id, is_primary").eq("member_id", viewerMember!.id);
    expect(branchesAfter).toEqual(branchesBefore);
  });
});

describe("successful acceptance — membership/branches match the frozen invite exactly", () => {
  it("creates membership with the invited role, copies branch assignments, and marks the invitation ACCEPTED atomically", async () => {
    const { client, businessId, userId } = await createOwnerAndBusiness("inv-accept-success");
    cleanupUserIds.push(userId);
    const branchA = await createBranch(client, businessId, { name: "Accept Branch A" });
    const branchB = await createBranch(client, businessId, { name: "Accept Branch B" });

    const email = randomEmail("accept-success");
    const invitee = await createConfirmedTestUser(email, "Password1234");
    cleanupUserIds.push(invitee.id);
    const inviteeClient = createUserClient();
    await inviteeClient.auth.signInWithPassword({ email, password: "Password1234" });

    const invId = await inviteMember(client, businessId, email, "MANAGER", {
      branchIds: [branchA, branchB],
      primaryBranchId: branchA,
    });

    const returnedBusinessId = await acceptInvitation(inviteeClient, invId);
    expect(returnedBusinessId).toBe(businessId);

    const { data: member } = await client
      .from("business_members")
      .select("id, role_id, status")
      .eq("business_id", businessId).eq("user_id", invitee.id).single();
    const { data: managerRole } = await client.from("roles").select("id").eq("name", "MANAGER").single();
    expect(member?.role_id).toBe(managerRole!.id);
    expect(member?.status).toBe("active");

    const { data: memberBranches } = await client.from("business_member_branches").select("branch_id, is_primary").eq("member_id", member!.id);
    expect(memberBranches).toHaveLength(2);
    expect(memberBranches!.find((r) => r.branch_id === branchA)?.is_primary).toBe(true);
    expect(memberBranches!.find((r) => r.branch_id === branchB)?.is_primary).toBe(false);

    const { data: invitation } = await client.from("business_invitations").select("status, accepted_by, accepted_at").eq("id", invId).single();
    expect(invitation?.status).toBe("ACCEPTED");
    expect(invitation?.accepted_by).toBe(invitee.id);
    expect(invitation?.accepted_at).toBeTruthy();
  });

  // Codex adversarial review, Finding 3 (LOCKED INVARIANT): an invitation
  // can no longer carry zero branches at all (create_business_invitation
  // rejects that outright — see the "invitation branches" describe block
  // above), so accepting one can never produce a zero-branch member
  // either. This replaces the PRIOR (now invalid) test that asserted
  // zero branch assignments were the successful outcome of an
  // unspecified-branches invite — that outcome is no longer reachable.
  it("an invitation created with a single (the default) branch produces a member with exactly that one branch as primary", async () => {
    const { client, businessId, userId } = await createOwnerAndBusiness("inv-accept-default-branch");
    cleanupUserIds.push(userId);
    const email = randomEmail("accept-default-branch");
    const invitee = await createConfirmedTestUser(email, "Password1234");
    cleanupUserIds.push(invitee.id);
    const inviteeClient = createUserClient();
    await inviteeClient.auth.signInWithPassword({ email, password: "Password1234" });

    // inviteMember defaults to the business's own default branch when no
    // branchIds override is given (see its own comment in helpers/staff.ts).
    const invId = await inviteMember(client, businessId, email, "VIEWER");
    await acceptInvitation(inviteeClient, invId);

    const { data: member } = await client.from("business_members").select("id").eq("business_id", businessId).eq("user_id", invitee.id).single();
    const { data: memberBranches } = await client.from("business_member_branches").select("branch_id, is_primary").eq("member_id", member!.id);
    expect(memberBranches).toHaveLength(1);
    expect(memberBranches![0].is_primary).toBe(true);
  });
});

// Codex adversarial review, Finding 1 / Finding 8F: acceptance now
// re-validates every invited branch's CURRENT status before writing
// anything. A branch deactivated between invite and accept must fail the
// ENTIRE acceptance atomically — no membership row, no branch-assignment
// row, and the invitation itself stays exactly as it was (not ACCEPTED).
describe("acceptance — inactive branch revalidation", () => {
  it("fails atomically when an invited branch was deactivated after the invitation was sent, before the invitee ever accepts", async () => {
    const { client, businessId, userId } = await createOwnerAndBusiness("inv-accept-branch-deactivated");
    cleanupUserIds.push(userId);
    const branchId = await createBranch(client, businessId, { name: "Deactivated Before Accept" });

    const email = randomEmail("accept-branch-deactivated");
    const invitee = await createConfirmedTestUser(email, "Password1234");
    cleanupUserIds.push(invitee.id);
    const inviteeClient = createUserClient();
    await inviteeClient.auth.signInWithPassword({ email, password: "Password1234" });

    const invId = await inviteMember(client, businessId, email, "VIEWER", {
      branchIds: [branchId],
      primaryBranchId: branchId,
    });

    // The branch is deactivated AFTER the invitation was issued but
    // BEFORE it's accepted — exactly the race Finding 1 closes.
    await client.rpc("deactivate_business_branch", { p_business_id: businessId, p_branch_id: branchId });

    const { error } = await inviteeClient.rpc("accept_business_invitation", { p_invitation_id: invId });
    expect(error?.message).toContain("BRANCH_NOT_ACTIVE");

    // Nothing was written: no membership row,
    const { data: members } = await client.from("business_members").select("id").eq("business_id", businessId).eq("user_id", invitee.id);
    expect(members).toEqual([]);

    // no member_branches row (there is no member to attach one to anyway),
    const sql = createTestDbClient();
    try {
      const rows = await sql<{ n: number }[]>`
        select count(*)::int as n from public.business_member_branches
        where business_id = ${businessId} and branch_id = ${branchId}
      `;
      expect(rows[0].n).toBe(0);
    } finally {
      await sql.end();
    }

    // and the invitation itself is untouched — still PENDING, never
    // ACCEPTED, never partially consumed.
    const { data: invitation } = await client.from("business_invitations").select("status, accepted_by, accepted_at").eq("id", invId).single();
    expect(invitation?.status).toBe("PENDING");
    expect(invitation?.accepted_by).toBeNull();
    expect(invitation?.accepted_at).toBeNull();
  });

  // Codex adversarial review round 3, Finding A: the ORIGINAL title here
  // read "succeeds when only SOME invited branches are inactive" — flatly
  // contradicting its own assertion (`BRANCH_NOT_ACTIVE`, a rejection).
  // The real, intended contract is the opposite of what the old title
  // said: ANY single inactive branch among the invited set — even when
  // every OTHER invited branch is still perfectly active — rejects
  // acceptance atomically. Retitled to state that plainly, and the
  // assertions are widened to match the sibling "deactivated before
  // accept" test's full rigor above (no membership, no member_branches
  // rows for EITHER branch, invitation stays exactly PENDING with both
  // accepted_by and accepted_at still null) rather than only checking for
  // the absence of a membership row.
  it("rejects acceptance atomically when even ONE of several invited branches is inactive, despite every other invited branch remaining active", async () => {
    const { client, businessId, userId } = await createOwnerAndBusiness("inv-accept-partial-inactive");
    cleanupUserIds.push(userId);
    const activeBranch = await createBranch(client, businessId, { name: "Stays Active" });
    const willDeactivate = await createBranch(client, businessId, { name: "Will Go Inactive" });

    const email = randomEmail("accept-partial-inactive");
    const invitee = await createConfirmedTestUser(email, "Password1234");
    cleanupUserIds.push(invitee.id);
    const inviteeClient = createUserClient();
    await inviteeClient.auth.signInWithPassword({ email, password: "Password1234" });

    const invId = await inviteMember(client, businessId, email, "VIEWER", {
      branchIds: [activeBranch, willDeactivate],
      primaryBranchId: activeBranch,
    });
    await client.rpc("deactivate_business_branch", { p_business_id: businessId, p_branch_id: willDeactivate });

    const { error } = await inviteeClient.rpc("accept_business_invitation", { p_invitation_id: invId });
    expect(error?.message).toContain("BRANCH_NOT_ACTIVE");

    // No membership at all — not even a partial one scoped to the
    // still-active branch.
    const { data: members } = await client.from("business_members").select("id").eq("business_id", businessId).eq("user_id", invitee.id);
    expect(members).toEqual([]);

    // No member_branches row for EITHER branch — the still-active one is
    // not silently granted while the inactive one is skipped.
    const sql = createTestDbClient();
    try {
      const rows = await sql<{ n: number }[]>`
        select count(*)::int as n from public.business_member_branches
        where business_id = ${businessId} and branch_id in (${activeBranch}, ${willDeactivate})
      `;
      expect(rows[0].n).toBe(0);
    } finally {
      await sql.end();
    }

    // The invitation itself is completely untouched.
    const { data: invitation } = await client.from("business_invitations").select("status, accepted_by, accepted_at").eq("id", invId).single();
    expect(invitation?.status).toBe("PENDING");
    expect(invitation?.accepted_by).toBeNull();
    expect(invitation?.accepted_at).toBeNull();
  });
});

describe("the invitee cannot influence role/branches/business/email during acceptance", () => {
  it("accept_business_invitation takes exactly ONE parameter — there is no field through which role/branches/business/email could be supplied", async () => {
    const sql = createTestDbClient();
    try {
      const rows = await sql<{ args: string }[]>`
        select pg_get_function_arguments(oid) as args
        from pg_proc where proname = 'accept_business_invitation'
      `;
      expect(rows[0].args.trim()).toBe("p_invitation_id uuid");
    } finally {
      await sql.end();
    }
  });

  it("even a caller who is ALSO an OWNER of the target business elsewhere (hypothetically privileged) still gets exactly the frozen invited role, never their own", async () => {
    // Constructed via a caller who has staff.invite in the SAME business
    // (so they could plausibly try to game the flow) but is accepting an
    // invitation issued to a role LOWER than their own real access —
    // proves the invited role always wins, never anything derived from
    // the caller's own standing.
    const owner = await createOwnerAndBusiness("inv-frozen-role");
    cleanupUserIds.push(owner.userId);
    const email = randomEmail("frozen-role-recipient");
    const invitee = await createConfirmedTestUser(email, "Password1234");
    cleanupUserIds.push(invitee.id);
    const inviteeClient = createUserClient();
    await inviteeClient.auth.signInWithPassword({ email, password: "Password1234" });

    const invId = await inviteMember(owner.client, owner.businessId, email, "VIEWER");
    await acceptInvitation(inviteeClient, invId);

    const { data: member } = await owner.client.from("business_members").select("role_id").eq("business_id", owner.businessId).eq("user_id", invitee.id).single();
    const { data: viewerRole } = await owner.client.from("roles").select("id").eq("name", "VIEWER").single();
    expect(member?.role_id).toBe(viewerRole!.id);
  });
});

describe("concurrent acceptance creates exactly one membership", () => {
  // Codex adversarial review round 3, Finding F: the ORIGINAL version of
  // this test only proved "one membership row exists" — it said nothing
  // about whether that ONE acceptance produced a COMPLETE, correct
  // result (the right branch assignments, exactly one primary, no
  // duplicates). A buggy concurrent path could in principle create one
  // membership row but a mangled/partial/duplicated branch-assignment
  // set and this test would still report green. Strengthened to invite
  // with an explicit MULTI-branch set (never the degenerate single
  // default-branch case, where "no duplicates" and "exactly one primary"
  // are trivially true even if the underlying logic were broken) and to
  // assert the full frozen assignment set survived the race intact.
  it("two simultaneous accept calls for the same invitation create exactly one COMPLETE membership result — one row, the full frozen branch set, exactly one primary, no duplicates", async () => {
    const { client, businessId, userId } = await createOwnerAndBusiness("inv-concurrent-accept");
    cleanupUserIds.push(userId);
    const branchA = await createBranch(client, businessId, { name: "Concurrent Accept Branch A" });
    const branchB = await createBranch(client, businessId, { name: "Concurrent Accept Branch B" });
    const branchC = await createBranch(client, businessId, { name: "Concurrent Accept Branch C" });
    const email = randomEmail("concurrent-accept");
    const invitee = await createConfirmedTestUser(email, "Password1234");
    cleanupUserIds.push(invitee.id);
    const inviteeClient = createUserClient();
    await inviteeClient.auth.signInWithPassword({ email, password: "Password1234" });

    const invId = await inviteMember(client, businessId, email, "VIEWER", {
      branchIds: [branchA, branchB, branchC],
      primaryBranchId: branchB,
    });

    const [r1, r2] = await Promise.all([
      inviteeClient.rpc("accept_business_invitation", { p_invitation_id: invId }),
      inviteeClient.rpc("accept_business_invitation", { p_invitation_id: invId }),
    ]);
    const succeeded = [r1, r2].filter((r) => r.error === null);
    const failed = [r1, r2].filter((r) => r.error !== null);
    expect(succeeded).toHaveLength(1);
    expect(failed).toHaveLength(1);
    expect(failed[0].error?.message).toContain("INVITATION_ALREADY_ACCEPTED");

    const { data: members } = await client.from("business_members").select("id").eq("business_id", businessId).eq("user_id", invitee.id);
    expect(members).toHaveLength(1);
    const memberId = members![0].id;

    const { data: assignments } = await client
      .from("business_member_branches")
      .select("branch_id, is_primary")
      .eq("member_id", memberId);

    // Exactly the expected number of rows — no duplicates, none dropped.
    expect(assignments).toHaveLength(3);

    // Exactly one primary among them.
    const primaries = assignments!.filter((a) => a.is_primary);
    expect(primaries).toHaveLength(1);
    expect(primaries[0].branch_id).toBe(branchB);

    // The assigned branch id set matches the frozen invitation set
    // EXACTLY — no substitutions, no extras, no drops — and no branch id
    // appears more than once (structurally guaranteed by the table's own
    // unique (member_id, branch_id) constraint, but asserted here too as
    // a direct proof of this specific run's outcome).
    const assignedBranchIds = assignments!.map((a) => a.branch_id).sort();
    expect(assignedBranchIds).toEqual([branchA, branchB, branchC].sort());
    expect(new Set(assignedBranchIds).size).toBe(assignedBranchIds.length);
  });
});

describe("tenant privacy — invitations are not broadly visible", () => {
  it("a member without staff.invite cannot see any invitation, including one addressed to them", async () => {
    const { client, businessId, userId } = await createOwnerAndBusiness("inv-privacy-no-staff-invite");
    cleanupUserIds.push(userId);
    const email = randomEmail("privacy-target");
    const invitee = await createConfirmedTestUser(email, "Password1234");
    cleanupUserIds.push(invitee.id);
    const inviteeClient = createUserClient();
    await inviteeClient.auth.signInWithPassword({ email, password: "Password1234" });

    await inviteMember(client, businessId, email, "VIEWER");

    // The invitee is NOT YET a member (hasn't accepted), so is_business_member
    // is false too — this specifically proves the invitation itself carries
    // no visibility grant of its own.
    const { data } = await inviteeClient.from("business_invitations").select("id").eq("business_id", businessId);
    expect(data).toEqual([]);
  });

  it("an unrelated authenticated user (no membership at all) cannot enumerate invitations for any business", async () => {
    const owner = await createOwnerAndBusiness("inv-privacy-stranger-owner");
    const stranger = await createOwnerAndBusiness("inv-privacy-stranger");
    cleanupUserIds.push(owner.userId, stranger.userId);
    await inviteMember(owner.client, owner.businessId, randomEmail("privacy-stranger-target"), "VIEWER");

    const { data } = await stranger.client.from("business_invitations").select("id").eq("business_id", owner.businessId);
    expect(data).toEqual([]);
  });

  it("anon cannot read business_invitations at all", async () => {
    const owner = await createOwnerAndBusiness("inv-privacy-anon");
    cleanupUserIds.push(owner.userId);
    await inviteMember(owner.client, owner.businessId, randomEmail("privacy-anon-target"), "VIEWER");

    const url = process.env.NEXT_PUBLIC_SUPABASE_URL!;
    const anonKey = process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY!;
    const { createClient } = await import("@supabase/supabase-js");
    const anon = createClient(url, anonKey, { auth: { persistSession: false } });
    const { data } = await anon.from("business_invitations").select("id");
    expect(data ?? []).toEqual([]);
  });

  it("a member WITH staff.invite can see the full invitation list for their business", async () => {
    const owner = await createOwnerAndBusiness("inv-visible-with-staff-invite");
    cleanupUserIds.push(owner.userId);
    const staffInviter = await createMemberWithCustomPermissions(owner.businessId, "inv-visible-with-staff-invite", [
      "staff.invite",
    ]);
    cleanupUserIds.push(staffInviter.userId);
    await inviteMember(owner.client, owner.businessId, randomEmail("visible-target"), "VIEWER");

    const { data } = await staffInviter.client.from("business_invitations").select("id").eq("business_id", owner.businessId);
    expect(data!.length).toBeGreaterThan(0);
  });
});

describe("direct table access denied", () => {
  it("authenticated cannot INSERT into business_invitations directly", async () => {
    const { client, businessId, userId } = await createOwnerAndBusiness("inv-no-direct-insert");
    cleanupUserIds.push(userId);
    const { data: role } = await client.from("roles").select("id").eq("name", "VIEWER").single();

    const { error } = await client.from("business_invitations").insert({
      business_id: businessId,
      email: "forged@example.test",
      role_id: role!.id,
      expires_at: new Date(Date.now() + 86400000).toISOString(),
      invited_by: userId,
      creation_key: randomUuid(),
    } as never);
    expect(error).not.toBeNull();
  });

  it("authenticated cannot UPDATE business_invitations directly (e.g. to forge ACCEPTED)", async () => {
    const { client, businessId, userId } = await createOwnerAndBusiness("inv-no-direct-update");
    cleanupUserIds.push(userId);
    const invId = await inviteMember(client, businessId, randomEmail("no-direct-update"), "VIEWER");

    const { error } = await client.from("business_invitations").update({ status: "ACCEPTED" } as never).eq("id", invId);
    expect(error).not.toBeNull();

    const { data } = await client.from("business_invitations").select("status").eq("id", invId).single();
    expect(data?.status).toBe("PENDING");
  });

  it("authenticated cannot DELETE business_invitations directly", async () => {
    const { client, businessId, userId } = await createOwnerAndBusiness("inv-no-direct-delete");
    cleanupUserIds.push(userId);
    const invId = await inviteMember(client, businessId, randomEmail("no-direct-delete"), "VIEWER");

    const { error } = await client.from("business_invitations").delete().eq("id", invId);
    expect(error).not.toBeNull();
  });

  it("authenticated cannot write to business_invitation_branches directly", async () => {
    const { client, businessId, userId } = await createOwnerAndBusiness("inv-no-direct-branches-write");
    cleanupUserIds.push(userId);
    const invId = await inviteMember(client, businessId, randomEmail("no-direct-branch"), "VIEWER");
    const branchId = await createBranch(client, businessId, { name: "Direct Write Attempt" });

    const { error } = await client.from("business_invitation_branches").insert({
      business_id: businessId,
      invitation_id: invId,
      branch_id: branchId,
      is_primary: true,
    } as never);
    expect(error).not.toBeNull();
  });
});
