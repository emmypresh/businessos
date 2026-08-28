import { describe, expect, it, afterEach } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";
import type { Database } from "@/lib/supabase/database.types";
import { createConfirmedTestUser, createUserClient, deleteTestUser } from "./helpers/admin-client";
import { createOwnerAndBusiness, createMemberWithRole, randomUuid } from "./helpers/inventory";
import { inviteMember, acceptInvitation, createBranch, randomEmail } from "./helpers/staff";
import { createTestDbClient } from "./helpers/db-client";

let cleanupUserIds: string[] = [];
afterEach(async () => {
  for (const id of cleanupUserIds) await deleteTestUser(id);
  cleanupUserIds = [];
});

async function makeAcceptedMember(
  owner: { client: SupabaseClient<Database>; businessId: string },
  prefix: string,
  role: string
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

// Codex adversarial review round 4: the PREVIOUS version of the two
// "concurrent owner protection" tests below launched two real RPC calls
// via Promise.all and asserted the LOSING call failed with EXACTLY
// LAST_OWNER_REQUIRED. That is genuinely nondeterministic — Promise.all
// only guarantees both requests are DISPATCHED together, not that both
// reach their own internal owner-authority read before either completes
// its mutation. Under load, one call's ENTIRE round trip (including its
// trigger firing and commit) can finish before the other's authority
// check even runs — in which case the second call's OWN hierarchy check
// (not the trigger) is what rejects it, correctly returning
// CANNOT_MANAGE_OWNER instead. Both outcomes are safe production
// behavior; the test was over-constraining one exact schedule.
//
// This replaces that nondeterministic Promise.all pattern with a REAL
// deterministic barrier, built entirely from primitives already used
// elsewhere in this suite (createTestDbClient — see helpers/db-client.ts
// — configured with `max: 1`, so each instance is already pinned to one
// exclusive connection, letting raw BEGIN/COMMIT persist a transaction
// across separate calls with no extra pooling infrastructure needed):
//
//   1. Connection 1 impersonates owner A (via `set_config
//      ('request.jwt.claim.sub', ..., true)` — the exact JWT claim
//      private.current_uid() reads, so this genuinely exercises the RPC
//      as that real authenticated user would) and calls the RPC
//      demoting/suspending B. This is fully AWAITED so it is 100%
//      complete server-side — but the transaction is deliberately left
//      UNCOMMITTED, so the advisory lock private.protect_last_owner
//      takes (salt 0, the same lock the OLD concurrent test relied on
//      informally) stays HELD.
//   2. Connection 2 impersonates owner B and calls the RPC
//      demoting/suspending A. Its OWN authority read correctly sees B as
//      still OWNER (connection 1's change is real but uncommitted, so
//      MVCC makes it invisible to connection 2) — this is the exact
//      state a genuine concurrent call would see. It then blocks inside
//      its OWN trigger, waiting on the same advisory lock connection 1
//      holds.
//   3. We POLL pg_stat_activity (a bounded, real state check — never an
//      arbitrary sleep) until connection 2's backend is OBSERVED
//      wait_event = 'advisory' for that specific pid — i.e., we wait for
//      proof the barrier has actually been reached, not a guessed delay.
//   4. Only THEN do we commit connection 1. Connection 2 unblocks,
//      re-evaluates with the now-committed state, and is deterministically
//      rejected — every single run, not merely "usually".
//
// This one test now proves BOTH required properties at once: the safety
// property (exactly one demotion succeeds, one active owner always
// remains) AND the exact error-translation mapping (LAST_OWNER_REQUIRED)
// — with zero dependence on network/scheduling luck.
async function runDeterministicLastOwnerRace(params: {
  businessId: string;
  callerAUid: string;
  callSqlA: string;
  argsA: unknown[];
  callerBUid: string;
  callSqlB: string;
  argsB: unknown[];
}) {
  const c1 = createTestDbClient();
  const c2 = createTestDbClient();
  try {
    await c1`begin`;
    await c1`select set_config('request.jwt.claim.sub', ${params.callerAUid}, true)`;
    // Fully awaited: connection 1's entire call — authority read,
    // target lock, mutation, and trigger check — is complete. Its
    // transaction (and the advisory lock its trigger acquired) remains
    // open until we explicitly commit below.
    const r1 = await c1.unsafe(params.callSqlA, params.argsA as never[]);

    const [{ pid: c2pid }] = await c2<{ pid: number }[]>`select pg_backend_pid() as pid`;
    await c2`begin`;
    await c2`select set_config('request.jwt.claim.sub', ${params.callerBUid}, true)`;
    // Dispatched but NOT awaited yet — attaching .catch() immediately is
    // what actually flushes the query onto the wire promptly (confirmed
    // empirically: without any consumer attached, postgres.js can leave
    // it queued far longer than this barrier's poll window tolerates).
    const p2 = c2.unsafe(params.callSqlB, params.argsB as never[]);
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

    let r2: unknown = null;
    let err2: { message: string } | null = null;
    try {
      r2 = await p2;
    } catch (e) {
      err2 = e as { message: string };
    }
    try {
      await c2`commit`;
    } catch {
      await c2`rollback`.catch(() => {});
    }

    return { r1, r2, err2 };
  } finally {
    await c1.end();
    await c2.end();
  }
}

describe("OWNER manages staff", () => {
  it("OWNER can change an ordinary member's role", async () => {
    const owner = await createOwnerAndBusiness("hier-owner-role");
    cleanupUserIds.push(owner.userId);
    const member = await makeAcceptedMember(owner, "hier-owner-role", "SALES");
    cleanupUserIds.push(member.userId);

    const { error } = await owner.client.rpc("change_member_role", {
      p_business_id: owner.businessId, p_member_id: member.memberId, p_role: "MANAGER",
    });
    expect(error).toBeNull();
  });

  it("OWNER can assign the OWNER role to another member", async () => {
    const owner = await createOwnerAndBusiness("hier-owner-assign-owner");
    cleanupUserIds.push(owner.userId);
    const member = await makeAcceptedMember(owner, "hier-owner-assign-owner", "ADMIN");
    cleanupUserIds.push(member.userId);

    const { error } = await owner.client.rpc("change_member_role", {
      p_business_id: owner.businessId, p_member_id: member.memberId, p_role: "OWNER",
    });
    expect(error).toBeNull();
  });

  it("OWNER can suspend and reactivate an ordinary member", async () => {
    const owner = await createOwnerAndBusiness("hier-owner-suspend");
    cleanupUserIds.push(owner.userId);
    const member = await makeAcceptedMember(owner, "hier-owner-suspend", "VIEWER");
    cleanupUserIds.push(member.userId);

    const { error: suspendErr } = await owner.client.rpc("suspend_member", {
      p_business_id: owner.businessId, p_member_id: member.memberId,
    });
    expect(suspendErr).toBeNull();

    const { error: reactivateErr } = await owner.client.rpc("reactivate_member", {
      p_business_id: owner.businessId, p_member_id: member.memberId,
    });
    expect(reactivateErr).toBeNull();
  });
});

describe("ADMIN manages ordinary (non-owner) staff", () => {
  it("ADMIN can change an ordinary member's role", async () => {
    const owner = await createOwnerAndBusiness("hier-admin-role");
    cleanupUserIds.push(owner.userId);
    const admin = await makeAcceptedMember(owner, "hier-admin-role", "ADMIN");
    cleanupUserIds.push(admin.userId);
    const member = await makeAcceptedMember(owner, "hier-admin-role-target", "SALES");
    cleanupUserIds.push(member.userId);

    const { error } = await admin.client.rpc("change_member_role", {
      p_business_id: owner.businessId, p_member_id: member.memberId, p_role: "INVENTORY",
    });
    expect(error).toBeNull();
  });

  it("ADMIN can suspend an ordinary member", async () => {
    const owner = await createOwnerAndBusiness("hier-admin-suspend");
    cleanupUserIds.push(owner.userId);
    const admin = await makeAcceptedMember(owner, "hier-admin-suspend", "ADMIN");
    cleanupUserIds.push(admin.userId);
    const member = await makeAcceptedMember(owner, "hier-admin-suspend-target", "VIEWER");
    cleanupUserIds.push(member.userId);

    const { error } = await admin.client.rpc("suspend_member", {
      p_business_id: owner.businessId, p_member_id: member.memberId,
    });
    expect(error).toBeNull();
  });

  it("ADMIN can assign branches to an ordinary member", async () => {
    const owner = await createOwnerAndBusiness("hier-admin-branches");
    cleanupUserIds.push(owner.userId);
    const admin = await makeAcceptedMember(owner, "hier-admin-branches", "ADMIN");
    cleanupUserIds.push(admin.userId);
    const member = await makeAcceptedMember(owner, "hier-admin-branches-target", "SALES");
    cleanupUserIds.push(member.userId);
    const branchId = await createBranch(owner.client, owner.businessId, { name: "Admin-Assigned Branch" });

    const { error } = await admin.client.rpc("replace_member_branches", {
      p_business_id: owner.businessId, p_member_id: member.memberId, p_branch_ids: [branchId], p_primary_branch_id: branchId,
    });
    expect(error).toBeNull();
  });
});

describe("ADMIN cannot manage OWNER", () => {
  it("ADMIN cannot change an OWNER's role", async () => {
    const owner = await createOwnerAndBusiness("hier-admin-vs-owner-role");
    cleanupUserIds.push(owner.userId);
    const admin = await makeAcceptedMember(owner, "hier-admin-vs-owner-role", "ADMIN");
    cleanupUserIds.push(admin.userId);
    const { data: ownerMember } = await owner.client
      .from("business_members").select("id").eq("business_id", owner.businessId).eq("user_id", owner.userId).single();

    const { error } = await admin.client.rpc("change_member_role", {
      p_business_id: owner.businessId, p_member_id: ownerMember!.id, p_role: "MANAGER",
    });
    expect(error?.message).toContain("CANNOT_MANAGE_OWNER");
  });

  it("ADMIN cannot suspend an OWNER", async () => {
    const owner = await createOwnerAndBusiness("hier-admin-vs-owner-suspend");
    cleanupUserIds.push(owner.userId);
    const admin = await makeAcceptedMember(owner, "hier-admin-vs-owner-suspend", "ADMIN");
    cleanupUserIds.push(admin.userId);
    const { data: ownerMember } = await owner.client
      .from("business_members").select("id").eq("business_id", owner.businessId).eq("user_id", owner.userId).single();

    const { error } = await admin.client.rpc("suspend_member", {
      p_business_id: owner.businessId, p_member_id: ownerMember!.id,
    });
    expect(error?.message).toContain("CANNOT_MANAGE_OWNER");
  });

  it("ADMIN cannot reassign an OWNER's branches", async () => {
    const owner = await createOwnerAndBusiness("hier-admin-vs-owner-branches");
    cleanupUserIds.push(owner.userId);
    const admin = await makeAcceptedMember(owner, "hier-admin-vs-owner-branches", "ADMIN");
    cleanupUserIds.push(admin.userId);
    const { data: ownerMember } = await owner.client
      .from("business_members").select("id").eq("business_id", owner.businessId).eq("user_id", owner.userId).single();

    const { error } = await admin.client.rpc("replace_member_branches", {
      p_business_id: owner.businessId, p_member_id: ownerMember!.id, p_branch_ids: [],
    });
    expect(error?.message).toContain("CANNOT_MANAGE_OWNER");
  });

  it("ADMIN cannot revoke an OWNER-targeted pending invitation", async () => {
    const owner = await createOwnerAndBusiness("hier-admin-revoke-owner-invite");
    cleanupUserIds.push(owner.userId);
    const admin = await makeAcceptedMember(owner, "hier-admin-revoke-owner-invite", "ADMIN");
    cleanupUserIds.push(admin.userId);
    const invId = await inviteMember(owner.client, owner.businessId, randomEmail("future-owner"), "OWNER");

    const { error } = await admin.client.rpc("revoke_business_invitation", {
      p_business_id: owner.businessId, p_invitation_id: invId,
    });
    expect(error?.message).toContain("CANNOT_MANAGE_OWNER");
  });
});

describe("ADMIN cannot assign OWNER", () => {
  it("ADMIN cannot promote a member to OWNER via change_member_role", async () => {
    const owner = await createOwnerAndBusiness("hier-admin-assign-owner-role");
    cleanupUserIds.push(owner.userId);
    const admin = await makeAcceptedMember(owner, "hier-admin-assign-owner-role", "ADMIN");
    cleanupUserIds.push(admin.userId);
    const member = await makeAcceptedMember(owner, "hier-admin-assign-owner-target", "SALES");
    cleanupUserIds.push(member.userId);

    const { error } = await admin.client.rpc("change_member_role", {
      p_business_id: owner.businessId, p_member_id: member.memberId, p_role: "OWNER",
    });
    expect(error?.message).toContain("CANNOT_ASSIGN_OWNER_ROLE");

    const { data } = await owner.client.from("business_members").select("role_id").eq("id", member.memberId).single();
    const { data: salesRole } = await owner.client.from("roles").select("id").eq("name", "SALES").single();
    expect(data?.role_id).toBe(salesRole!.id);
  });

  it("ADMIN cannot invite a new member as OWNER", async () => {
    const owner = await createOwnerAndBusiness("hier-admin-invite-owner");
    cleanupUserIds.push(owner.userId);
    const admin = await makeAcceptedMember(owner, "hier-admin-invite-owner", "ADMIN");
    cleanupUserIds.push(admin.userId);

    const { error } = await admin.client.rpc("create_business_invitation", {
      p_business_id: owner.businessId, p_creation_key: randomUuid(), p_email: randomEmail("future-owner-2"), p_role: "OWNER",
    });
    expect(error?.message).toContain("CANNOT_ASSIGN_OWNER_ROLE");
  });
});

describe("self-promotion / self-targeting blocked", () => {
  it("a member cannot change their own role, even to a lower one", async () => {
    const owner = await createOwnerAndBusiness("hier-self-role");
    cleanupUserIds.push(owner.userId);
    const admin = await makeAcceptedMember(owner, "hier-self-role", "ADMIN");
    cleanupUserIds.push(admin.userId);

    const { error } = await admin.client.rpc("change_member_role", {
      p_business_id: owner.businessId, p_member_id: admin.memberId, p_role: "VIEWER",
    });
    expect(error?.message).toContain("CANNOT_MANAGE_SELF");
  });

  it("a member cannot suspend themselves", async () => {
    const owner = await createOwnerAndBusiness("hier-self-suspend");
    cleanupUserIds.push(owner.userId);
    const admin = await makeAcceptedMember(owner, "hier-self-suspend", "ADMIN");
    cleanupUserIds.push(admin.userId);

    const { error } = await admin.client.rpc("suspend_member", {
      p_business_id: owner.businessId, p_member_id: admin.memberId,
    });
    expect(error?.message).toContain("CANNOT_MANAGE_SELF");
  });

  it("there is no client-controlled path from a non-OWNER role to OWNER — every write attempt is rejected", async () => {
    const owner = await createOwnerAndBusiness("hier-no-self-promote-path");
    cleanupUserIds.push(owner.userId);
    const admin = await makeAcceptedMember(owner, "hier-no-self-promote-path", "ADMIN");
    cleanupUserIds.push(admin.userId);

    // Attempt 1: change_member_role targeting self.
    const r1 = await admin.client.rpc("change_member_role", {
      p_business_id: owner.businessId, p_member_id: admin.memberId, p_role: "OWNER",
    });
    expect(r1.error?.message).toContain("CANNOT_MANAGE_SELF");

    // Attempt 2: a direct table UPDATE (no policy exists for authenticated at all).
    const { data: ownerRole } = await owner.client.from("roles").select("id").eq("name", "OWNER").single();
    const direct = await admin.client.from("business_members").update({ role_id: ownerRole!.id }).eq("id", admin.memberId);
    expect(direct.error).not.toBeNull();

    const { data: stillAdmin } = await owner.client.from("business_members").select("role_id").eq("id", admin.memberId).single();
    expect(stillAdmin?.role_id).not.toBe(ownerRole!.id);
  });
});

describe("last-owner protection (demotion/suspension)", () => {
  // Codex adversarial review, Finding 8B: the ORIGINAL title/comment here
  // claimed the invariant "holds even across two owners acting on a
  // third" — there is no third owner anywhere in this test, and no
  // scenario reachable through the RPC layer can isolate
  // LAST_OWNER_REQUIRED from the earlier, stronger CANNOT_MANAGE_OWNER /
  // CANNOT_MANAGE_SELF hierarchy checks for a SOLE remaining owner (any
  // RPC caller who could target them is either that owner themself — self
  // -targeting — or a non-owner — CANNOT_MANAGE_OWNER). What this test
  // ACTUALLY proves: (1) demoting from two owners down to one succeeds
  // through the real RPC, and (2) the resulting sole owner is then
  // protected at the trigger level — provable only via a direct,
  // RLS/RPC-bypassing SQL write, never via any reachable RPC call. See
  // the "concurrent owner protection" describe block below for the one
  // scenario where LAST_OWNER_REQUIRED genuinely surfaces THROUGH the RPC
  // layer (a race between two simultaneous real owners).
  it("demoting from two owners to one succeeds via the RPC; the resulting sole owner is then protected by the LAST_OWNER_REQUIRED trigger itself, provable only via a direct SQL write that bypasses every RPC-layer hierarchy check", async () => {
    const owner = await createOwnerAndBusiness("hier-last-owner-demote");
    cleanupUserIds.push(owner.userId);
    const secondOwner = await makeAcceptedMember(owner, "hier-last-owner-demote-2", "ADMIN");
    cleanupUserIds.push(secondOwner.userId);
    await owner.client.rpc("change_member_role", {
      p_business_id: owner.businessId, p_member_id: secondOwner.memberId, p_role: "OWNER",
    });

    const { data: ownerMember } = await owner.client
      .from("business_members").select("id").eq("business_id", owner.businessId).eq("user_id", owner.userId).single();

    // With two real owners, demoting ONE (by the OTHER) succeeds through
    // the real change_member_role RPC — this is the genuine two-owner
    // case, not a last-owner rejection.
    const { error: demoteFirst } = await secondOwner.client.rpc("change_member_role", {
      p_business_id: owner.businessId, p_member_id: ownerMember!.id, p_role: "ADMIN",
    });
    expect(demoteFirst).toBeNull();

    // Now secondOwner is the ONLY owner. No RPC call can reach
    // LAST_OWNER_REQUIRED for them specifically: secondOwner targeting
    // themself hits CANNOT_MANAGE_SELF first, and the newly-demoted
    // ADMIN (the original owner) targeting secondOwner hits
    // CANNOT_MANAGE_OWNER first — both are earlier, stronger checks than
    // the last-owner trigger. The trigger itself is real and independent
    // of the RPC layer, proven here via a direct SQL write.
    const sql = (await import("./helpers/db-client")).createTestDbClient();
    try {
      await expect(
        sql`update public.business_members set role_id = (select id from public.roles where name = 'ADMIN') where id = ${secondOwner.memberId}`
      ).rejects.toThrow(/last owner/i);
    } finally {
      await sql.end();
    }
  });

  it("the last OWNER cannot be suspended (direct SQL proof of the underlying trigger, independent of any RPC-layer check)", async () => {
    const owner = await createOwnerAndBusiness("hier-last-owner-suspend-sql");
    cleanupUserIds.push(owner.userId);
    const { data: ownerMember } = await owner.client
      .from("business_members").select("id").eq("business_id", owner.businessId).eq("user_id", owner.userId).single();

    const sql = (await import("./helpers/db-client")).createTestDbClient();
    try {
      await expect(
        sql`update public.business_members set status = 'suspended' where id = ${ownerMember!.id}`
      ).rejects.toThrow(/last owner/i);
    } finally {
      await sql.end();
    }
  });

  // Codex adversarial review round 3, Finding B: the ORIGINAL title here
  // claimed "suspend_member surfaces... LAST_OWNER_REQUIRED" — but the
  // test body only ever calls change_member_role (never suspend_member),
  // and its final assertion is CANNOT_MANAGE_OWNER, not
  // LAST_OWNER_REQUIRED. Retitled to state exactly what this test
  // exercises and proves. A genuinely LAST_OWNER_REQUIRED-producing
  // scenario for BOTH change_member_role and suspend_member is covered
  // separately below, in "concurrent owner protection" — the only way to
  // reach that code through the RPC layer at all is the real concurrent
  // race described there (see that describe block's own header comment
  // for why a single, non-concurrent call can never reach it).
  it("in a single-remaining-owner scenario, change_member_role is blocked by CANNOT_MANAGE_OWNER (a non-owner targeting the sole owner) — not by the last-owner trigger, which this specific call never reaches", async () => {
    // Constructed so the caller ends up a non-owner (ADMIN) targeting the
    // sole remaining OWNER — CANNOT_MANAGE_OWNER fires on the hierarchy
    // check itself, well before the last-owner trigger would ever be
    // consulted; a single sequential call can never isolate the trigger
    // this way (suspending/demoting the sole owner via any OTHER path is
    // always either self-targeting or exactly this hierarchy check).
    const owner = await createOwnerAndBusiness("hier-last-owner-required-code");
    cleanupUserIds.push(owner.userId);
    const secondOwner = await makeAcceptedMember(owner, "hier-last-owner-required-code-2", "ADMIN");
    cleanupUserIds.push(secondOwner.userId);
    await owner.client.rpc("change_member_role", {
      p_business_id: owner.businessId, p_member_id: secondOwner.memberId, p_role: "OWNER",
    });
    const { data: ownerMember } = await owner.client
      .from("business_members").select("id").eq("business_id", owner.businessId).eq("user_id", owner.userId).single();
    // Demote the ORIGINAL owner down to just one owner (secondOwner) —
    // succeeds (two owners -> one).
    await secondOwner.client.rpc("change_member_role", {
      p_business_id: owner.businessId, p_member_id: ownerMember!.id, p_role: "ADMIN",
    });
    // Re-promote the original owner back — now two owners again.
    await secondOwner.client.rpc("change_member_role", {
      p_business_id: owner.businessId, p_member_id: ownerMember!.id, p_role: "OWNER",
    });
    // Now demote secondOwner via the original owner — succeeds (still
    // one owner left: the original).
    const { error: demoteErr } = await owner.client.rpc("change_member_role", {
      p_business_id: owner.businessId, p_member_id: secondOwner.memberId, p_role: "ADMIN",
    });
    expect(demoteErr).toBeNull();
    // secondOwner (now ADMIN) attempting to demote the original (sole
    // remaining owner) is blocked by CANNOT_MANAGE_OWNER (a non-owner
    // targeting an owner) — the LAST_OWNER_REQUIRED code itself is
    // exercised directly via SQL in the two tests above, which is the
    // only way to isolate it from the hierarchy check that would
    // otherwise always fire first in any single-remaining-owner scenario
    // reachable through the RPC layer.
    const { error: blockedErr } = await secondOwner.client.rpc("change_member_role", {
      p_business_id: owner.businessId, p_member_id: ownerMember!.id, p_role: "ADMIN",
    });
    expect(blockedErr?.message).toContain("CANNOT_MANAGE_OWNER");
  });
});

// Codex adversarial review round 3, Finding B: LAST_OWNER_REQUIRED is
// structurally unreachable through ANY single, sequential RPC call for
// either change_member_role or suspend_member — reasoning it out: a
// caller targeting the sole remaining owner is either that owner
// themself (CANNOT_MANAGE_SELF fires first) or a non-owner (CANNOT_
// MANAGE_OWNER fires first, since a caller who currently IS an owner and
// is NOT self-targeting necessarily implies at least two owners exist,
// which can never leave zero). The ONLY way to reach the trigger's own
// LAST_OWNER_REQUIRED translation is a genuine race: two REAL owners,
// each targeting the OTHER simultaneously, where the advisory lock in
// private.protect_last_owner serializes them and the SECOND (losing)
// call is the one that discovers only one owner is left. Both RPCs
// (change_member_role AND suspend_member) implement this translation
// independently — each has its own exception handler catching the raw
// trigger error and re-raising the stable LAST_OWNER_REQUIRED code — so
// both are covered here, not just one.
describe("concurrent owner protection", () => {
  it("concurrent owner demotions preserve at least one active owner, and the deterministically-losing side is rejected with exactly LAST_OWNER_REQUIRED", async () => {
    const owner = await createOwnerAndBusiness("hier-concurrent-owner");
    cleanupUserIds.push(owner.userId);
    const secondOwner = await makeAcceptedMember(owner, "hier-concurrent-owner-2", "ADMIN");
    cleanupUserIds.push(secondOwner.userId);
    await owner.client.rpc("change_member_role", {
      p_business_id: owner.businessId, p_member_id: secondOwner.memberId, p_role: "OWNER",
    });
    const { data: ownerMember } = await owner.client
      .from("business_members").select("id").eq("business_id", owner.businessId).eq("user_id", owner.userId).single();

    // Connection 1 (owner A) fully demotes B first and holds the
    // transaction open; connection 2 (owner B) then races to demote A,
    // deterministically discovering — only once connection 1 finally
    // commits — that it would leave zero owners.
    const { r2, err2 } = await runDeterministicLastOwnerRace({
      businessId: owner.businessId,
      callerAUid: owner.userId,
      callSqlA: "select public.change_member_role($1::uuid, $2::uuid, $3::text) as result",
      argsA: [owner.businessId, secondOwner.memberId, "ADMIN"],
      callerBUid: secondOwner.userId,
      callSqlB: "select public.change_member_role($1::uuid, $2::uuid, $3::text) as result",
      argsB: [owner.businessId, ownerMember!.id, "ADMIN"],
    });

    // The deterministically-LOSING side (connection 2, demoting the
    // caller who ultimately remains the sole owner) is rejected — never
    // silently succeeds, never leaves zero owners.
    expect(r2).toBeNull();
    expect(err2).not.toBeNull();
    expect(err2!.message).toContain("LAST_OWNER_REQUIRED");
    // No raw/unhandled Postgres error leaked through — the message is
    // exactly the stable application code, not trigger internals.
    expect(err2!.message).not.toMatch(/constraint|trigger|function|relation/i);

    const { data: activeOwners } = await owner.client
      .from("business_members")
      .select("id, role_id")
      .eq("business_id", owner.businessId)
      .eq("status", "active");
    const { data: ownerRole } = await owner.client.from("roles").select("id").eq("name", "OWNER").single();
    const ownerCount = activeOwners!.filter((m) => m.role_id === ownerRole!.id).length;
    // Exactly one — connection 1's demotion of B genuinely committed, so
    // only the original owner remains.
    expect(ownerCount).toBe(1);
  });

  it("concurrent owner suspension attempts never remove the final active owner, and the deterministically-losing side is rejected with exactly LAST_OWNER_REQUIRED", async () => {
    const owner = await createOwnerAndBusiness("hier-concurrent-suspend-owner");
    cleanupUserIds.push(owner.userId);
    const secondOwner = await makeAcceptedMember(owner, "hier-concurrent-suspend-owner-2", "ADMIN");
    cleanupUserIds.push(secondOwner.userId);
    await owner.client.rpc("change_member_role", {
      p_business_id: owner.businessId, p_member_id: secondOwner.memberId, p_role: "OWNER",
    });
    const { data: ownerMember } = await owner.client
      .from("business_members").select("id").eq("business_id", owner.businessId).eq("user_id", owner.userId).single();

    // Same deterministic barrier, exercising suspend_member's OWN
    // independent exception handler — proves ITS translation logic too,
    // not merely change_member_role's.
    const { r2, err2 } = await runDeterministicLastOwnerRace({
      businessId: owner.businessId,
      callerAUid: owner.userId,
      callSqlA: "select public.suspend_member($1::uuid, $2::uuid) as result",
      argsA: [owner.businessId, secondOwner.memberId],
      callerBUid: secondOwner.userId,
      callSqlB: "select public.suspend_member($1::uuid, $2::uuid) as result",
      argsB: [owner.businessId, ownerMember!.id],
    });

    expect(r2).toBeNull();
    expect(err2).not.toBeNull();
    expect(err2!.message).toContain("LAST_OWNER_REQUIRED");
    expect(err2!.message).not.toMatch(/constraint|trigger|function|relation/i);

    // Verified via a PRIVILEGED direct-SQL connection, never owner.client
    // — whichever side of this race wins SUSPENDS the other (unlike the
    // demotion race, where the loser merely changes role and stays
    // active), so it is a genuine coinflip which of the two owner
    // sessions ends up suspended. If owner.client's OWN membership were
    // the one suspended, business_members' own RLS policy (any ACTIVE
    // member may read) would make owner.client see zero rows at all —
    // collapsing this assertion to a false "zero owners" failure that is
    // actually a query-visibility artifact, not a real violation. (Here
    // the race is fully controlled, so connection 1 — owner A — always
    // wins and B is always the one suspended, but the privileged
    // connection is kept anyway so this assertion's correctness never
    // depends on which side the test happens to control.)
    const sql = createTestDbClient();
    try {
      const rows = await sql<{ n: number }[]>`
        select count(*)::int as n
        from public.business_members bm
        join public.roles r on r.id = bm.role_id
        where bm.business_id = ${owner.businessId} and bm.status = 'active' and r.name = 'OWNER'
      `;
      // Exactly one — connection 1's suspension of B genuinely committed.
      expect(rows[0].n).toBe(1);
    } finally {
      await sql.end();
    }
  });
});

describe("VIEWER/SALES/etc. cannot manage staff at all", () => {
  it.each(["MANAGER", "SALES", "INVENTORY", "ACCOUNTANT", "VIEWER"])(
    "%s cannot call any staff-management RPC",
    async (role) => {
      const owner = await createOwnerAndBusiness(`hier-nonmgmt-${role}`);
      cleanupUserIds.push(owner.userId);
      const nonMgmt = await createMemberWithRole(owner.businessId, `hier-nonmgmt-${role}`, role);
      cleanupUserIds.push(nonMgmt.userId);
      const member = await makeAcceptedMember(owner, `hier-nonmgmt-target-${role}`, "VIEWER");
      cleanupUserIds.push(member.userId);

      const { error } = await nonMgmt.client.rpc("suspend_member", {
        p_business_id: owner.businessId, p_member_id: member.memberId,
      });
      expect(error?.message, role).toContain("insufficient_privilege");
    }
  );
});
