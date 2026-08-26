import { describe, expect, it, afterEach } from "vitest";
import {
  createConfirmedTestUser,
  deleteTestUser,
  createUserClient,
} from "./helpers/admin-client";

let cleanupUserId: string | undefined;

afterEach(async () => {
  if (cleanupUserId) {
    await deleteTestUser(cleanupUserId);
    cleanupUserId = undefined;
  }
});

describe("create_business RPC", () => {
  it("creates a business and an OWNER membership atomically", async () => {
    const email = `owner-${Date.now()}@example.test`;
    const user = await createConfirmedTestUser(email, "Password1234");
    cleanupUserId = user.id;

    const client = createUserClient();
    const { error: signInError } = await client.auth.signInWithPassword({
      email,
      password: "Password1234",
    });
    expect(signInError).toBeNull();

    const slug = `test-biz-${Date.now()}`;
    const { data: business, error } = await client.rpc("create_business", {
      p_name: "Test Business",
      p_slug: slug,
    });

    expect(error).toBeNull();
    expect(business?.slug).toBe(slug);

    const { data: membership, error: membershipError } = await client
      .from("business_members")
      .select("status, roles(name)")
      .eq("business_id", business!.id)
      .eq("user_id", user.id)
      .single();

    expect(membershipError).toBeNull();
    expect(membership?.status).toBe("active");
    expect((membership?.roles as { name: string } | null)?.name).toBe(
      "OWNER"
    );
  });

  it("rejects a duplicate slug with a 23505/SLUG_UNAVAILABLE error", async () => {
    const email = `dup-${Date.now()}@example.test`;
    const user = await createConfirmedTestUser(email, "Password1234");
    cleanupUserId = user.id;

    const client = createUserClient();
    await client.auth.signInWithPassword({ email, password: "Password1234" });

    const slug = `dup-slug-${Date.now()}`;
    const first = await client.rpc("create_business", {
      p_name: "First",
      p_slug: slug,
    });
    expect(first.error).toBeNull();

    const second = await client.rpc("create_business", {
      p_name: "Second",
      p_slug: slug,
    });
    expect(second.error).not.toBeNull();
    expect(second.error?.code).toBe("23505");
  });

  it("rejects an unauthenticated caller", async () => {
    const client = createUserClient();
    const { error } = await client.rpc("create_business", {
      p_name: "Nope",
      p_slug: `nope-${Date.now()}`,
    });
    expect(error).not.toBeNull();
  });
});
