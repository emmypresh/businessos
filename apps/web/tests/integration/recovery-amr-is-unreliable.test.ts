import { describe, expect, it, afterEach } from "vitest";
import {
  createAdminClient,
  createConfirmedTestUser,
  deleteTestUser,
  createUserClient,
} from "./helpers/admin-client";

// This file is documentation-only: it does not gate any application
// behavior. It exists to prove, empirically, why claims.amr cannot be
// used to authorize updatePassword — the real gate is the single-use
// grant tested in recovery-grant.test.ts.
//
// Reproduced independently (Codex's Phase 1B review) and confirmed here:
//   password login              -> amr method "password"
//   signup confirmation (otp)   -> amr method "otp"
//   recovery verification (otp) -> amr method "otp"
//   signup confirmation, after a token refresh -> still "otp"
//   recovery verification, after a token refresh -> still "otp"
// "otp" alone cannot distinguish signup confirmation from recovery, so
// `mostRecentMethod === "otp"` (the original design) would have let a
// freshly-signed-up user who never requested a password reset call
// updatePassword anyway.

let cleanupUserIds: string[] = [];

afterEach(async () => {
  for (const id of cleanupUserIds) {
    await deleteTestUser(id);
  }
  cleanupUserIds = [];
});

async function mostRecentAmrMethod(client: ReturnType<typeof createUserClient>) {
  const { data } = await client.auth.getClaims();
  const amr = (data?.claims as { amr?: { method: string }[] } | undefined)?.amr;
  return amr?.[amr.length - 1]?.method;
}

describe("claims.amr does not distinguish recovery from signup confirmation", () => {
  it("password login -> 'password'", async () => {
    const email = `amr-password-${Date.now()}@example.test`;
    const user = await createConfirmedTestUser(email, "Password1234");
    cleanupUserIds.push(user.id);

    const client = createUserClient();
    await client.auth.signInWithPassword({ email, password: "Password1234" });

    expect(await mostRecentAmrMethod(client)).toBe("password");
  });

  it("signup-confirmation verifyOtp -> 'otp' (NOT distinguishable from recovery below)", async () => {
    const email = `amr-signup-${Date.now()}@example.test`;
    // A real (unconfirmed) signup, then confirm it via a generated link —
    // mirrors what /auth/confirm?type=email does.
    const admin = createAdminClient();
    const { data: created, error: createError } = await admin.auth.admin.createUser({
      email,
      password: "Password1234",
      email_confirm: false,
    });
    expect(createError).toBeNull();
    cleanupUserIds.push(created.user!.id);

    const { data: linkData, error: linkError } = await admin.auth.admin.generateLink({
      type: "signup",
      email,
      password: "Password1234",
    });
    expect(linkError).toBeNull();

    const client = createUserClient();
    const { error: verifyError } = await client.auth.verifyOtp({
      type: "email",
      token_hash: linkData!.properties!.hashed_token,
    });
    expect(verifyError).toBeNull();

    expect(await mostRecentAmrMethod(client)).toBe("otp");
  });

  it("recovery verifyOtp -> 'otp' (identical to signup confirmation above)", async () => {
    const email = `amr-recovery-${Date.now()}@example.test`;
    const user = await createConfirmedTestUser(email, "Password1234");
    cleanupUserIds.push(user.id);

    const admin = createAdminClient();
    const { data: linkData, error: linkError } = await admin.auth.admin.generateLink({
      type: "recovery",
      email,
    });
    expect(linkError).toBeNull();

    const client = createUserClient();
    const { error: verifyError } = await client.auth.verifyOtp({
      type: "recovery",
      token_hash: linkData!.properties!.hashed_token,
    });
    expect(verifyError).toBeNull();

    expect(await mostRecentAmrMethod(client)).toBe("otp");
  });

  it("signup confirmation's amr is still 'otp' after a token refresh", async () => {
    const email = `amr-signup-refresh-${Date.now()}@example.test`;
    const admin = createAdminClient();
    const { data: created, error: createError } = await admin.auth.admin.createUser({
      email,
      password: "Password1234",
      email_confirm: false,
    });
    expect(createError).toBeNull();
    cleanupUserIds.push(created.user!.id);

    const { data: linkData } = await admin.auth.admin.generateLink({
      type: "signup",
      email,
      password: "Password1234",
    });
    const client = createUserClient();
    await client.auth.verifyOtp({ type: "email", token_hash: linkData!.properties!.hashed_token });

    await client.auth.refreshSession();
    expect(await mostRecentAmrMethod(client)).toBe("otp");
  });

  it("recovery's amr is still 'otp' after a token refresh — cannot be told apart from signup confirmation above", async () => {
    const email = `amr-recovery-refresh-${Date.now()}@example.test`;
    const user = await createConfirmedTestUser(email, "Password1234");
    cleanupUserIds.push(user.id);

    const admin = createAdminClient();
    const { data: linkData } = await admin.auth.admin.generateLink({ type: "recovery", email });
    const client = createUserClient();
    await client.auth.verifyOtp({ type: "recovery", token_hash: linkData!.properties!.hashed_token });

    await client.auth.refreshSession();
    expect(await mostRecentAmrMethod(client)).toBe("otp");
  });
});
