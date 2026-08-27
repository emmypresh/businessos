import { describe, expect, it, afterEach } from "vitest";
import { deleteTestUser } from "./helpers/admin-client";
import { createTestDbClient } from "./helpers/db-client";
import { createOwnerAndBusiness, randomUuid } from "./helpers/inventory";

let cleanupUserIds: string[] = [];
afterEach(async () => {
  for (const id of cleanupUserIds) await deleteTestUser(id);
  cleanupUserIds = [];
});

/**
 * create_customer validates every input field against the EXACT same
 * rule the customers table's own CHECK constraints enforce, BEFORE the
 * INSERT — so an invalid value never reaches the database's own
 * constraint machinery, which (if hit directly) would return the
 * constraint name, SQLSTATE, and the full attempted row (business id,
 * generated customer id, created_by, timestamps, notes contents) through
 * PostgREST. That is not an acceptable public error boundary.
 */
describe("create_customer input validation (no raw CHECK constraint leak)", () => {
  it("test G: an invalid email returns a controlled error, not a raw CHECK violation", async () => {
    const { client, businessId, userId } = await createOwnerAndBusiness("cust-invalid-email");
    cleanupUserIds.push(userId);

    const result = await client.rpc("create_customer", {
      p_business_id: businessId,
      p_creation_key: randomUuid(),
      p_name: "Bad Email Customer",
      p_email: "not-an-email",
    });
    expect(result.error).not.toBeNull();
    expect(result.error?.message).toBe("INVALID_CUSTOMER_EMAIL");
    expect(result.error?.code).toBe("22023");

    // test I (part of the public error boundary check): the error must
    // never carry a constraint name, SQLSTATE 23514, or row detail —
    // PostgREST's shape for a controlled `raise exception ... using
    // errcode` is exactly { message, code, details, hint }, and details/
    // hint must be null/absent here, not populated with row contents.
    expect(result.error?.details).toBeFalsy();
    expect(result.error?.hint).toBeFalsy();
    expect(JSON.stringify(result.error)).not.toMatch(/customers_email_check|23514/);
    expect(JSON.stringify(result.error)).not.toContain(businessId);
  });

  it("test H: an invalid (too-long) phone returns a controlled error", async () => {
    const { client, businessId, userId } = await createOwnerAndBusiness("cust-invalid-phone");
    cleanupUserIds.push(userId);

    const result = await client.rpc("create_customer", {
      p_business_id: businessId,
      p_creation_key: randomUuid(),
      p_name: "Bad Phone Customer",
      p_phone: "0".repeat(33),
    });
    expect(result.error).not.toBeNull();
    expect(result.error?.message).toBe("INVALID_CUSTOMER_PHONE");
    expect(JSON.stringify(result.error)).not.toMatch(/customers_phone_check|23514/);
  });

  it("test I: an invalid (too-long) address returns a controlled error", async () => {
    const { client, businessId, userId } = await createOwnerAndBusiness("cust-invalid-address");
    cleanupUserIds.push(userId);

    const result = await client.rpc("create_customer", {
      p_business_id: businessId,
      p_creation_key: randomUuid(),
      p_name: "Bad Address Customer",
      p_address: "x".repeat(501),
    });
    expect(result.error).not.toBeNull();
    expect(result.error?.message).toBe("INVALID_CUSTOMER_ADDRESS");
    expect(JSON.stringify(result.error)).not.toMatch(/customers_address_check|23514/);
  });

  it("test J: invalid (too-long) notes return a controlled error", async () => {
    const { client, businessId, userId } = await createOwnerAndBusiness("cust-invalid-notes");
    cleanupUserIds.push(userId);

    const result = await client.rpc("create_customer", {
      p_business_id: businessId,
      p_creation_key: randomUuid(),
      p_name: "Bad Notes Customer",
      p_notes: "x".repeat(2001),
    });
    expect(result.error).not.toBeNull();
    expect(result.error?.message).toBe("INVALID_CUSTOMER_NOTES");
    expect(JSON.stringify(result.error)).not.toMatch(/customers_notes_check|23514/);
  });

  it("an invalid (too-short) name returns a controlled error", async () => {
    const { client, businessId, userId } = await createOwnerAndBusiness("cust-invalid-name");
    cleanupUserIds.push(userId);

    const result = await client.rpc("create_customer", {
      p_business_id: businessId,
      p_creation_key: randomUuid(),
      p_name: "x",
    });
    expect(result.error).not.toBeNull();
    expect(result.error?.message).toBe("INVALID_CUSTOMER_NAME");
  });

  it("test K: an invalid request creates no customer and no committed request-ledger claim", async () => {
    const { client, businessId, userId } = await createOwnerAndBusiness("cust-invalid-no-claim");
    cleanupUserIds.push(userId);
    const key = randomUuid();

    const failed = await client.rpc("create_customer", {
      p_business_id: businessId,
      p_creation_key: key,
      p_name: "Ok Name",
      p_email: "not-an-email",
    });
    expect(failed.error?.message).toBe("INVALID_CUSTOMER_EMAIL");

    const { data: customers } = await client.from("customers").select("id").eq("business_id", businessId);
    expect(customers).toHaveLength(0);

    // The request-ledger claim itself must have rolled back too — proven
    // by a successful retry under the SAME key (test L), and directly via
    // the raw DB client here (private.* is never reachable via the Data
    // API, so a direct check is the only way to confirm this without
    // relying solely on the retry's success as indirect evidence).
    const sql = createTestDbClient();
    try {
      const rows = await sql<{ n: string }[]>`
        select count(*)::text as n from private.customer_creation_requests
        where business_id = ${businessId} and creation_key = ${key}
      `;
      expect(Number(rows[0].n)).toBe(0);
    } finally {
      await sql.end();
    }
  });

  it("test L: retrying the same creation_key with corrected valid data succeeds", async () => {
    const { client, businessId, userId } = await createOwnerAndBusiness("cust-invalid-retry-corrected");
    cleanupUserIds.push(userId);
    const key = randomUuid();

    const failed = await client.rpc("create_customer", {
      p_business_id: businessId,
      p_creation_key: key,
      p_name: "Ok Name",
      p_email: "not-an-email",
    });
    expect(failed.error?.message).toBe("INVALID_CUSTOMER_EMAIL");

    const retried = await client.rpc("create_customer", {
      p_business_id: businessId,
      p_creation_key: key,
      p_name: "Ok Name",
      p_email: "ok@example.test",
    });
    expect(retried.error).toBeNull();

    const { data: customer } = await client.from("customers").select("name, email").eq("id", retried.data!).single();
    expect(customer?.name).toBe("Ok Name");
    expect(customer?.email).toBe("ok@example.test");
  });

  it("exact valid replay after a later customer edit still returns the original customer_id (unaffected by this hardening pass)", async () => {
    const { client, businessId, userId } = await createOwnerAndBusiness("cust-replay-after-edit");
    cleanupUserIds.push(userId);
    const key = randomUuid();
    const payload = {
      p_business_id: businessId, p_creation_key: key,
      p_name: "Pre-Edit", p_email: "pre@example.test",
    };

    const original = await client.rpc("create_customer", payload);
    expect(original.error).toBeNull();

    await client.from("customers").update({ name: "Post-Edit", email: "post@example.test" }).eq("id", original.data!);

    const replay = await client.rpc("create_customer", payload);
    expect(replay.error).toBeNull();
    expect(replay.data).toBe(original.data);
  });

  it("test M: the table's own CHECK constraints still reject malformed input via direct raw SQL (structural backstop intact)", async () => {
    const { businessId, userId } = await createOwnerAndBusiness("cust-check-backstop");
    cleanupUserIds.push(userId);
    const sql = createTestDbClient();
    try {
      await expect(
        sql`insert into public.customers (business_id, name, email, created_by)
            values (${businessId}, 'Direct SQL Customer', 'not-an-email', ${userId})`
      ).rejects.toThrow();
      await expect(
        sql`insert into public.customers (business_id, name, created_by)
            values (${businessId}, 'x', ${userId})`
      ).rejects.toThrow();
    } finally {
      await sql.end();
    }
  });
});
