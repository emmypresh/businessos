import { describe, expect, it, afterEach } from "vitest";
import {
  createAdminClient,
  createConfirmedTestUser,
  deleteTestUser,
  createUserClient,
} from "./helpers/admin-client";
import { createTestDbClient } from "./helpers/db-client";

// This file tests the actual security boundary directly: issue_recovery_grant
// is executable ONLY by service_role (never authenticated, never anon) — see
// the migration's header comment for the vulnerability this closes (an
// ordinary authenticated session could previously mint its own grant).
// createAdminClient() here stands in for the trusted server-only issuer
// (lib/auth/recovery-grant-admin-client.ts) — same underlying local
// service-role key, used the same way: pass an already-verified
// user_id/session_id, never derive it from the caller's own JWT.

let cleanupUserIds: string[] = [];

afterEach(async () => {
  for (const id of cleanupUserIds) {
    await deleteTestUser(id);
  }
  cleanupUserIds = [];
});

async function signedInClient(email: string, password: string) {
  const client = createUserClient();
  const { error } = await client.auth.signInWithPassword({ email, password });
  if (error) throw error;
  return client;
}

async function currentIdentity(client: ReturnType<typeof createUserClient>) {
  const { data } = await client.auth.getClaims();
  const claims = data?.claims as { sub?: string; session_id?: string } | undefined;
  if (!claims?.sub || !claims.session_id) throw new Error("no session");
  return { userId: claims.sub, sessionId: claims.session_id };
}

/** What the trusted server-only issuer does — admin client, explicit params. */
async function issueGrantAsTrustedServer(userId: string, sessionId: string) {
  const admin = createAdminClient();
  return admin.rpc("issue_recovery_grant", { p_user_id: userId, p_session_id: sessionId });
}

describe("issue_recovery_grant: EXECUTE boundary (the Codex-reported exploit)", () => {
  it("REGRESSION: an ordinary password-authenticated session cannot call issue_recovery_grant directly", async () => {
    const email = `exploit-ordinary-${Date.now()}@example.test`;
    const user = await createConfirmedTestUser(email, "Password1234");
    cleanupUserIds.push(user.id);
    const client = await signedInClient(email, "Password1234");
    const { userId, sessionId } = await currentIdentity(client);

    // This is the exact exploit Codex confirmed: a normal authenticated
    // client — reachable with nothing more than the public anon/publishable
    // key and a real login — calling issue_recovery_grant for itself.
    const { data, error } = await client.rpc("issue_recovery_grant", {
      p_user_id: userId,
      p_session_id: sessionId,
    });

    expect(data).toBeNull();
    expect(error).not.toBeNull();
    // PostgREST surfaces a missing EXECUTE grant as a permission error
    // (42501) — not merely "no rows" or a business-logic false. The RPC
    // must be genuinely inaccessible, not just behaviorally declined.
    expect(error?.code).toBe("42501");
  });

  it("a signup-confirmation session cannot call issue_recovery_grant directly", async () => {
    const email = `exploit-signup-${Date.now()}@example.test`;
    const admin = createAdminClient();
    const { data: created } = await admin.auth.admin.createUser({
      email,
      password: "Password1234",
      email_confirm: false,
    });
    cleanupUserIds.push(created!.user!.id);

    const { data: linkData } = await admin.auth.admin.generateLink({
      type: "signup",
      email,
      password: "Password1234",
    });
    const client = createUserClient();
    await client.auth.verifyOtp({ type: "email", token_hash: linkData!.properties!.hashed_token });
    const { userId, sessionId } = await currentIdentity(client);

    const { data, error } = await client.rpc("issue_recovery_grant", {
      p_user_id: userId,
      p_session_id: sessionId,
    });
    expect(data).toBeNull();
    expect(error?.code).toBe("42501");
  });

  it("an anonymous (unauthenticated) client cannot call issue_recovery_grant", async () => {
    const client = createUserClient();
    const { data, error } = await client.rpc("issue_recovery_grant", {
      p_user_id: "00000000-0000-0000-0000-000000000000",
      p_session_id: "00000000-0000-0000-0000-000000000000",
    });
    expect(data).toBeNull();
    expect(error).not.toBeNull();
  });

  it("the trusted server-only path (service_role) CAN issue a grant", async () => {
    const email = `trusted-issuer-${Date.now()}@example.test`;
    const user = await createConfirmedTestUser(email, "Password1234");
    cleanupUserIds.push(user.id);
    const client = await signedInClient(email, "Password1234");
    const { userId, sessionId } = await currentIdentity(client);

    const { data: grantId, error } = await issueGrantAsTrustedServer(userId, sessionId);
    expect(error).toBeNull();
    expect(grantId).toBeTruthy();
  });
});

describe("consume_recovery_grant", () => {
  it("a grant issued (by the trusted server path) for the current session can be consumed by that session", async () => {
    const email = `grant-basic-${Date.now()}@example.test`;
    const user = await createConfirmedTestUser(email, "Password1234");
    cleanupUserIds.push(user.id);
    const client = await signedInClient(email, "Password1234");
    const { userId, sessionId } = await currentIdentity(client);

    const { data: grantId, error: issueError } = await issueGrantAsTrustedServer(userId, sessionId);
    expect(issueError).toBeNull();

    const { data: consumed, error: consumeError } = await client.rpc(
      "consume_recovery_grant",
      { p_grant_id: grantId! }
    );
    expect(consumeError).toBeNull();
    expect(consumed).toBe(true);
  });

  it("a session that never had a grant issued cannot consume a random grant id", async () => {
    const email = `grant-none-${Date.now()}@example.test`;
    const user = await createConfirmedTestUser(email, "Password1234");
    cleanupUserIds.push(user.id);
    const client = await signedInClient(email, "Password1234");

    const { data: consumed, error } = await client.rpc("consume_recovery_grant", {
      p_grant_id: "00000000-0000-0000-0000-000000000000",
    });
    expect(error).toBeNull();
    expect(consumed).toBe(false);
  });

  it("the capability cannot be reused: a second consume of the same grant fails (also proves 'after password reset, same grant cannot be reused')", async () => {
    const email = `grant-reuse-${Date.now()}@example.test`;
    const user = await createConfirmedTestUser(email, "Password1234");
    cleanupUserIds.push(user.id);
    const client = await signedInClient(email, "Password1234");
    const { userId, sessionId } = await currentIdentity(client);

    const { data: grantId } = await issueGrantAsTrustedServer(userId, sessionId);
    const first = await client.rpc("consume_recovery_grant", { p_grant_id: grantId! });
    expect(first.data).toBe(true);

    const second = await client.rpc("consume_recovery_grant", { p_grant_id: grantId! });
    expect(second.error).toBeNull();
    expect(second.data).toBe(false);
  });

  it("a grant is bound to the session it was issued for — a different (later, ordinary) session of the same user cannot consume it", async () => {
    const email = `grant-session-bound-${Date.now()}@example.test`;
    const user = await createConfirmedTestUser(email, "Password1234");
    cleanupUserIds.push(user.id);

    const clientA = await signedInClient(email, "Password1234");
    const { userId, sessionId: sessionIdA } = await currentIdentity(clientA);
    const { data: grantId } = await issueGrantAsTrustedServer(userId, sessionIdA);
    expect(grantId).toBeTruthy();

    // A brand-new, separate sign-in for the SAME user — exactly what "an
    // ordinary password login" looks like — must not be able to ride on
    // session A's grant.
    const clientB = createUserClient();
    await clientB.auth.signInWithPassword({ email, password: "Password1234" });

    const { data: consumed, error } = await clientB.rpc("consume_recovery_grant", {
      p_grant_id: grantId!,
    });
    expect(error).toBeNull();
    expect(consumed).toBe(false);

    const { data: stillWorks } = await clientA.rpc("consume_recovery_grant", {
      p_grant_id: grantId!,
    });
    expect(stillWorks).toBe(true);
  });

  it("recovery still works after a token refresh: session_id is stable across refreshSession()", async () => {
    const email = `grant-refresh-${Date.now()}@example.test`;
    const user = await createConfirmedTestUser(email, "Password1234");
    cleanupUserIds.push(user.id);
    const client = await signedInClient(email, "Password1234");
    const { userId, sessionId } = await currentIdentity(client);

    const { data: grantId } = await issueGrantAsTrustedServer(userId, sessionId);
    expect(grantId).toBeTruthy();

    const { data: refreshed, error: refreshError } = await client.auth.refreshSession();
    expect(refreshError).toBeNull();
    expect(refreshed.session).not.toBeNull();

    const { data: consumed, error } = await client.rpc("consume_recovery_grant", {
      p_grant_id: grantId!,
    });
    expect(error).toBeNull();
    expect(consumed).toBe(true);
  });

  it("an expired grant fails safely", async () => {
    const email = `grant-expired-${Date.now()}@example.test`;
    const user = await createConfirmedTestUser(email, "Password1234");
    cleanupUserIds.push(user.id);
    const client = await signedInClient(email, "Password1234");
    const { userId, sessionId } = await currentIdentity(client);

    const { data: grantId } = await issueGrantAsTrustedServer(userId, sessionId);
    expect(grantId).toBeTruthy();

    const sql = createTestDbClient();
    try {
      await sql`
        update private.password_recovery_grants
        set expires_at = now() - interval '1 minute'
        where id = ${grantId!}
      `;
    } finally {
      await sql.end();
    }

    const { data: consumed, error } = await client.rpc("consume_recovery_grant", {
      p_grant_id: grantId!,
    });
    expect(error).toBeNull();
    expect(consumed).toBe(false);
  });

  it("a malformed grant id fails safely rather than erroring the caller out", async () => {
    const email = `grant-malformed-${Date.now()}@example.test`;
    const user = await createConfirmedTestUser(email, "Password1234");
    cleanupUserIds.push(user.id);
    const client = await signedInClient(email, "Password1234");

    const { error } = await client.rpc("consume_recovery_grant", {
      p_grant_id: "not-a-uuid" as unknown as string,
    });
    // PostgREST rejects a malformed uuid parameter with an error rather
    // than a false — either way, this must never resolve to "consumed".
    expect(error).not.toBeNull();
  });

  it("an unauthenticated caller cannot consume a grant", async () => {
    const client = createUserClient();
    const consume = await client.rpc("consume_recovery_grant", {
      p_grant_id: "00000000-0000-0000-0000-000000000000",
    });
    expect(consume.data).not.toBe(true);
  });

  it("a grant belongs to the user it was issued for — a different user's session cannot consume it", async () => {
    const emailA = `grant-user-a-${Date.now()}@example.test`;
    const userA = await createConfirmedTestUser(emailA, "Password1234");
    cleanupUserIds.push(userA.id);
    const clientA = await signedInClient(emailA, "Password1234");
    const { userId: userIdA, sessionId: sessionIdA } = await currentIdentity(clientA);
    const { data: grantId } = await issueGrantAsTrustedServer(userIdA, sessionIdA);

    const emailB = `grant-user-b-${Date.now()}@example.test`;
    const userB = await createConfirmedTestUser(emailB, "Password1234");
    cleanupUserIds.push(userB.id);
    const clientB = await signedInClient(emailB, "Password1234");

    const { data: consumed, error } = await clientB.rpc("consume_recovery_grant", {
      p_grant_id: grantId!,
    });
    expect(error).toBeNull();
    expect(consumed).toBe(false);
  });

  it("a valid recovery grant allows updateUser to succeed, end to end", async () => {
    const email = `grant-updates-password-${Date.now()}@example.test`;
    const user = await createConfirmedTestUser(email, "OldPassword1");
    cleanupUserIds.push(user.id);
    const client = await signedInClient(email, "OldPassword1");
    const { userId, sessionId } = await currentIdentity(client);

    const { data: grantId } = await issueGrantAsTrustedServer(userId, sessionId);
    const { data: consumed } = await client.rpc("consume_recovery_grant", { p_grant_id: grantId! });
    expect(consumed).toBe(true);

    const { error: updateError } = await client.auth.updateUser({ password: "NewPassword1" });
    expect(updateError).toBeNull();

    // Conclusive proof: sign in with the new password succeeds.
    const verifyClient = createUserClient();
    const { error: signInError } = await verifyClient.auth.signInWithPassword({
      email,
      password: "NewPassword1",
    });
    expect(signInError).toBeNull();
  });
});
