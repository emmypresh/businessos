import { describe, expect, it, afterEach } from "vitest";
import { createConfirmedTestUser, createUserClient, deleteTestUser } from "./helpers/admin-client";
import { createOwnerAndBusiness, addMemberWithRole } from "./helpers/inventory";
import { createTestDbClient } from "./helpers/db-client";

let cleanupUserIds: string[] = [];
afterEach(async () => {
  for (const id of cleanupUserIds) await deleteTestUser(id);
  cleanupUserIds = [];
});

async function signedInClient(prefix: string) {
  const email = `${prefix}-${Date.now()}@example.test`;
  const user = await createConfirmedTestUser(email, "Password1234");
  const client = createUserClient();
  await client.auth.signInWithPassword({ email, password: "Password1234" });
  return { client, userId: user.id as string };
}

describe("business_categories registry", () => {
  it("an authenticated user can list the seeded catalog, including OTHER and inactive rows", async () => {
    const { client, userId } = await signedInClient("cat-read");
    cleanupUserIds.push(userId);

    const { data, error } = await client.from("business_categories").select("code, is_active");
    expect(error).toBeNull();
    const codes = (data ?? []).map((row) => row.code);
    expect(codes).toContain("RETAIL");
    expect(codes).toContain("OTHER");
    expect(codes.length).toBeGreaterThanOrEqual(14);
  });

  it("a tenant cannot insert a new category (no grant/policy for authenticated)", async () => {
    const { client, userId } = await signedInClient("cat-insert");
    cleanupUserIds.push(userId);

    const { error } = await client
      .from("business_categories")
      .insert({ code: "ROGUE", name: "Rogue Category" });
    expect(error).not.toBeNull();
  });

  it("a tenant cannot update an existing category", async () => {
    const { client, userId } = await signedInClient("cat-update");
    cleanupUserIds.push(userId);

    const { data: rows } = await client.from("business_categories").select("id").eq("code", "RETAIL");
    const retailId = rows?.[0]?.id ?? "00000000-0000-0000-0000-000000000000";
    const { error } = await client
      .from("business_categories")
      .update({ name: "Hacked" })
      .eq("id", retailId);
    expect(error).not.toBeNull();
  });

  it("a tenant cannot delete a category", async () => {
    const { client, userId } = await signedInClient("cat-delete");
    cleanupUserIds.push(userId);

    const { data: rows } = await client.from("business_categories").select("id").eq("code", "RETAIL");
    const retailId = rows?.[0]?.id ?? "00000000-0000-0000-0000-000000000000";
    const { error } = await client.from("business_categories").delete().eq("id", retailId);
    expect(error).not.toBeNull();
  });

  it("an unauthenticated caller cannot read the catalog", async () => {
    const client = createUserClient();
    const { error } = await client.from("business_categories").select("code");
    expect(error).not.toBeNull();
  });
});

describe("create_business category requirement", () => {
  it("rejects a call with p_category_code omitted", async () => {
    const { client, userId } = await signedInClient("cat-missing");
    cleanupUserIds.push(userId);

    const { error } = await client.rpc("create_business", {
      p_name: "No Category Co",
      p_slug: `no-category-${Date.now()}`,
    });
    expect(error).not.toBeNull();
  });

  it("rejects a call with a blank p_category_code", async () => {
    const { client, userId } = await signedInClient("cat-blank");
    cleanupUserIds.push(userId);

    const { error } = await client.rpc("create_business", {
      p_name: "Blank Category Co",
      p_slug: `blank-category-${Date.now()}`,
      p_category_code: "   ",
    });
    expect(error).not.toBeNull();
  });
});

describe("legacy null-category business compatibility", () => {
  it("a pre-migration row with primary_category_id = NULL remains readable and usable", async () => {
    const { client, businessId, userId } = await createOwnerAndBusiness("cat-legacy");
    cleanupUserIds.push(userId);

    // create_business itself can no longer produce a null-category row (it
    // now requires a valid category), so a genuine legacy row is simulated
    // by writing directly to the table, exactly as a pre-1Q-A business
    // would already exist in production.
    const sql = createTestDbClient();
    try {
      await sql`update public.businesses set primary_category_id = null, custom_category_label = null where id = ${businessId}`;
    } finally {
      await sql.end();
    }

    const { data, error } = await client
      .from("businesses")
      .select("id, name, primary_category_id, custom_category_label")
      .eq("id", businessId)
      .single();
    expect(error).toBeNull();
    expect(data?.primary_category_id).toBeNull();
    expect(data?.custom_category_label).toBeNull();

    // Normal tenant authorization is unaffected by a null category: the
    // owner can still update the business's category going forward.
    const { error: updateError } = await client.rpc("update_business_category", {
      p_business_id: businessId,
      p_category_code: "SERVICES",
    });
    expect(updateError).toBeNull();
  });
});

describe("create_business category selection", () => {
  it("a valid category code resolves to the registry row's id", async () => {
    const { client, userId } = await signedInClient("cat-valid");
    cleanupUserIds.push(userId);

    const { data, error } = await client.rpc("create_business", {
      p_name: "Retail Co",
      p_slug: `retail-co-${Date.now()}`,
      p_category_code: "retail",
    });
    expect(error).toBeNull();

    const { data: category } = await client
      .from("business_categories")
      .select("id")
      .eq("code", "RETAIL")
      .single();
    expect(data?.primary_category_id).toBe(category?.id);
  });

  it("rejects an unknown category code", async () => {
    const { client, userId } = await signedInClient("cat-unknown");
    cleanupUserIds.push(userId);

    const { error } = await client.rpc("create_business", {
      p_name: "Bad Category Co",
      p_slug: `bad-category-${Date.now()}`,
      p_category_code: "NOT_A_REAL_CATEGORY",
    });
    expect(error).not.toBeNull();
  });

  it("OTHER without a custom label is rejected", async () => {
    const { client, userId } = await signedInClient("cat-other-missing");
    cleanupUserIds.push(userId);

    const { error } = await client.rpc("create_business", {
      p_name: "Other Co",
      p_slug: `other-co-${Date.now()}`,
      p_category_code: "OTHER",
    });
    expect(error).not.toBeNull();
  });

  it("OTHER with a valid custom label persists it", async () => {
    const { client, userId } = await signedInClient("cat-other-ok");
    cleanupUserIds.push(userId);

    const { data, error } = await client.rpc("create_business", {
      p_name: "Other Co 2",
      p_slug: `other-co-2-${Date.now()}`,
      p_category_code: "OTHER",
      p_custom_category_label: "Artisan cheese subscriptions",
    });
    expect(error).toBeNull();
    expect(data?.custom_category_label).toBe("Artisan cheese subscriptions");
  });

  it("a non-OTHER category ignores a supplied custom label (never stores it)", async () => {
    const { client, userId } = await signedInClient("cat-ignore-label");
    cleanupUserIds.push(userId);

    const { data, error } = await client.rpc("create_business", {
      p_name: "Ignore Label Co",
      p_slug: `ignore-label-${Date.now()}`,
      p_category_code: "RETAIL",
      p_custom_category_label: "Should be ignored",
    });
    expect(error).toBeNull();
    expect(data?.custom_category_label).toBeNull();
  });

  it("rejects a deactivated category", async () => {
    const sql = createTestDbClient();
    try {
      await sql`insert into public.business_categories (code, name, is_active, sort_order) values ('DEACTIVATED_TEST', 'Deactivated', false, 500)`;
    } finally {
      await sql.end();
    }

    const { client, userId } = await signedInClient("cat-deactivated");
    cleanupUserIds.push(userId);

    const { error } = await client.rpc("create_business", {
      p_name: "Deactivated Co",
      p_slug: `deactivated-co-${Date.now()}`,
      p_category_code: "DEACTIVATED_TEST",
    });
    expect(error).not.toBeNull();

    const sql2 = createTestDbClient();
    try {
      await sql2`delete from public.business_categories where code = 'DEACTIVATED_TEST'`;
    } finally {
      await sql2.end();
    }
  });
});

describe("update_business_category authorization", () => {
  it("an OWNER (business.manage) can change the category", async () => {
    const { client, businessId, userId } = await createOwnerAndBusiness("cat-owner-update");
    cleanupUserIds.push(userId);

    const { error } = await client.rpc("update_business_category", {
      p_business_id: businessId,
      p_category_code: "SERVICES",
    });
    expect(error).toBeNull();

    const { data } = await client
      .from("businesses")
      .select("primary_category_id")
      .eq("id", businessId)
      .single();
    expect(data?.primary_category_id).not.toBeNull();
  });

  it("a VIEWER (no business.manage) is denied", async () => {
    const { businessId, userId: ownerId } = await createOwnerAndBusiness("cat-viewer-owner");
    const { client: viewerClient, userId: viewerId } = await signedInClient("cat-viewer-member");
    cleanupUserIds.push(ownerId, viewerId);
    await addMemberWithRole(businessId, viewerId, "VIEWER");

    const { error } = await viewerClient.rpc("update_business_category", {
      p_business_id: businessId,
      p_category_code: "SERVICES",
    });
    expect(error).not.toBeNull();
  });

  it("a member of a DIFFERENT business cannot update this business's category (cross-tenant)", async () => {
    const { businessId, userId: ownerId } = await createOwnerAndBusiness("cat-cross-owner");
    const { client: outsiderClient, userId: outsiderId } = await createOwnerAndBusiness("cat-cross-outsider");
    cleanupUserIds.push(ownerId, outsiderId);

    const { error } = await outsiderClient.rpc("update_business_category", {
      p_business_id: businessId,
      p_category_code: "SERVICES",
    });
    expect(error).not.toBeNull();
  });

  it("rejects switching to OTHER without a custom label", async () => {
    const { client, businessId, userId } = await createOwnerAndBusiness("cat-update-other-missing");
    cleanupUserIds.push(userId);

    const { error } = await client.rpc("update_business_category", {
      p_business_id: businessId,
      p_category_code: "OTHER",
    });
    expect(error).not.toBeNull();
  });

  it("rejects reassigning to a deactivated category (Phase 1Q-A LOW follow-up)", async () => {
    const sql = createTestDbClient();
    try {
      await sql`insert into public.business_categories (code, name, is_active, sort_order) values ('DEACTIVATED_TEST_UPDATE', 'Deactivated Update', false, 501)`;
    } finally {
      await sql.end();
    }

    const { client, businessId, userId } = await createOwnerAndBusiness("cat-update-deactivated");
    cleanupUserIds.push(userId);

    try {
      const { error } = await client.rpc("update_business_category", {
        p_business_id: businessId,
        p_category_code: "DEACTIVATED_TEST_UPDATE",
      });
      expect(error).not.toBeNull();
    } finally {
      const sql2 = createTestDbClient();
      try {
        await sql2`delete from public.business_categories where code = 'DEACTIVATED_TEST_UPDATE'`;
      } finally {
        await sql2.end();
      }
    }
  });

  it("records a business.category_updated audit event", async () => {
    const { client, businessId, userId } = await createOwnerAndBusiness("cat-audit");
    cleanupUserIds.push(userId);

    await client.rpc("update_business_category", {
      p_business_id: businessId,
      p_category_code: "MANUFACTURING",
    });

    const sql = createTestDbClient();
    try {
      const rows = await sql<{ action: string }[]>`
        select action from public.audit_events
        where business_id = ${businessId} and action = 'business.category_updated'
      `;
      expect(rows.length).toBe(1);
    } finally {
      await sql.end();
    }
  });
});
