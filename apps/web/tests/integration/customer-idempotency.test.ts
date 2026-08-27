import { describe, expect, it, afterEach } from "vitest";
import { deleteTestUser } from "./helpers/admin-client";
import { createOwnerAndBusiness, randomUuid } from "./helpers/inventory";

let cleanupUserIds: string[] = [];
afterEach(async () => {
  for (const id of cleanupUserIds) await deleteTestUser(id);
  cleanupUserIds = [];
});

describe("create_customer idempotency (real Data API)", () => {
  it("concurrent identical requests under the same creation_key produce exactly one customer", async () => {
    const { client, businessId, userId } = await createOwnerAndBusiness("cust-idem-concurrent");
    cleanupUserIds.push(userId);
    const key = randomUuid();

    const payload = {
      p_business_id: businessId,
      p_creation_key: key,
      p_name: "Concurrent Customer",
      p_phone: "0801234567",
    };

    const [a, b] = await Promise.all([
      client.rpc("create_customer", payload),
      client.rpc("create_customer", payload),
    ]);
    expect(a.error).toBeNull();
    expect(b.error).toBeNull();
    expect(a.data).toBe(b.data);

    const { data: rows } = await client.from("customers").select("id").eq("business_id", businessId);
    expect(rows).toHaveLength(1);
  });

  it("a different payload under the same creation_key is rejected (test J)", async () => {
    const { client, businessId, userId } = await createOwnerAndBusiness("cust-idem-conflict");
    cleanupUserIds.push(userId);
    const key = randomUuid();

    const first = await client.rpc("create_customer", {
      p_business_id: businessId,
      p_creation_key: key,
      p_name: "Original Name",
    });
    expect(first.error).toBeNull();

    const conflicting = await client.rpc("create_customer", {
      p_business_id: businessId,
      p_creation_key: key,
      p_name: "Different Name",
    });
    expect(conflicting.error).not.toBeNull();
    expect(conflicting.error?.message).toContain("CUSTOMER_IDEMPOTENCY_KEY_REUSED");

    // The original customer is untouched.
    const { data: original } = await client.from("customers").select("name").eq("id", first.data!).single();
    expect(original?.name).toBe("Original Name");

    const { data: rows } = await client.from("customers").select("id").eq("business_id", businessId);
    expect(rows).toHaveLength(1);
  });

  it("exact replay after the customer is later edited still resolves the original customer_id (test I)", async () => {
    const { client, businessId, userId } = await createOwnerAndBusiness("cust-idem-post-edit");
    cleanupUserIds.push(userId);
    const key = randomUuid();

    const payload = {
      p_business_id: businessId,
      p_creation_key: key,
      p_name: "Pre-Edit Name",
      p_phone: "0801111111",
    };

    const original = await client.rpc("create_customer", payload);
    expect(original.error).toBeNull();

    const { error: editError } = await client
      .from("customers")
      .update({ name: "Post-Edit Name", phone: "0802222222" })
      .eq("id", original.data!);
    expect(editError).toBeNull();

    const replay = await client.rpc("create_customer", payload);
    expect(replay.error).toBeNull();
    expect(replay.data).toBe(original.data);

    // The customer's live row reflects the edit — the replay did not
    // revert it or create a second row.
    const { data: rows } = await client.from("customers").select("id, name").eq("business_id", businessId);
    expect(rows).toHaveLength(1);
    expect(rows![0].name).toBe("Post-Edit Name");
  });

  it("create_customer's RPC response contains only the bare customer_id (test L)", async () => {
    const { client, businessId, userId } = await createOwnerAndBusiness("cust-narrow-return");
    cleanupUserIds.push(userId);

    const result = await client.rpc("create_customer", {
      p_business_id: businessId,
      p_creation_key: randomUuid(),
      p_name: "Narrow Return Customer",
    });
    expect(result.error).toBeNull();
    // A bare uuid, not an object/array — no accidental column leakage is
    // even structurally possible here.
    expect(typeof result.data).toBe("string");
    expect(result.data).toMatch(/^[0-9a-f-]{36}$/);
  });

  it("customers.manage is required; a caller without it is rejected", async () => {
    const { businessId, userId, client: ownerClient } = await createOwnerAndBusiness("cust-perm-denied");
    cleanupUserIds.push(userId);
    void ownerClient;

    const { createMemberWithRole } = await import("./helpers/inventory");
    const viewer = await createMemberWithRole(businessId, "cust-perm-denied", "VIEWER");
    cleanupUserIds.push(viewer.userId);

    const result = await viewer.client.rpc("create_customer", {
      p_business_id: businessId,
      p_creation_key: randomUuid(),
      p_name: "Should Not Be Created",
    });
    expect(result.error).not.toBeNull();
    expect(result.error?.message).toContain("insufficient_privilege");
  });

  it("two customers may share name/phone/email — no accidental uniqueness constraint", async () => {
    const { client, businessId, userId } = await createOwnerAndBusiness("cust-duplicates-allowed");
    cleanupUserIds.push(userId);

    const a = await client.rpc("create_customer", {
      p_business_id: businessId,
      p_creation_key: randomUuid(),
      p_name: "Same Name",
      p_phone: "0803333333",
      p_email: "same@example.test",
    });
    const b = await client.rpc("create_customer", {
      p_business_id: businessId,
      p_creation_key: randomUuid(),
      p_name: "Same Name",
      p_phone: "0803333333",
      p_email: "same@example.test",
    });
    expect(a.error).toBeNull();
    expect(b.error).toBeNull();
    expect(a.data).not.toBe(b.data);
  });
});
