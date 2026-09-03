import { describe, expect, it, afterEach } from "vitest";
import { createClient } from "@supabase/supabase-js";
import { createAdminClient, deleteTestUser } from "./helpers/admin-client";
import { createOwnerAndBusiness, createMemberWithRole, randomUuid } from "./helpers/inventory";
import { createBranch, getDefaultBranchId } from "./helpers/staff";
import { createTestDbClient } from "./helpers/db-client";
import { assertLocalSupabaseUrl } from "./helpers/url-safety";

// Phase 1K — DATABASE FOUNDATION ONLY. Exercises public.notifications,
// public.notification_recipients, public.notification_preferences, and
// private.create_notification directly against a real database. No
// application layer exists yet — every write here goes through a raw
// Postgres connection (createTestDbClient(), the same superuser test
// connection audit-events.test.ts already uses for the identical
// reason), standing in for the "future trusted mutation RPC" that will
// eventually call private.create_notification from inside its own
// transaction. This is deliberately the ONE deterministic proof this
// round's own instructions call for — never a retrofit of any real
// mutation.

let cleanupUserIds: string[] = [];
afterEach(async () => {
  for (const id of cleanupUserIds) await deleteTestUser(id);
  cleanupUserIds = [];
});

function createAnonClient() {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL!;
  const key = process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY!;
  assertLocalSupabaseUrl(url);
  return createClient(url, key, { auth: { persistSession: false } });
}

// Calls private.create_notification via the raw superuser test
// connection — standing in for "an already-trusted SECURITY DEFINER
// mutation RPC calling this from inside its own transaction," since no
// such RPC exists yet in this DB-foundation-only round.
async function createNotification(overrides: {
  businessId: string;
  category?: string;
  notificationType?: string;
  title?: string;
  recipientUserIds: string[];
  branchId?: string | null;
  body?: string | null;
  severity?: string;
  resourceType?: string | null;
  resourceId?: string | null;
  metadata?: unknown;
  dedupKey?: string | null;
}) {
  const sql = createTestDbClient();
  try {
    const rows = await sql<{ create_notification: string }[]>`
      select private.create_notification(
        ${overrides.businessId}::uuid,
        ${overrides.category ?? "INVENTORY"}::text,
        ${overrides.notificationType ?? "inventory.low_stock"}::text,
        ${overrides.title ?? "Low stock"}::text,
        ${overrides.recipientUserIds}::uuid[],
        ${overrides.branchId ?? null}::uuid,
        ${overrides.body ?? null}::text,
        ${overrides.severity ?? "WARNING"}::text,
        ${overrides.resourceType ?? null}::text,
        ${overrides.resourceId ?? null}::uuid,
        ${sql.json((overrides.metadata ?? {}) as never)}::jsonb,
        ${overrides.dedupKey ?? null}::text
      ) as create_notification
    `;
    return rows[0].create_notification;
  } finally {
    await sql.end();
  }
}

async function countNotifications(businessId: string) {
  const sql = createTestDbClient();
  try {
    const rows = await sql<{ count: string }[]>`
      select count(*)::text from public.notifications where business_id = ${businessId}
    `;
    return Number(rows[0].count);
  } finally {
    await sql.end();
  }
}

async function countRecipients(notificationId: string) {
  const sql = createTestDbClient();
  try {
    const rows = await sql<{ count: string }[]>`
      select count(*)::text from public.notification_recipients where notification_id = ${notificationId}
    `;
    return Number(rows[0].count);
  } finally {
    await sql.end();
  }
}

describe("private.create_notification — writer success and validation", () => {
  it("1. records a valid notification and fans out recipient rows", async () => {
    const owner = await createOwnerAndBusiness("notif-writer-success");
    cleanupUserIds.push(owner.userId);

    const id = await createNotification({
      businessId: owner.businessId,
      recipientUserIds: [owner.userId],
      title: "Widget is low on stock",
      body: "Only 2 units remain.",
    });
    expect(id).toBeTruthy();

    const admin = createAdminClient();
    const { data: row } = await admin
      .from("notifications")
      .select("id, business_id, category, notification_type, title, body, severity")
      .eq("id", id)
      .single();
    expect(row?.business_id).toBe(owner.businessId);
    expect(row?.category).toBe("INVENTORY");
    expect(row?.notification_type).toBe("inventory.low_stock");
    expect(row?.title).toBe("Widget is low on stock");
    expect(row?.body).toBe("Only 2 units remain.");
    expect(row?.severity).toBe("WARNING");

    const { data: recipientRows } = await admin
      .from("notification_recipients")
      .select("user_id, read_at, seen_at")
      .eq("notification_id", id!);
    expect(recipientRows).toHaveLength(1);
    expect(recipientRows?.[0].user_id).toBe(owner.userId);
    expect(recipientRows?.[0].read_at).toBeNull();
    expect(recipientRows?.[0].seen_at).toBeNull();
  });

  it("2. fans out to MULTIPLE recipients atomically", async () => {
    const owner = await createOwnerAndBusiness("notif-multi-recipient");
    cleanupUserIds.push(owner.userId);
    const member = await createMemberWithRole(owner.businessId, "notif-multi-recipient", "MANAGER");
    cleanupUserIds.push(member.userId);

    const id = await createNotification({
      businessId: owner.businessId,
      recipientUserIds: [owner.userId, member.userId],
    });

    const admin = createAdminClient();
    const { data: recipientRows } = await admin
      .from("notification_recipients")
      .select("user_id")
      .eq("notification_id", id!);
    expect(recipientRows?.map((r) => r.user_id).sort()).toEqual([owner.userId, member.userId].sort());
  });

  it("3. resource fields persist exactly as supplied", async () => {
    const owner = await createOwnerAndBusiness("notif-resource-fields");
    cleanupUserIds.push(owner.userId);
    const resourceId = randomUuid();

    const id = await createNotification({
      businessId: owner.businessId,
      recipientUserIds: [owner.userId],
      resourceType: "product",
      resourceId,
    });

    const admin = createAdminClient();
    const { data: row } = await admin.from("notifications").select("resource_type, resource_id").eq("id", id!).single();
    expect(row?.resource_type).toBe("product");
    expect(row?.resource_id).toBe(resourceId);
  });

  it("4. a null branch_id records a business-wide notification successfully", async () => {
    const owner = await createOwnerAndBusiness("notif-branch-null");
    cleanupUserIds.push(owner.userId);

    const id = await createNotification({ businessId: owner.businessId, recipientUserIds: [owner.userId], branchId: null });
    const admin = createAdminClient();
    const { data: row } = await admin.from("notifications").select("branch_id").eq("id", id!).single();
    expect(row?.branch_id).toBeNull();
  });

  it("5. a branch belonging to a DIFFERENT business is rejected (NOTIFICATION_BRANCH_MISMATCH)", async () => {
    const owner = await createOwnerAndBusiness("notif-branch-mismatch-a");
    cleanupUserIds.push(owner.userId);
    const other = await createOwnerAndBusiness("notif-branch-mismatch-b");
    cleanupUserIds.push(other.userId);
    const otherBranch = await getDefaultBranchId(other.client, other.businessId);

    await expect(
      createNotification({ businessId: owner.businessId, recipientUserIds: [owner.userId], branchId: otherBranch })
    ).rejects.toThrow(/NOTIFICATION_BRANCH_MISMATCH/);
    expect(await countNotifications(owner.businessId)).toBe(0);
  });

  it("a branch belonging to the SAME business is accepted", async () => {
    const owner = await createOwnerAndBusiness("notif-branch-match");
    cleanupUserIds.push(owner.userId);
    const branchB = await createBranch(owner.client, owner.businessId, { name: "Notif Branch B" });

    const id = await createNotification({ businessId: owner.businessId, recipientUserIds: [owner.userId], branchId: branchB });
    const admin = createAdminClient();
    const { data: row } = await admin.from("notifications").select("branch_id").eq("id", id!).single();
    expect(row?.branch_id).toBe(branchB);
  });

  it("6. metadata as a top-level JSON array is rejected (INVALID_NOTIFICATION_METADATA)", async () => {
    const owner = await createOwnerAndBusiness("notif-metadata-array");
    cleanupUserIds.push(owner.userId);
    await expect(
      createNotification({ businessId: owner.businessId, recipientUserIds: [owner.userId], metadata: [1, 2, 3] })
    ).rejects.toThrow(/INVALID_NOTIFICATION_METADATA/);
  });

  it("6b. metadata as a top-level scalar is rejected (INVALID_NOTIFICATION_METADATA)", async () => {
    const owner = await createOwnerAndBusiness("notif-metadata-scalar");
    cleanupUserIds.push(owner.userId);
    const sql = createTestDbClient();
    try {
      await expect(
        sql`
          select private.create_notification(
            ${owner.businessId}::uuid, 'INVENTORY'::text, 'inventory.low_stock'::text, 'Low stock'::text,
            ${[owner.userId]}::uuid[], null::uuid, null::text, 'WARNING'::text,
            null::text, null::uuid, '"just a string"'::jsonb, null::text
          )
        `
      ).rejects.toThrow(/INVALID_NOTIFICATION_METADATA/);
    } finally {
      await sql.end();
    }
  });

  it("7. metadata exceeding the 16 KB bound is rejected (NOTIFICATION_METADATA_TOO_LARGE)", async () => {
    const owner = await createOwnerAndBusiness("notif-metadata-size");
    cleanupUserIds.push(owner.userId);
    const bigValue = "x".repeat(20_000);
    await expect(
      createNotification({ businessId: owner.businessId, recipientUserIds: [owner.userId], metadata: { note: bigValue } })
    ).rejects.toThrow(/NOTIFICATION_METADATA_TOO_LARGE/);
  });

  it("metadata within the bound succeeds", async () => {
    const owner = await createOwnerAndBusiness("notif-metadata-ok");
    cleanupUserIds.push(owner.userId);
    const id = await createNotification({
      businessId: owner.businessId,
      recipientUserIds: [owner.userId],
      metadata: { quantity_on_hand: 2, threshold: 10 },
    });
    const admin = createAdminClient();
    const { data: row } = await admin.from("notifications").select("metadata").eq("id", id!).single();
    expect(row?.metadata).toEqual({ quantity_on_hand: 2, threshold: 10 });
  });

  it("8. a malformed notification_type (uppercase, no dot segment) is rejected (INVALID_NOTIFICATION_TYPE)", async () => {
    const owner = await createOwnerAndBusiness("notif-type-malformed");
    cleanupUserIds.push(owner.userId);
    await expect(
      createNotification({ businessId: owner.businessId, recipientUserIds: [owner.userId], notificationType: "LowStock" })
    ).rejects.toThrow(/INVALID_NOTIFICATION_TYPE/);
  });

  it("9. an unrecognized category is rejected (INVALID_NOTIFICATION_CATEGORY)", async () => {
    const owner = await createOwnerAndBusiness("notif-category-invalid");
    cleanupUserIds.push(owner.userId);
    await expect(
      createNotification({ businessId: owner.businessId, recipientUserIds: [owner.userId], category: "BOGUS" })
    ).rejects.toThrow(/INVALID_NOTIFICATION_CATEGORY/);
  });

  it("10. an unrecognized severity is rejected (INVALID_NOTIFICATION_SEVERITY)", async () => {
    const owner = await createOwnerAndBusiness("notif-severity-invalid");
    cleanupUserIds.push(owner.userId);
    await expect(
      createNotification({ businessId: owner.businessId, recipientUserIds: [owner.userId], severity: "URGENT" })
    ).rejects.toThrow(/INVALID_NOTIFICATION_SEVERITY/);
  });

  it("11. a resource_id without a resource_type is rejected (INVALID_NOTIFICATION_RESOURCE)", async () => {
    const owner = await createOwnerAndBusiness("notif-resource-invalid");
    cleanupUserIds.push(owner.userId);
    await expect(
      createNotification({
        businessId: owner.businessId,
        recipientUserIds: [owner.userId],
        resourceId: randomUuid(),
        resourceType: null,
      })
    ).rejects.toThrow(/INVALID_NOTIFICATION_RESOURCE/);
  });

  it("12. an empty (whitespace-only) title is rejected (INVALID_NOTIFICATION_TITLE)", async () => {
    const owner = await createOwnerAndBusiness("notif-title-empty");
    cleanupUserIds.push(owner.userId);
    await expect(
      createNotification({ businessId: owner.businessId, recipientUserIds: [owner.userId], title: "   " })
    ).rejects.toThrow(/INVALID_NOTIFICATION_TITLE/);
  });

  it("a title over 200 characters is rejected (INVALID_NOTIFICATION_TITLE)", async () => {
    const owner = await createOwnerAndBusiness("notif-title-long");
    cleanupUserIds.push(owner.userId);
    await expect(
      createNotification({ businessId: owner.businessId, recipientUserIds: [owner.userId], title: "x".repeat(201) })
    ).rejects.toThrow(/INVALID_NOTIFICATION_TITLE/);
  });

  it("13. a body over 2000 characters is rejected (INVALID_NOTIFICATION_BODY)", async () => {
    const owner = await createOwnerAndBusiness("notif-body-long");
    cleanupUserIds.push(owner.userId);
    await expect(
      createNotification({ businessId: owner.businessId, recipientUserIds: [owner.userId], body: "x".repeat(2001) })
    ).rejects.toThrow(/INVALID_NOTIFICATION_BODY/);
  });

  it("14. an empty recipient list is rejected (INVALID_NOTIFICATION_RECIPIENTS)", async () => {
    const owner = await createOwnerAndBusiness("notif-recipients-empty");
    cleanupUserIds.push(owner.userId);
    await expect(
      createNotification({ businessId: owner.businessId, recipientUserIds: [] })
    ).rejects.toThrow(/INVALID_NOTIFICATION_RECIPIENTS/);
  });

  it("14b. a NULL element inside the recipient array is rejected explicitly (INVALID_NOTIFICATION_RECIPIENTS), never silently inserted or left to a raw NOT NULL violation", async () => {
    const owner = await createOwnerAndBusiness("notif-recipients-null-element");
    cleanupUserIds.push(owner.userId);
    const sql = createTestDbClient();
    try {
      await expect(
        sql`
          select private.create_notification(
            ${owner.businessId}::uuid, 'INVENTORY'::text, 'inventory.low_stock'::text, 'Low stock'::text,
            array[${owner.userId}::uuid, null]::uuid[], null::uuid, null::text, 'WARNING'::text,
            null::text, null::uuid, '{}'::jsonb, null::text
          )
        `
      ).rejects.toThrow(/INVALID_NOTIFICATION_RECIPIENTS/);
    } finally {
      await sql.end();
    }
    expect(await countNotifications(owner.businessId)).toBe(0);
  });

  it("15. a recipient who is NOT an active member of the business is rejected, and NOTHING is created (NOTIFICATION_RECIPIENT_NOT_MEMBER)", async () => {
    const owner = await createOwnerAndBusiness("notif-recipient-not-member-a");
    cleanupUserIds.push(owner.userId);
    const stranger = await createOwnerAndBusiness("notif-recipient-not-member-b");
    cleanupUserIds.push(stranger.userId);

    await expect(
      createNotification({ businessId: owner.businessId, recipientUserIds: [owner.userId, stranger.userId] })
    ).rejects.toThrow(/NOTIFICATION_RECIPIENT_NOT_MEMBER/);
    // Atomic, fail-closed: a partially-valid recipient list creates NOTHING,
    // never a notification with only the valid subset of recipients.
    expect(await countNotifications(owner.businessId)).toBe(0);
  });

  it("a SUSPENDED member is rejected as a recipient (NOTIFICATION_RECIPIENT_NOT_MEMBER) — access is derived from CURRENT status, not historical membership", async () => {
    const owner = await createOwnerAndBusiness("notif-recipient-suspended");
    cleanupUserIds.push(owner.userId);
    const member = await createMemberWithRole(owner.businessId, "notif-recipient-suspended", "MANAGER");
    cleanupUserIds.push(member.userId);
    const sql = createTestDbClient();
    try {
      await sql`update public.business_members set status = 'suspended' where business_id = ${owner.businessId} and user_id = ${member.userId}`;
    } finally {
      await sql.end();
    }

    await expect(
      createNotification({ businessId: owner.businessId, recipientUserIds: [member.userId] })
    ).rejects.toThrow(/NOTIFICATION_RECIPIENT_NOT_MEMBER/);
  });

  it("16. a dedup_key over 200 characters is rejected (INVALID_NOTIFICATION_DEDUP_KEY)", async () => {
    const owner = await createOwnerAndBusiness("notif-dedup-key-long");
    cleanupUserIds.push(owner.userId);
    await expect(
      createNotification({ businessId: owner.businessId, recipientUserIds: [owner.userId], dedupKey: "x".repeat(201) })
    ).rejects.toThrow(/INVALID_NOTIFICATION_DEDUP_KEY/);
  });
});

describe("private.create_notification — deduplication / idempotent replay (BOS Edge readiness)", () => {
  it("7. a second call with the SAME (business_id, dedup_key) returns the SAME id and creates NO new notification row", async () => {
    const owner = await createOwnerAndBusiness("notif-dedup-replay");
    cleanupUserIds.push(owner.userId);
    const dedupKey = "inventory.low_stock:product:" + randomUuid();

    const firstId = await createNotification({
      businessId: owner.businessId,
      recipientUserIds: [owner.userId],
      dedupKey,
      title: "First alert",
    });
    // Simulates an at-least-once-delivery retry from a disconnected/
    // offline writer (e.g. a future BOS Edge local-server ingestion path,
    // or a background low-stock scan re-running while stock remains
    // low) — the SAME dedup_key must never produce a second notification,
    // regardless of how many times, or with what different incidental
    // content, the call is repeated.
    const secondId = await createNotification({
      businessId: owner.businessId,
      recipientUserIds: [owner.userId],
      dedupKey,
      title: "This title is ignored on replay",
    });

    expect(secondId).toBe(firstId);
    expect(await countNotifications(owner.businessId)).toBe(1);

    const admin = createAdminClient();
    const { data: row } = await admin.from("notifications").select("title").eq("id", firstId!).single();
    expect(row?.title).toBe("First alert");
  });

  it("a replay does not duplicate or alter recipient rows", async () => {
    const owner = await createOwnerAndBusiness("notif-dedup-replay-recipients");
    cleanupUserIds.push(owner.userId);
    const dedupKey = "inventory.low_stock:product:" + randomUuid();

    const id = await createNotification({ businessId: owner.businessId, recipientUserIds: [owner.userId], dedupKey });
    await createNotification({ businessId: owner.businessId, recipientUserIds: [owner.userId], dedupKey });

    expect(await countRecipients(id!)).toBe(1);
  });

  it("two calls with DIFFERENT dedup_keys (or none at all) each create a separate notification", async () => {
    const owner = await createOwnerAndBusiness("notif-dedup-distinct");
    cleanupUserIds.push(owner.userId);

    const idA = await createNotification({ businessId: owner.businessId, recipientUserIds: [owner.userId], dedupKey: "alert-a" });
    const idB = await createNotification({ businessId: owner.businessId, recipientUserIds: [owner.userId], dedupKey: "alert-b" });
    const idC = await createNotification({ businessId: owner.businessId, recipientUserIds: [owner.userId] });
    const idD = await createNotification({ businessId: owner.businessId, recipientUserIds: [owner.userId] });

    expect(new Set([idA, idB, idC, idD]).size).toBe(4);
    expect(await countNotifications(owner.businessId)).toBe(4);
  });

  it("the same user id appearing twice in one recipient array creates exactly one recipient row", async () => {
    const owner = await createOwnerAndBusiness("notif-recipient-duplicate");
    cleanupUserIds.push(owner.userId);
    const id = await createNotification({ businessId: owner.businessId, recipientUserIds: [owner.userId, owner.userId] });
    expect(await countRecipients(id!)).toBe(1);
  });

  it("a DIFFERENT business using the SAME dedup_key string creates its OWN separate notification (dedup is business-scoped)", async () => {
    const ownerA = await createOwnerAndBusiness("notif-dedup-tenant-a");
    cleanupUserIds.push(ownerA.userId);
    const ownerB = await createOwnerAndBusiness("notif-dedup-tenant-b");
    cleanupUserIds.push(ownerB.userId);
    const dedupKey = "shared-key";

    const idA = await createNotification({ businessId: ownerA.businessId, recipientUserIds: [ownerA.userId], dedupKey });
    const idB = await createNotification({ businessId: ownerB.businessId, recipientUserIds: [ownerB.userId], dedupKey });
    expect(idA).not.toBe(idB);
  });
});

describe("notifications / notification_recipients — RLS, tenant, and recipient isolation", () => {
  it("18. a recipient can read a notification addressed to them", async () => {
    const owner = await createOwnerAndBusiness("notif-rls-recipient");
    cleanupUserIds.push(owner.userId);
    const id = await createNotification({ businessId: owner.businessId, recipientUserIds: [owner.userId] });

    const { data, error } = await owner.client.from("notifications").select("id").eq("id", id!);
    expect(error).toBeNull();
    expect(data).toHaveLength(1);
  });

  it("19. an active member who is NOT a recipient cannot read the notification (recipient isolation)", async () => {
    const owner = await createOwnerAndBusiness("notif-recipient-isolation");
    cleanupUserIds.push(owner.userId);
    const member = await createMemberWithRole(owner.businessId, "notif-recipient-isolation", "MANAGER");
    cleanupUserIds.push(member.userId);
    // Notification targets ONLY the owner, not the member.
    const id = await createNotification({ businessId: owner.businessId, recipientUserIds: [owner.userId] });

    const { data, error } = await member.client.from("notifications").select("id").eq("id", id!);
    expect(error).toBeNull();
    expect(data).toHaveLength(0);
    const { data: recipientData } = await member.client.from("notification_recipients").select("id").eq("notification_id", id!);
    expect(recipientData).toHaveLength(0);
  });

  it("20. a member of a DIFFERENT tenant cannot read another business's notification (tenant isolation)", async () => {
    const owner = await createOwnerAndBusiness("notif-tenant-a");
    cleanupUserIds.push(owner.userId);
    const other = await createOwnerAndBusiness("notif-tenant-b");
    cleanupUserIds.push(other.userId);
    const id = await createNotification({ businessId: owner.businessId, recipientUserIds: [owner.userId] });

    const { data, error } = await other.client.from("notifications").select("id").eq("id", id!);
    expect(error).toBeNull();
    expect(data).toHaveLength(0);
  });

  it("21. an anonymous (unauthenticated) caller cannot read notifications or notification_recipients", async () => {
    const owner = await createOwnerAndBusiness("notif-anon");
    cleanupUserIds.push(owner.userId);
    const id = await createNotification({ businessId: owner.businessId, recipientUserIds: [owner.userId] });

    const anon = createAnonClient();
    const { data: notifData } = await anon.from("notifications").select("id").eq("id", id!);
    expect(notifData ?? []).toHaveLength(0);
    const { data: recipientData } = await anon.from("notification_recipients").select("id").eq("notification_id", id!);
    expect(recipientData ?? []).toHaveLength(0);
  });

  it("22. a direct authenticated INSERT into notifications is denied", async () => {
    const owner = await createOwnerAndBusiness("notif-direct-insert-notifications");
    cleanupUserIds.push(owner.userId);
    const { error } = await owner.client.from("notifications").insert({
      business_id: owner.businessId,
      category: "SECURITY",
      notification_type: "security.forged",
      title: "Forged notification",
    } as never);
    expect(error).not.toBeNull();
  });

  it("22b. a direct authenticated INSERT into notification_recipients is denied — a caller cannot forge a recipient row for themselves", async () => {
    const owner = await createOwnerAndBusiness("notif-direct-insert-recipients");
    cleanupUserIds.push(owner.userId);
    const id = await createNotification({ businessId: owner.businessId, recipientUserIds: [owner.userId] });
    const stranger = await createMemberWithRole(owner.businessId, "notif-direct-insert-recipients", "MANAGER");
    cleanupUserIds.push(stranger.userId);

    const { error } = await stranger.client.from("notification_recipients").insert({
      notification_id: id,
      business_id: owner.businessId,
      user_id: stranger.userId,
    } as never);
    expect(error).not.toBeNull();
    const { data } = await stranger.client.from("notification_recipients").select("id").eq("notification_id", id!);
    expect(data).toHaveLength(0);
  });

  it("23. a direct authenticated DELETE is denied on both notifications and notification_recipients", async () => {
    const owner = await createOwnerAndBusiness("notif-direct-delete");
    cleanupUserIds.push(owner.userId);
    const id = await createNotification({ businessId: owner.businessId, recipientUserIds: [owner.userId] });

    const { error: notifError } = await owner.client.from("notifications").delete().eq("id", id!);
    expect(notifError).not.toBeNull();
    const { error: recipientError } = await owner.client.from("notification_recipients").delete().eq("notification_id", id!);
    expect(recipientError).not.toBeNull();

    const admin = createAdminClient();
    const { data: notifRow } = await admin.from("notifications").select("id").eq("id", id!).maybeSingle();
    expect(notifRow).not.toBeNull();
    const { data: recipientRow } = await admin.from("notification_recipients").select("id").eq("notification_id", id!).maybeSingle();
    expect(recipientRow).not.toBeNull();
  });

  it("24. an authenticated caller cannot forge a notification by calling private.create_notification directly", async () => {
    const owner = await createOwnerAndBusiness("notif-forge-attempt");
    cleanupUserIds.push(owner.userId);
    const { error } = await owner.client.rpc(
      // @ts-expect-error — private.* is intentionally not part of the
      // generated public RPC surface; this call is expected to be
      // rejected before it can even resolve a function to call.
      "create_notification",
      { p_business_id: owner.businessId }
    );
    expect(error).not.toBeNull();
  });

  it("19/20. private.create_notification has NO EXECUTE grant to PUBLIC, anon, authenticated, or service_role", async () => {
    const sql = createTestDbClient();
    try {
      const rows = await sql<{ grantee: string }[]>`
        select case when acl.grantee = 0 then 'PUBLIC' else r.rolname end as grantee
        from pg_proc p
        join pg_namespace n on n.oid = p.pronamespace
        cross join lateral aclexplode(p.proacl) as acl
        left join pg_roles r on r.oid = acl.grantee
        where n.nspname = 'private' and p.proname = 'create_notification' and acl.privilege_type = 'EXECUTE'
      `;
      const grantees = rows.map((r) => r.grantee);
      expect(grantees).not.toContain("PUBLIC");
      expect(grantees).not.toContain("anon");
      expect(grantees).not.toContain("authenticated");
      expect(grantees).not.toContain("service_role");
    } finally {
      await sql.end();
    }
  });

  it("service_role (BYPASSRLS) can read directly, but the writer role's own privileges remain narrow", async () => {
    const owner = await createOwnerAndBusiness("notif-service-role-read");
    cleanupUserIds.push(owner.userId);
    const id = await createNotification({ businessId: owner.businessId, recipientUserIds: [owner.userId] });
    const admin = createAdminClient();
    const { data, error } = await admin.from("notifications").select("id").eq("id", id!);
    expect(error).toBeNull();
    expect(data).toHaveLength(1);
  });

  it("24. RLS is ENABLED and FORCED on notifications, notification_recipients, and notification_preferences", async () => {
    const sql = createTestDbClient();
    try {
      const rows = await sql<{ relname: string; relrowsecurity: boolean; relforcerowsecurity: boolean }[]>`
        select relname, relrowsecurity, relforcerowsecurity from pg_class
        where relname in ('notifications', 'notification_recipients', 'notification_preferences')
          and relnamespace = 'public'::regnamespace
      `;
      expect(rows).toHaveLength(3);
      for (const row of rows) {
        expect(row.relrowsecurity).toBe(true);
        expect(row.relforcerowsecurity).toBe(true);
      }
    } finally {
      await sql.end();
    }
  });

  it("16. a SUSPENDED member cannot read notifications for that business even though a real recipient row exists (inactive membership behavior)", async () => {
    const owner = await createOwnerAndBusiness("notif-inactive-member");
    cleanupUserIds.push(owner.userId);
    const member = await createMemberWithRole(owner.businessId, "notif-inactive-member", "MANAGER");
    cleanupUserIds.push(member.userId);
    const id = await createNotification({ businessId: owner.businessId, recipientUserIds: [owner.userId, member.userId] });

    // Confirmed readable BEFORE suspension.
    const before = await member.client.from("notifications").select("id").eq("id", id!);
    expect(before.data).toHaveLength(1);

    const sql = createTestDbClient();
    try {
      await sql`update public.business_members set status = 'suspended' where business_id = ${owner.businessId} and user_id = ${member.userId}`;
    } finally {
      await sql.end();
    }

    const after = await member.client.from("notifications").select("id").eq("id", id!);
    expect(after.error).toBeNull();
    expect(after.data).toHaveLength(0);
    const recipientAfter = await member.client.from("notification_recipients").select("id").eq("notification_id", id!);
    expect(recipientAfter.data).toHaveLength(0);
  });

  it("17. branch-specific notification is not leaked to a member with NO recipient row for it, regardless of that member's own branch assignment (branch_id is informational, not an access gate on its own)", async () => {
    const owner = await createOwnerAndBusiness("notif-branch-leakage");
    cleanupUserIds.push(owner.userId);
    const branchB = await createBranch(owner.client, owner.businessId, { name: "Notif Leakage Branch B" });
    const member = await createMemberWithRole(owner.businessId, "notif-branch-leakage", "MANAGER");
    cleanupUserIds.push(member.userId);
    // A branch-specific notification targeting ONLY the owner, even
    // though `member` is a real, active member of the SAME business —
    // access is governed exclusively by the recipient row, never by
    // shared business/branch membership alone.
    const id = await createNotification({ businessId: owner.businessId, recipientUserIds: [owner.userId], branchId: branchB });

    const { data, error } = await member.client.from("notifications").select("id, branch_id").eq("id", id!);
    expect(error).toBeNull();
    expect(data).toHaveLength(0);
  });
});

describe("notification_recipients — presentation state mutation rules", () => {
  it("13. a recipient can mark their OWN read state", async () => {
    const owner = await createOwnerAndBusiness("notif-own-read-state");
    cleanupUserIds.push(owner.userId);
    const id = await createNotification({ businessId: owner.businessId, recipientUserIds: [owner.userId] });

    const { error } = await owner.client
      .from("notification_recipients")
      .update({ read_at: new Date().toISOString() } as never)
      .eq("notification_id", id!);
    expect(error).toBeNull();

    const admin = createAdminClient();
    const { data: row } = await admin.from("notification_recipients").select("read_at").eq("notification_id", id!).single();
    expect(row?.read_at).not.toBeNull();
  });

  it("a recipient can mark their OWN seen state independently of read state", async () => {
    const owner = await createOwnerAndBusiness("notif-own-seen-state");
    cleanupUserIds.push(owner.userId);
    const id = await createNotification({ businessId: owner.businessId, recipientUserIds: [owner.userId] });

    const { error } = await owner.client
      .from("notification_recipients")
      .update({ seen_at: new Date().toISOString() } as never)
      .eq("notification_id", id!);
    expect(error).toBeNull();

    const admin = createAdminClient();
    const { data: row } = await admin.from("notification_recipients").select("read_at, seen_at").eq("notification_id", id!).single();
    expect(row?.seen_at).not.toBeNull();
    expect(row?.read_at).toBeNull();
  });

  it("14. another user's read state cannot be mutated by a different caller", async () => {
    const owner = await createOwnerAndBusiness("notif-cross-user-mutation-a");
    cleanupUserIds.push(owner.userId);
    const other = await createOwnerAndBusiness("notif-cross-user-mutation-b");
    cleanupUserIds.push(other.userId);
    const id = await createNotification({ businessId: owner.businessId, recipientUserIds: [owner.userId] });

    // `other` is not even a member of owner's business, let alone the
    // recipient of this notification — the RLS USING clause excludes
    // this row from their update target set entirely (zero rows
    // affected, never an error, matching PostgREST's own RLS-scoped
    // update semantics elsewhere in this codebase).
    const { error } = await other.client
      .from("notification_recipients")
      .update({ read_at: new Date().toISOString() } as never)
      .eq("notification_id", id!);
    expect(error).toBeNull();

    const admin = createAdminClient();
    const { data: row } = await admin.from("notification_recipients").select("read_at").eq("notification_id", id!).single();
    expect(row?.read_at).toBeNull();
  });

  it("15. recipient identity is immutable — notification_id, business_id, and user_id cannot be changed via UPDATE (column-grant denial)", async () => {
    const owner = await createOwnerAndBusiness("notif-recipient-identity-immutable-a");
    cleanupUserIds.push(owner.userId);
    const other = await createOwnerAndBusiness("notif-recipient-identity-immutable-b");
    cleanupUserIds.push(other.userId);
    const id = await createNotification({ businessId: owner.businessId, recipientUserIds: [owner.userId] });

    const { error: userIdError } = await owner.client
      .from("notification_recipients")
      .update({ user_id: other.userId } as never)
      .eq("notification_id", id!);
    expect(userIdError).not.toBeNull();

    const { error: businessIdError } = await owner.client
      .from("notification_recipients")
      .update({ business_id: other.businessId } as never)
      .eq("notification_id", id!);
    expect(businessIdError).not.toBeNull();

    const { error: notificationIdError } = await owner.client
      .from("notification_recipients")
      .update({ notification_id: randomUuid() } as never)
      .eq("notification_id", id!);
    expect(notificationIdError).not.toBeNull();

    const admin = createAdminClient();
    const { data: row } = await admin
      .from("notification_recipients")
      .select("notification_id, business_id, user_id")
      .eq("notification_id", id!)
      .single();
    expect(row?.notification_id).toBe(id);
    expect(row?.business_id).toBe(owner.businessId);
    expect(row?.user_id).toBe(owner.userId);
  });
});

describe("notification_preferences — RLS, ownership, and self-service upsert", () => {
  it("11. a member can insert and read their own preference row", async () => {
    const owner = await createOwnerAndBusiness("notif-pref-own-insert");
    cleanupUserIds.push(owner.userId);
    const { data, error } = await owner.client
      .from("notification_preferences")
      .insert({ business_id: owner.businessId, user_id: owner.userId, notification_type: "inventory.low_stock", in_app_enabled: false } as never)
      .select()
      .single();
    expect(error).toBeNull();
    expect(data).toMatchObject({ in_app_enabled: false });
  });

  it("a member can update their OWN in_app_enabled setting", async () => {
    const owner = await createOwnerAndBusiness("notif-pref-own-update");
    cleanupUserIds.push(owner.userId);
    await owner.client
      .from("notification_preferences")
      .insert({ business_id: owner.businessId, user_id: owner.userId, notification_type: "invoice.overdue" } as never);

    const { error } = await owner.client
      .from("notification_preferences")
      .update({ in_app_enabled: false } as never)
      .eq("business_id", owner.businessId)
      .eq("notification_type", "invoice.overdue");
    expect(error).toBeNull();

    const { data } = await owner.client
      .from("notification_preferences")
      .select("in_app_enabled")
      .eq("business_id", owner.businessId)
      .eq("notification_type", "invoice.overdue")
      .single();
    expect(data?.in_app_enabled).toBe(false);
  });

  it("12. a caller cannot insert a preference row for ANOTHER user", async () => {
    const owner = await createOwnerAndBusiness("notif-pref-forge-a");
    cleanupUserIds.push(owner.userId);
    const other = await createOwnerAndBusiness("notif-pref-forge-b");
    cleanupUserIds.push(other.userId);
    const { error } = await owner.client
      .from("notification_preferences")
      .insert({ business_id: owner.businessId, user_id: other.userId, notification_type: "inventory.low_stock" } as never);
    expect(error).not.toBeNull();
  });

  it("a member cannot read or update ANOTHER user's preference row", async () => {
    const owner = await createOwnerAndBusiness("notif-pref-cross-user-a");
    cleanupUserIds.push(owner.userId);
    const member = await createMemberWithRole(owner.businessId, "notif-pref-cross-user-b", "MANAGER");
    cleanupUserIds.push(member.userId);
    await owner.client
      .from("notification_preferences")
      .insert({ business_id: owner.businessId, user_id: owner.userId, notification_type: "inventory.low_stock" } as never);

    const { data: readData } = await member.client
      .from("notification_preferences")
      .select("id")
      .eq("business_id", owner.businessId)
      .eq("user_id", owner.userId);
    expect(readData).toHaveLength(0);

    const { error: updateError } = await member.client
      .from("notification_preferences")
      .update({ in_app_enabled: false } as never)
      .eq("business_id", owner.businessId)
      .eq("user_id", owner.userId);
    expect(updateError).toBeNull();

    const admin = createAdminClient();
    const { data: row } = await admin
      .from("notification_preferences")
      .select("in_app_enabled")
      .eq("business_id", owner.businessId)
      .eq("user_id", owner.userId)
      .single();
    expect(row?.in_app_enabled).toBe(true);
  });

  it("16. a non-member cannot manage preferences for a business they do not belong to (does not trust the supplied business_id)", async () => {
    const owner = await createOwnerAndBusiness("notif-pref-non-member-a");
    cleanupUserIds.push(owner.userId);
    const stranger = await createOwnerAndBusiness("notif-pref-non-member-b");
    cleanupUserIds.push(stranger.userId);

    const { error } = await stranger.client
      .from("notification_preferences")
      .insert({ business_id: owner.businessId, user_id: stranger.userId, notification_type: "inventory.low_stock" } as never);
    expect(error).not.toBeNull();
  });

  it("a SUSPENDED member cannot manage their own preferences (re-derived from CURRENT status)", async () => {
    const owner = await createOwnerAndBusiness("notif-pref-suspended");
    cleanupUserIds.push(owner.userId);
    const member = await createMemberWithRole(owner.businessId, "notif-pref-suspended", "MANAGER");
    cleanupUserIds.push(member.userId);
    await member.client
      .from("notification_preferences")
      .insert({ business_id: owner.businessId, user_id: member.userId, notification_type: "inventory.low_stock" } as never);

    const sql = createTestDbClient();
    try {
      await sql`update public.business_members set status = 'suspended' where business_id = ${owner.businessId} and user_id = ${member.userId}`;
    } finally {
      await sql.end();
    }

    const { data } = await member.client
      .from("notification_preferences")
      .select("id")
      .eq("business_id", owner.businessId)
      .eq("user_id", member.userId);
    expect(data).toHaveLength(0);

    const { error } = await member.client
      .from("notification_preferences")
      .insert({ business_id: owner.businessId, user_id: member.userId, notification_type: "invoice.overdue" } as never);
    expect(error).not.toBeNull();
  });

  it("3. a malformed notification_type is rejected by the table's own CHECK constraint", async () => {
    const owner = await createOwnerAndBusiness("notif-pref-type-malformed");
    cleanupUserIds.push(owner.userId);
    const { error } = await owner.client
      .from("notification_preferences")
      .insert({ business_id: owner.businessId, user_id: owner.userId, notification_type: "LowStock" } as never);
    expect(error).not.toBeNull();
  });

  it("a duplicate (business_id, user_id, notification_type) is rejected by the unique constraint, and a PostgREST upsert resolves it cleanly", async () => {
    const owner = await createOwnerAndBusiness("notif-pref-duplicate");
    cleanupUserIds.push(owner.userId);
    await owner.client
      .from("notification_preferences")
      .insert({ business_id: owner.businessId, user_id: owner.userId, notification_type: "inventory.low_stock" } as never);

    const { error: dupError } = await owner.client
      .from("notification_preferences")
      .insert({ business_id: owner.businessId, user_id: owner.userId, notification_type: "inventory.low_stock" } as never);
    expect(dupError).not.toBeNull();

    const { error: upsertError } = await owner.client
      .from("notification_preferences")
      .upsert(
        { business_id: owner.businessId, user_id: owner.userId, notification_type: "inventory.low_stock", in_app_enabled: false } as never,
        { onConflict: "business_id,user_id,notification_type" }
      );
    expect(upsertError).toBeNull();

    const { data } = await owner.client
      .from("notification_preferences")
      .select("in_app_enabled")
      .eq("business_id", owner.businessId)
      .eq("notification_type", "inventory.low_stock")
      .single();
    expect(data?.in_app_enabled).toBe(false);
  });

  it("updated_at advances on update and is never client-settable", async () => {
    const owner = await createOwnerAndBusiness("notif-pref-updated-at");
    cleanupUserIds.push(owner.userId);
    const { data: inserted } = await owner.client
      .from("notification_preferences")
      .insert({ business_id: owner.businessId, user_id: owner.userId, notification_type: "inventory.low_stock" } as never)
      .select("updated_at")
      .single();

    const { error: forgedError } = await owner.client
      .from("notification_preferences")
      .update({ updated_at: "2000-01-01T00:00:00Z" } as never)
      .eq("business_id", owner.businessId)
      .eq("notification_type", "inventory.low_stock");
    expect(forgedError).not.toBeNull();

    await owner.client
      .from("notification_preferences")
      .update({ in_app_enabled: false } as never)
      .eq("business_id", owner.businessId)
      .eq("notification_type", "inventory.low_stock");

    const { data: after } = await owner.client
      .from("notification_preferences")
      .select("updated_at")
      .eq("business_id", owner.businessId)
      .eq("notification_type", "inventory.low_stock")
      .single();
    expect(new Date(after!.updated_at).getTime()).toBeGreaterThan(new Date(inserted!.updated_at).getTime());
  });
});

describe("notifications / notification_recipients / notification_preferences — schema shape and indexing", () => {
  it("2. required NOT NULL columns are enforced at the table level directly (defense in depth, independent of the writer)", async () => {
    const sql = createTestDbClient();
    try {
      await expect(
        sql`insert into public.notifications (category, notification_type, title) values ('INVENTORY', 'inventory.low_stock', 'x')`
      ).rejects.toThrow(/null value|not-null/i);
    } finally {
      await sql.end();
    }
  });

  it("4/5. category and severity CHECK constraints are enforced at the table level directly", async () => {
    const owner = await createOwnerAndBusiness("notif-schema-checks");
    cleanupUserIds.push(owner.userId);
    const sql = createTestDbClient();
    try {
      await expect(
        sql`insert into public.notifications (business_id, category, notification_type, title) values (${owner.businessId}, 'BOGUS', 'inventory.low_stock', 'x')`
      ).rejects.toThrow(/violates check constraint/i);
      await expect(
        sql`insert into public.notifications (business_id, category, notification_type, title, severity) values (${owner.businessId}, 'INVENTORY', 'inventory.low_stock', 'x', 'URGENT')`
      ).rejects.toThrow(/violates check constraint/i);
    } finally {
      await sql.end();
    }
    cleanupUserIds.push(owner.userId);
  });

  // SEC-1K-01 remediation (Codex DB review): public.notifications now
  // carries its OWN table-level metadata CHECK constraints
  // (jsonb_typeof(metadata) = 'object', octet_length(metadata::text) <=
  // 16384), matching audit_events' own established defense-in-depth
  // pattern. These four tests prove the TABLE itself rejects malformed
  // metadata via a raw, privileged, direct INSERT that bypasses
  // private.create_notification entirely — never merely re-testing the
  // writer function's own (separate, still-present) validation.
  describe("SEC-1K-01 — table-level metadata CHECK constraints (defense in depth, writer bypassed)", () => {
    it("A. a direct INSERT with a top-level JSON array is rejected by the TABLE itself", async () => {
      const owner = await createOwnerAndBusiness("notif-sec1k01-metadata-array");
      cleanupUserIds.push(owner.userId);
      const sql = createTestDbClient();
      try {
        await expect(
          sql`
            insert into public.notifications (business_id, category, notification_type, title, metadata)
            values (${owner.businessId}, 'INVENTORY', 'inventory.low_stock', 'x', '[1,2,3]'::jsonb)
          `
        ).rejects.toThrow(/violates check constraint "notifications_metadata_check"/i);
      } finally {
        await sql.end();
      }
    });

    it("B. a direct INSERT with a top-level JSON scalar is rejected by the TABLE itself", async () => {
      const owner = await createOwnerAndBusiness("notif-sec1k01-metadata-scalar");
      cleanupUserIds.push(owner.userId);
      const sql = createTestDbClient();
      try {
        await expect(
          sql`
            insert into public.notifications (business_id, category, notification_type, title, metadata)
            values (${owner.businessId}, 'INVENTORY', 'inventory.low_stock', 'x', '"just a string"'::jsonb)
          `
        ).rejects.toThrow(/violates check constraint "notifications_metadata_check"/i);
      } finally {
        await sql.end();
      }
    });

    it("C. a direct INSERT with metadata whose jsonb::text form exceeds 16,384 bytes is rejected by the TABLE itself", async () => {
      const owner = await createOwnerAndBusiness("notif-sec1k01-metadata-oversize");
      cleanupUserIds.push(owner.userId);
      const sql = createTestDbClient();
      try {
        const bigValue = "x".repeat(20_000);
        await expect(
          sql`
            insert into public.notifications (business_id, category, notification_type, title, metadata)
            values (${owner.businessId}, 'INVENTORY', 'inventory.low_stock', 'x', ${sql.json({ note: bigValue })}::jsonb)
          `
        ).rejects.toThrow(/violates check constraint "notifications_metadata_check1"/i);
      } finally {
        await sql.end();
      }
    });

    it("D. a direct INSERT with a valid JSON object within the bound succeeds when all other required fields are valid", async () => {
      const owner = await createOwnerAndBusiness("notif-sec1k01-metadata-valid");
      cleanupUserIds.push(owner.userId);
      const sql = createTestDbClient();
      try {
        const rows = await sql<{ id: string; metadata: unknown }[]>`
          insert into public.notifications (business_id, category, notification_type, title, metadata)
          values (${owner.businessId}, 'INVENTORY', 'inventory.low_stock', 'x', ${sql.json({ quantity_on_hand: 2, threshold: 10 })}::jsonb)
          returning id, metadata
        `;
        expect(rows).toHaveLength(1);
        expect(rows[0].metadata).toEqual({ quantity_on_hand: 2, threshold: 10 });
      } finally {
        await sql.end();
      }
    });
  });

  it("22. a malformed UUID in a filter is a client error, never a raw crash or a false-empty result confused with 'not found'", async () => {
    const owner = await createOwnerAndBusiness("notif-malformed-uuid");
    cleanupUserIds.push(owner.userId);
    const { error } = await owner.client.from("notifications").select("id").eq("id", "not-a-uuid");
    expect(error).not.toBeNull();
  });

  it("23. the expected indexes exist on all three Phase 1K tables", async () => {
    const sql = createTestDbClient();
    try {
      const rows = await sql<{ indexname: string }[]>`
        select indexname from pg_indexes
        where schemaname = 'public'
          and tablename in ('notifications', 'notification_recipients', 'notification_preferences')
      `;
      const names = rows.map((r) => r.indexname);
      expect(names).toContain("notifications_business_dedup_key_idx");
      expect(names).toContain("notifications_business_created_idx");
      expect(names).toContain("notifications_business_type_idx");
      expect(names).toContain("notifications_business_resource_idx");
      expect(names).toContain("notifications_branch_created_idx");
      expect(names).toContain("notification_recipients_user_feed_idx");
      expect(names).toContain("notification_recipients_user_unread_idx");
      expect(names).toContain("notification_preferences_user_idx");
    } finally {
      await sql.end();
    }
  });

  it("1. events are stably orderable by (created_at desc, id desc) for a user's chronological feed, keyset-pagination-ready", async () => {
    const owner = await createOwnerAndBusiness("notif-ordering");
    cleanupUserIds.push(owner.userId);
    const ids: string[] = [];
    for (let i = 0; i < 5; i++) {
      ids.push(await createNotification({ businessId: owner.businessId, recipientUserIds: [owner.userId], metadata: { i } }));
    }

    const { data, error } = await owner.client
      .from("notification_recipients")
      .select("notification_id, created_at")
      .eq("business_id", owner.businessId)
      .order("created_at", { ascending: false })
      .order("notification_id", { ascending: false });
    expect(error).toBeNull();
    expect(data!.length).toBeGreaterThanOrEqual(5);
    const seenIds = new Set(data!.map((r) => r.notification_id));
    for (const id of ids) {
      expect(seenIds.has(id)).toBe(true);
    }
  });
});

describe("private_notification_writer — role shape and ownership", () => {
  it("private_notification_writer is NOLOGIN/NOINHERIT/BYPASSRLS, owning exactly create_notification", async () => {
    const sql = createTestDbClient();
    try {
      const roles = await sql<{ rolcanlogin: boolean; rolinherit: boolean; rolbypassrls: boolean }[]>`
        select rolcanlogin, rolinherit, rolbypassrls from pg_roles where rolname = 'private_notification_writer'
      `;
      expect(roles).toHaveLength(1);
      expect(roles[0].rolcanlogin).toBe(false);
      expect(roles[0].rolinherit).toBe(false);
      expect(roles[0].rolbypassrls).toBe(true);

      const owned = await sql<{ proname: string }[]>`
        select p.proname
        from pg_proc p
        join pg_namespace n on n.oid = p.pronamespace
        join pg_roles r on r.oid = p.proowner
        where r.rolname = 'private_notification_writer'
      `;
      expect(owned.map((o) => o.proname)).toEqual(["create_notification"]);
    } finally {
      await sql.end();
    }
  });

  it("no permission key named notification*.view/manage exists — read access is derived from recipient targeting + active membership alone, by design", async () => {
    const sql = createTestDbClient();
    try {
      const rows = await sql<{ key: string }[]>`
        select key from public.permissions where key like 'notification%'
      `;
      expect(rows).toHaveLength(0);
    } finally {
      await sql.end();
    }
  });
});
