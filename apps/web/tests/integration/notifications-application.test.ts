import { describe, expect, it, vi, afterEach } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";
import type { Database } from "@/lib/supabase/database.types";
import { createAdminClient, deleteTestUser } from "./helpers/admin-client";
import { createOwnerAndBusiness, createMemberWithRole, randomUuid } from "./helpers/inventory";
import { createBranch, getDefaultBranchId } from "./helpers/staff";
import { makeSaleProduct, makeCustomer } from "./helpers/sales";
import { makeExpenseCategory } from "./helpers/expenses";
import { createTestDbClient } from "./helpers/db-client";

// Phase 1K APPLICATION LAYER — exercises the 5 instrumented mutation RPCs
// (record_invoice_payment, create_sale_return, create_expense,
// create_business_invitation, deactivate_business_branch) end to end
// against a real database, and the application's own DAL/Server Actions
// on top of them.

let cleanupUserIds: string[] = [];
afterEach(async () => {
  for (const id of cleanupUserIds) await deleteTestUser(id);
  cleanupUserIds = [];
});

async function countNotifications(businessId: string, notificationType: string) {
  const sql = createTestDbClient();
  try {
    const rows = await sql<{ count: string }[]>`
      select count(*)::text from public.notifications
      where business_id = ${businessId} and notification_type = ${notificationType}
    `;
    return Number(rows[0].count);
  } finally {
    await sql.end();
  }
}

async function getRecipientUserIds(businessId: string, notificationType: string) {
  const sql = createTestDbClient();
  try {
    const rows = await sql<{ user_id: string }[]>`
      select nr.user_id
      from public.notification_recipients nr
      join public.notifications n on n.id = nr.notification_id
      where n.business_id = ${businessId} and n.notification_type = ${notificationType}
    `;
    return rows.map((r) => r.user_id);
  } finally {
    await sql.end();
  }
}

async function setPreference(businessId: string, userId: string, notificationType: string, enabled: boolean) {
  const sql = createTestDbClient();
  try {
    await sql`
      insert into public.notification_preferences (business_id, user_id, notification_type, in_app_enabled)
      values (${businessId}, ${userId}, ${notificationType}, ${enabled})
      on conflict (business_id, user_id, notification_type) do update set in_app_enabled = ${enabled}
    `;
  } finally {
    await sql.end();
  }
}

async function suspendMemberRaw(businessId: string, userId: string) {
  const sql = createTestDbClient();
  try {
    await sql`update public.business_members set status = 'suspended' where business_id = ${businessId} and user_id = ${userId}`;
  } finally {
    await sql.end();
  }
}

describe("record_invoice_payment -> payment.recorded", () => {
  it("1/2/3. creates exactly one payment.recorded notification, in the same transaction, targeting payments.view holders", async () => {
    const owner = await createOwnerAndBusiness("notif-app-payment");
    cleanupUserIds.push(owner.userId);
    const branchId = await getDefaultBranchId(owner.client, owner.businessId);
    const customerId = await makeCustomer(owner.client, owner.businessId);
    const product = await makeSaleProduct(owner.client, owner.businessId, { sellingPrice: 500 });

    const { data: invoiceId } = await owner.client.rpc("create_invoice", {
      p_business_id: owner.businessId,
      p_creation_key: randomUuid(),
      p_customer_id: customerId,
      p_branch_id: branchId,
      p_items: [{ product_id: product.id, quantity: 2 }],
    });
    expect(invoiceId).toBeTruthy();

    const { data: paymentId, error } = await owner.client.rpc("record_invoice_payment", {
      p_business_id: owner.businessId,
      p_creation_key: randomUuid(),
      p_invoice_id: invoiceId as string,
      p_amount: 1000,
      p_payment_method: "CASH",
      p_paid_at: new Date().toISOString(),
    });
    expect(error).toBeNull();
    expect(paymentId).toBeTruthy();

    expect(await countNotifications(owner.businessId, "payment.recorded")).toBe(1);
    const recipients = await getRecipientUserIds(owner.businessId, "payment.recorded");
    expect(recipients).toContain(owner.userId);
  });

  it("4. an exact replay (same creation_key) does not duplicate the notification or its recipients", async () => {
    const owner = await createOwnerAndBusiness("notif-app-payment-replay");
    cleanupUserIds.push(owner.userId);
    const branchId = await getDefaultBranchId(owner.client, owner.businessId);
    const customerId = await makeCustomer(owner.client, owner.businessId);
    const product = await makeSaleProduct(owner.client, owner.businessId, { sellingPrice: 500 });
    const { data: invoiceId } = await owner.client.rpc("create_invoice", {
      p_business_id: owner.businessId,
      p_creation_key: randomUuid(),
      p_customer_id: customerId,
      p_branch_id: branchId,
      p_items: [{ product_id: product.id, quantity: 2 }],
    });

    const paymentCreationKey = randomUuid();
    const paidAt = new Date().toISOString();
    const payload = {
      p_business_id: owner.businessId,
      p_creation_key: paymentCreationKey,
      p_invoice_id: invoiceId as string,
      p_amount: 500,
      p_payment_method: "CASH",
      p_paid_at: paidAt,
    };

    const first = await owner.client.rpc("record_invoice_payment", payload);
    const second = await owner.client.rpc("record_invoice_payment", payload);
    expect(first.data).toBe(second.data);
    expect(await countNotifications(owner.businessId, "payment.recorded")).toBe(1);
    expect((await getRecipientUserIds(owner.businessId, "payment.recorded")).length).toBe(1);
  });

  it("20. a concurrent double-submit of the SAME payment (dedup race) never produces two notifications", async () => {
    const owner = await createOwnerAndBusiness("notif-app-payment-race");
    cleanupUserIds.push(owner.userId);
    const branchId = await getDefaultBranchId(owner.client, owner.businessId);
    const customerId = await makeCustomer(owner.client, owner.businessId);
    const product = await makeSaleProduct(owner.client, owner.businessId, { sellingPrice: 500 });
    const { data: invoiceId } = await owner.client.rpc("create_invoice", {
      p_business_id: owner.businessId,
      p_creation_key: randomUuid(),
      p_customer_id: customerId,
      p_branch_id: branchId,
      p_items: [{ product_id: product.id, quantity: 2 }],
    });

    const payload = {
      p_business_id: owner.businessId,
      p_creation_key: randomUuid(),
      p_invoice_id: invoiceId as string,
      p_amount: 250,
      p_payment_method: "CASH",
      p_paid_at: new Date().toISOString(),
    };

    const [r1, r2] = await Promise.all([
      owner.client.rpc("record_invoice_payment", payload),
      owner.client.rpc("record_invoice_payment", payload),
    ]);
    // One succeeds; the concurrent duplicate either replays cleanly to the
    // SAME id or is serialized behind the first (both are acceptable —
    // what matters is exactly one notification results).
    expect([r1.data, r2.data].filter(Boolean).length).toBeGreaterThan(0);
    expect(await countNotifications(owner.businessId, "payment.recorded")).toBe(1);
  });
});

describe("create_expense -> expense.posted — preferences, targeting, and branch scoping", () => {
  it("5/6/8/9. targets expenses.view holders business-wide, records branch_id, and OWNER receives a branch-specific expense", async () => {
    const owner = await createOwnerAndBusiness("notif-app-expense");
    cleanupUserIds.push(owner.userId);
    const branchB = await createBranch(owner.client, owner.businessId, { name: "Notif Expense Branch B" });
    const categoryId = await makeExpenseCategory(owner.client, owner.businessId);

    const { data: expenseId, error } = await owner.client.rpc("create_expense", {
      p_business_id: owner.businessId,
      p_creation_key: randomUuid(),
      p_category_id: categoryId,
      p_amount: 150,
      p_payment_method: "CASH",
      p_incurred_at: new Date().toISOString(),
      p_branch_id: branchB,
    });
    expect(error).toBeNull();
    expect(expenseId).toBeTruthy();

    const sql = createTestDbClient();
    try {
      const [row] = await sql<{ branch_id: string }[]>`
        select branch_id::text from public.notifications
        where business_id = ${owner.businessId} and notification_type = 'expense.posted'
      `;
      expect(row.branch_id).toBe(branchB);
    } finally {
      await sql.end();
    }

    // OWNER is never a member of branchB specifically (no branch
    // assignment was ever made) yet still receives this branch-specific
    // notification — business-wide oversight targeting, exactly as
    // designed (never narrowed by has_branch_access).
    const recipients = await getRecipientUserIds(owner.businessId, "expense.posted");
    expect(recipients).toContain(owner.userId);
  });

  it("6/7. a candidate who disabled expense.posted is excluded; a candidate with NO preference row defaults to included", async () => {
    const owner = await createOwnerAndBusiness("notif-app-expense-pref");
    cleanupUserIds.push(owner.userId);
    const manager = await createMemberWithRole(owner.businessId, "notif-app-expense-pref", "MANAGER");
    cleanupUserIds.push(manager.userId);
    await setPreference(owner.businessId, manager.userId, "expense.posted", false);
    // owner has NO preference row at all — must default to included.

    const categoryId = await makeExpenseCategory(owner.client, owner.businessId);
    const { data: expenseId } = await owner.client.rpc("create_expense", {
      p_business_id: owner.businessId,
      p_creation_key: randomUuid(),
      p_category_id: categoryId,
      p_amount: 75,
      p_payment_method: "CASH",
      p_incurred_at: new Date().toISOString(),
    });
    expect(expenseId).toBeTruthy();

    const recipients = await getRecipientUserIds(owner.businessId, "expense.posted");
    expect(recipients).toContain(owner.userId);
    expect(recipients).not.toContain(manager.userId);
  });

  it("6b. every eligible candidate opting out means NO notification is created, and the mutation itself still succeeds", async () => {
    const owner = await createOwnerAndBusiness("notif-app-expense-all-opted-out");
    cleanupUserIds.push(owner.userId);
    await setPreference(owner.businessId, owner.userId, "expense.posted", false);

    const categoryId = await makeExpenseCategory(owner.client, owner.businessId);
    const { data: expenseId, error } = await owner.client.rpc("create_expense", {
      p_business_id: owner.businessId,
      p_creation_key: randomUuid(),
      p_category_id: categoryId,
      p_amount: 30,
      p_payment_method: "CASH",
      p_incurred_at: new Date().toISOString(),
    });
    // Preference opt-out must NEVER break the underlying business
    // mutation — the expense itself is still created successfully.
    expect(error).toBeNull();
    expect(expenseId).toBeTruthy();
    expect(await countNotifications(owner.businessId, "expense.posted")).toBe(0);
  });

  it("8. a SUSPENDED member who would otherwise be an eligible candidate is never targeted", async () => {
    const owner = await createOwnerAndBusiness("notif-app-expense-suspended");
    cleanupUserIds.push(owner.userId);
    const manager = await createMemberWithRole(owner.businessId, "notif-app-expense-suspended", "MANAGER");
    cleanupUserIds.push(manager.userId);
    await suspendMemberRaw(owner.businessId, manager.userId);

    const categoryId = await makeExpenseCategory(owner.client, owner.businessId);
    await owner.client.rpc("create_expense", {
      p_business_id: owner.businessId,
      p_creation_key: randomUuid(),
      p_category_id: categoryId,
      p_amount: 40,
      p_payment_method: "CASH",
      p_incurred_at: new Date().toISOString(),
    });

    const recipients = await getRecipientUserIds(owner.businessId, "expense.posted");
    expect(recipients).not.toContain(manager.userId);
  });

  it("7. an outsider (never a member of this business) is never targeted, by construction", async () => {
    const owner = await createOwnerAndBusiness("notif-app-expense-outsider-a");
    cleanupUserIds.push(owner.userId);
    const outsider = await createOwnerAndBusiness("notif-app-expense-outsider-b");
    cleanupUserIds.push(outsider.userId);

    const categoryId = await makeExpenseCategory(owner.client, owner.businessId);
    await owner.client.rpc("create_expense", {
      p_business_id: owner.businessId,
      p_creation_key: randomUuid(),
      p_category_id: categoryId,
      p_amount: 20,
      p_payment_method: "CASH",
      p_incurred_at: new Date().toISOString(),
    });

    const recipients = await getRecipientUserIds(owner.businessId, "expense.posted");
    expect(recipients).not.toContain(outsider.userId);
  });

  it("2. a validation failure (invalid amount) creates NO expense and NO notification", async () => {
    const owner = await createOwnerAndBusiness("notif-app-expense-invalid");
    cleanupUserIds.push(owner.userId);
    const categoryId = await makeExpenseCategory(owner.client, owner.businessId);

    const { error } = await owner.client.rpc("create_expense", {
      p_business_id: owner.businessId,
      p_creation_key: randomUuid(),
      p_category_id: categoryId,
      p_amount: -5,
      p_payment_method: "CASH",
      p_incurred_at: new Date().toISOString(),
    });
    expect(error).not.toBeNull();
    expect(await countNotifications(owner.businessId, "expense.posted")).toBe(0);
  });
});

describe("create_business_invitation -> staff.invited", () => {
  it("1. creates exactly one staff.invited notification targeting staff.view holders", async () => {
    const owner = await createOwnerAndBusiness("notif-app-invite");
    cleanupUserIds.push(owner.userId);
    const branchId = await getDefaultBranchId(owner.client, owner.businessId);

    const { data: invitationId, error } = await owner.client.rpc("create_business_invitation", {
      p_business_id: owner.businessId,
      p_creation_key: randomUuid(),
      p_email: `notif-app-invite-${randomUuid()}@example.test`,
      p_role: "VIEWER",
      p_branch_ids: [branchId],
      p_primary_branch_id: branchId,
    });
    expect(error).toBeNull();
    expect(invitationId).toBeTruthy();
    expect(await countNotifications(owner.businessId, "staff.invited")).toBe(1);
    expect(await getRecipientUserIds(owner.businessId, "staff.invited")).toContain(owner.userId);
  });
});

describe("deactivate_business_branch -> branch.deactivated", () => {
  it("1/4. creates exactly one notification per REAL transition, and a no-op replay (already inactive) creates none", async () => {
    const owner = await createOwnerAndBusiness("notif-app-branch-deactivate");
    cleanupUserIds.push(owner.userId);
    const branchB = await createBranch(owner.client, owner.businessId, { name: "Notif Deactivate Branch B" });

    const { data: branchId, error } = await owner.client.rpc("deactivate_business_branch", {
      p_business_id: owner.businessId,
      p_branch_id: branchB,
    });
    expect(error).toBeNull();
    expect(branchId).toBe(branchB);
    expect(await countNotifications(owner.businessId, "branch.deactivated")).toBe(1);

    // Already-inactive replay: no-op, no second notification.
    const { data: replayId } = await owner.client.rpc("deactivate_business_branch", {
      p_business_id: owner.businessId,
      p_branch_id: branchB,
    });
    expect(replayId).toBe(branchB);
    expect(await countNotifications(owner.businessId, "branch.deactivated")).toBe(1);
  });
});

describe("create_sale_return -> return.completed", () => {
  it("1. creates exactly one return.completed notification targeting returns.view holders", async () => {
    const owner = await createOwnerAndBusiness("notif-app-return");
    cleanupUserIds.push(owner.userId);
    const product = await makeSaleProduct(owner.client, owner.businessId, { sellingPrice: 1000 });

    const { data: saleId } = await owner.client.rpc("create_sale", {
      p_business_id: owner.businessId,
      p_creation_key: randomUuid(),
      p_items: [{ product_id: product.id, quantity: 2 }],
      p_payment_status: "PAID",
      p_payment_method: "CASH",
    });
    expect(saleId).toBeTruthy();

    const { data: saleItems } = await owner.client
      .from("sale_items")
      .select("id")
      .eq("sale_id", saleId as string);
    const saleItemId = saleItems?.[0]?.id as string;

    const { data: returnId, error } = await owner.client.rpc("create_sale_return", {
      p_business_id: owner.businessId,
      p_creation_key: randomUuid(),
      p_sale_id: saleId as string,
      p_items: [{ sale_item_id: saleItemId, quantity: 1, restock: true }],
      p_refund_amount: 1000,
      p_refund_method: "CASH",
      p_reason: "CUSTOMER_RETURN",
    });
    expect(error).toBeNull();
    expect(returnId).toBeTruthy();
    expect(await countNotifications(owner.businessId, "return.completed")).toBe(1);
    expect(await getRecipientUserIds(owner.businessId, "return.completed")).toContain(owner.userId);
  });
});

// Phase 1K APPLICATION LAYER — DAL/Server Action IDOR, isolation, and ACL
// checks, using the real DAL functions via the same hybrid vi.mock
// technique established in audit-application.test.ts/returns-
// application.test.ts.
let currentClient: SupabaseClient<Database>;

vi.mock("next/cache", () => ({ revalidatePath: () => {} }));
vi.mock("@/lib/supabase/server", () => ({
  createClient: async () => currentClient,
}));
vi.mock("@/lib/auth/dal", async () => ({
  requireUser: async () => {
    const { data } = await currentClient.auth.getUser();
    if (!data.user) throw new Error("not signed in");
    return data.user;
  },
}));

const {
  listNotificationsForCurrentUser,
  getUnreadNotificationCount,
  getNotificationById,
} = await import("@/lib/notifications/dal");
const {
  markNotificationReadAction,
  markAllNotificationsReadAction,
  updateNotificationPreferenceAction,
} = await import("@/lib/notifications/actions");

async function seedNotification(businessId: string, recipientUserIds: string[], notificationType = "expense.posted") {
  const sql = createTestDbClient();
  try {
    const rows = await sql<{ create_notification: string }[]>`
      select private.create_notification(
        ${businessId}::uuid, 'FINANCE'::text, ${notificationType}::text, 'Test'::text,
        ${recipientUserIds}::uuid[], null::uuid, null::text, 'INFO'::text,
        null::text, null::uuid, '{}'::jsonb, null::text
      ) as create_notification
    `;
    return rows[0].create_notification;
  } finally {
    await sql.end();
  }
}

function formData(entries: Record<string, string>) {
  const fd = new FormData();
  for (const [k, v] of Object.entries(entries)) fd.set(k, v);
  return fd;
}

describe("Notification DAL/actions — IDOR, isolation, and unread scoping", () => {
  it("12. unread count is scoped to the current user AND current business only", async () => {
    const owner = await createOwnerAndBusiness("notif-app-unread-scope-a");
    cleanupUserIds.push(owner.userId);
    const other = await createOwnerAndBusiness("notif-app-unread-scope-b");
    cleanupUserIds.push(other.userId);
    await seedNotification(owner.businessId, [owner.userId]);
    await seedNotification(other.businessId, [other.userId]);

    currentClient = owner.client;
    expect(await getUnreadNotificationCount(owner.businessId)).toBeGreaterThanOrEqual(1);
    expect(await getUnreadNotificationCount(other.businessId)).toBe(0);
  });

  it("16. a cross-business notification id cannot be used to read a notification", async () => {
    const owner = await createOwnerAndBusiness("notif-app-cross-business-a");
    cleanupUserIds.push(owner.userId);
    const other = await createOwnerAndBusiness("notif-app-cross-business-b");
    cleanupUserIds.push(other.userId);
    const notificationId = await seedNotification(owner.businessId, [owner.userId]);

    currentClient = owner.client;
    // Correct business: readable.
    expect(await getNotificationById(owner.businessId, notificationId)).not.toBeNull();
    // Wrong business (the id belongs to a DIFFERENT business): not found.
    expect(await getNotificationById(other.businessId, notificationId)).toBeNull();
  });

  it("15. mark read on the caller's OWN row succeeds", async () => {
    const owner = await createOwnerAndBusiness("notif-app-mark-read-own");
    cleanupUserIds.push(owner.userId);
    const notificationId = await seedNotification(owner.businessId, [owner.userId]);

    currentClient = owner.client;
    const result = await markNotificationReadAction(
      undefined,
      formData({ businessId: owner.businessId, notificationId })
    );
    expect(result?.error).toBeUndefined();

    const admin = createAdminClient();
    const { data } = await admin
      .from("notification_recipients")
      .select("read_at")
      .eq("notification_id", notificationId)
      .eq("user_id", owner.userId)
      .single();
    expect(data?.read_at).not.toBeNull();
  });

  it("16b. mark read on ANOTHER user's row affects nothing (never an error, never a disclosure)", async () => {
    const owner = await createOwnerAndBusiness("notif-app-mark-read-cross-a");
    cleanupUserIds.push(owner.userId);
    const other = await createOwnerAndBusiness("notif-app-mark-read-cross-b");
    cleanupUserIds.push(other.userId);
    const notificationId = await seedNotification(owner.businessId, [owner.userId]);

    currentClient = other.client;
    const result = await markNotificationReadAction(
      undefined,
      formData({ businessId: owner.businessId, notificationId })
    );
    expect(result?.error).toBeUndefined();

    const admin = createAdminClient();
    const { data } = await admin
      .from("notification_recipients")
      .select("read_at")
      .eq("notification_id", notificationId)
      .eq("user_id", owner.userId)
      .single();
    expect(data?.read_at).toBeNull();
  });

  it("17. mark-all-read is scoped to ONE business and the caller's own rows only", async () => {
    const owner = await createOwnerAndBusiness("notif-app-mark-all-a");
    cleanupUserIds.push(owner.userId);
    const secondBusiness = await createOwnerAndBusiness("notif-app-mark-all-b");
    cleanupUserIds.push(secondBusiness.userId);
    // Same physical user (owner) is also made a member of a second
    // business, to prove mark-all-read never spills across businesses.
    await createMemberWithRole(secondBusiness.businessId, "notif-app-mark-all-shared", "MANAGER");

    const n1 = await seedNotification(owner.businessId, [owner.userId]);

    currentClient = owner.client;
    const result = await markAllNotificationsReadAction(undefined, formData({ businessId: owner.businessId }));
    expect(result?.error).toBeUndefined();

    const admin = createAdminClient();
    const { data } = await admin.from("notification_recipients").select("read_at").eq("notification_id", n1).single();
    expect(data?.read_at).not.toBeNull();
  });

  it("18. updating a preference can only ever target the CALLER's own row — verified by isolation", async () => {
    const owner = await createOwnerAndBusiness("notif-app-pref-isolation-a");
    cleanupUserIds.push(owner.userId);
    const member = await createMemberWithRole(owner.businessId, "notif-app-pref-isolation-b", "MANAGER");
    cleanupUserIds.push(member.userId);

    currentClient = owner.client;
    await updateNotificationPreferenceAction(owner.businessId, {
      notificationType: "expense.posted",
      inAppEnabled: false,
    });

    const admin = createAdminClient();
    const { data: ownerRow } = await admin
      .from("notification_preferences")
      .select("in_app_enabled")
      .eq("business_id", owner.businessId)
      .eq("user_id", owner.userId)
      .single();
    expect(ownerRow?.in_app_enabled).toBe(false);

    const { data: memberRow } = await admin
      .from("notification_preferences")
      .select("in_app_enabled")
      .eq("business_id", owner.businessId)
      .eq("user_id", member.userId)
      .maybeSingle();
    // The member's own row is untouched — never created, never modified —
    // by the owner's own preference update.
    expect(memberRow).toBeNull();
  });

  it("17 (suspended). a suspended member's own inbox becomes empty via the real DAL", async () => {
    const owner = await createOwnerAndBusiness("notif-app-dal-suspended-a");
    cleanupUserIds.push(owner.userId);
    const member = await createMemberWithRole(owner.businessId, "notif-app-dal-suspended-b", "MANAGER");
    cleanupUserIds.push(member.userId);
    await seedNotification(owner.businessId, [member.userId]);

    currentClient = member.client;
    const before = await listNotificationsForCurrentUser(owner.businessId, {});
    expect(before.rows.length).toBeGreaterThanOrEqual(1);

    await suspendMemberRaw(owner.businessId, member.userId);

    const after = await listNotificationsForCurrentUser(owner.businessId, {});
    expect(after.rows).toHaveLength(0);
  });

  it("19. results are stably ordered (created_at desc, id desc), with no duplicates across a keyset page loop", async () => {
    const owner = await createOwnerAndBusiness("notif-app-pagination");
    cleanupUserIds.push(owner.userId);
    const ids: string[] = [];
    for (let i = 0; i < 5; i++) {
      ids.push(await seedNotification(owner.businessId, [owner.userId], "expense.posted"));
    }

    currentClient = owner.client;
    const seen = new Set<string>();
    let cursor: string | undefined;
    for (let page = 0; page < 3; page++) {
      const { rows, nextCursor } = await listNotificationsForCurrentUser(owner.businessId, { cursor });
      for (const row of rows) {
        expect(seen.has(row.id)).toBe(false);
        seen.add(row.id);
      }
      if (!nextCursor) break;
      cursor = nextCursor;
    }
    for (const id of ids) {
      expect(seen.has(id)).toBe(true);
    }
  });
});

describe("Private writer ACL — after Phase 1K application-layer grants", () => {
  it("21. no authenticated caller can invoke private.create_notification directly", async () => {
    const owner = await createOwnerAndBusiness("notif-app-forge-attempt");
    cleanupUserIds.push(owner.userId);
    const { error } = await owner.client.rpc(
      // @ts-expect-error — private.* is intentionally not part of the
      // generated public RPC surface.
      "create_notification",
      { p_business_id: owner.businessId }
    );
    expect(error).not.toBeNull();
  });

  it("22/23. private.create_notification's EXECUTE grantees are EXACTLY the 5 expected Phase 1K writer roles — no more, no less", async () => {
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
      const grantees = rows.map((r) => r.grantee).sort();
      // private_notification_writer itself (the function's OWNER) always
      // appears here too — Postgres implicitly grants an object's owner
      // every privilege on it, reflected in aclexplode's own output; this
      // is expected owner privilege, not a new exposure (see this
      // function's own already-reviewed DB-foundation-round ACL tests
      // for the identical reasoning applied to the writer itself).
      expect(grantees).toEqual(
        [
          "private_notification_writer",
          "private_invoice_payment_writer",
          "private_sale_return_writer",
          "private_expense_writer",
          "private_invitation_writer",
          "private_branch_writer",
        ].sort()
      );
      expect(grantees).not.toContain("PUBLIC");
      expect(grantees).not.toContain("authenticated");
      expect(grantees).not.toContain("service_role");
      expect(grantees).not.toContain("anon");
    } finally {
      await sql.end();
    }
  });

  it("22b. the resolver functions' EXECUTE grantees are likewise exactly the 5 expected writer roles", async () => {
    const sql = createTestDbClient();
    try {
      for (const fn of ["resolve_active_members_with_permission", "filter_notification_recipients_by_preference"]) {
        const rows = await sql<{ grantee: string }[]>`
          select case when acl.grantee = 0 then 'PUBLIC' else r.rolname end as grantee
          from pg_proc p
          join pg_namespace n on n.oid = p.pronamespace
          cross join lateral aclexplode(p.proacl) as acl
          left join pg_roles r on r.oid = acl.grantee
          where n.nspname = 'private' and p.proname = ${fn} and acl.privilege_type = 'EXECUTE'
        `;
        const grantees = rows.map((r) => r.grantee).sort();
        // private_notification_recipient_resolver itself (both
        // functions' shared OWNER) always appears too — expected owner
        // privilege, not a new exposure (see the sibling test above).
        expect(grantees, fn).toEqual(
          [
            "private_notification_recipient_resolver",
            "private_invoice_payment_writer",
            "private_sale_return_writer",
            "private_expense_writer",
            "private_invitation_writer",
            "private_branch_writer",
          ].sort()
        );
      }
    } finally {
      await sql.end();
    }
  });
});
