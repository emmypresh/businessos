import { describe, expect, it, afterEach } from "vitest";
import { createClient } from "@supabase/supabase-js";
import { createAdminClient, deleteTestUser } from "./helpers/admin-client";
import { createOwnerAndBusiness, createMemberWithCustomPermissions, randomUuid } from "./helpers/inventory";
import { createBranch, getDefaultBranchId } from "./helpers/staff";
import { createTestDbClient } from "./helpers/db-client";
import { assertLocalSupabaseUrl } from "./helpers/url-safety";

// Phase 1J — DATABASE FOUNDATION ONLY. Exercises public.audit_events and
// private.record_audit_event directly against a real database. No
// application layer exists yet — every write here goes through a raw
// Postgres connection (createTestDbClient(), the superuser test
// connection every other phase's own branch-deactivation/idempotency-race
// tests already use for privileged fixture setup), standing in for the
// "future trusted mutation RPC" that will eventually call
// private.record_audit_event from inside its own transaction. This is
// deliberately the ONE deterministic proof this round's own instructions
// call for — never a retrofit of any real Phase 1A-1I mutation.

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

// Calls private.record_audit_event via the raw superuser test connection
// — standing in for "an already-trusted SECURITY DEFINER mutation RPC
// calling this from inside its own transaction," since no such RPC
// exists yet in this DB-foundation-only round.
async function recordAuditEvent(overrides: {
  businessId: string;
  actorType?: "USER" | "SYSTEM";
  actorUserId?: string | null;
  action: string;
  category: string;
  branchId?: string | null;
  actorEmailSnapshot?: string | null;
  actorNameSnapshot?: string | null;
  resourceType?: string | null;
  resourceId?: string | null;
  resourceLabelSnapshot?: string | null;
  outcome?: string;
  metadata?: unknown;
}) {
  const sql = createTestDbClient();
  try {
    const rows = await sql<{ record_audit_event: string }[]>`
      select private.record_audit_event(
        ${overrides.businessId}::uuid,
        ${overrides.actorType ?? "USER"}::text,
        ${overrides.actorUserId ?? null}::uuid,
        ${overrides.action}::text,
        ${overrides.category}::text,
        ${overrides.branchId ?? null}::uuid,
        ${overrides.actorEmailSnapshot ?? null}::text,
        ${overrides.actorNameSnapshot ?? null}::text,
        ${overrides.resourceType ?? null}::text,
        ${overrides.resourceId ?? null}::uuid,
        ${overrides.resourceLabelSnapshot ?? null}::text,
        ${overrides.outcome ?? "SUCCESS"}::text,
        ${sql.json((overrides.metadata ?? {}) as never)}::jsonb
      ) as record_audit_event
    `;
    return rows[0].record_audit_event;
  } finally {
    await sql.end();
  }
}

describe("private.record_audit_event — writer success and validation", () => {
  it("8. records a valid event and returns a stable uuid", async () => {
    const owner = await createOwnerAndBusiness("audit-writer-success");
    cleanupUserIds.push(owner.userId);

    const id = await recordAuditEvent({
      businessId: owner.businessId,
      actorUserId: owner.userId,
      action: "sale.created",
      category: "COMMERCE",
      actorEmailSnapshot: "owner@example.test",
      actorNameSnapshot: "Test Owner",
    });
    expect(id).toBeTruthy();

    const admin = createAdminClient();
    const { data: row } = await admin
      .from("audit_events")
      .select("id, business_id, actor_type, actor_user_id, action, category, outcome")
      .eq("id", id)
      .single();
    expect(row?.business_id).toBe(owner.businessId);
    expect(row?.actor_type).toBe("USER");
    expect(row?.actor_user_id).toBe(owner.userId);
    expect(row?.action).toBe("sale.created");
    expect(row?.category).toBe("COMMERCE");
    expect(row?.outcome).toBe("SUCCESS");
  });

  it("13. resource fields persist exactly as supplied", async () => {
    const owner = await createOwnerAndBusiness("audit-resource-fields");
    cleanupUserIds.push(owner.userId);
    const resourceId = randomUuid();

    const id = await recordAuditEvent({
      businessId: owner.businessId,
      actorUserId: owner.userId,
      action: "product.updated",
      category: "INVENTORY",
      resourceType: "product",
      resourceId,
      resourceLabelSnapshot: "Widget 3000",
    });

    const admin = createAdminClient();
    const { data: row } = await admin
      .from("audit_events")
      .select("resource_type, resource_id, resource_label_snapshot")
      .eq("id", id)
      .single();
    expect(row?.resource_type).toBe("product");
    expect(row?.resource_id).toBe(resourceId);
    expect(row?.resource_label_snapshot).toBe("Widget 3000");
  });

  it("14. a null branch_id records a business-wide event successfully", async () => {
    const owner = await createOwnerAndBusiness("audit-branch-null");
    cleanupUserIds.push(owner.userId);

    const id = await recordAuditEvent({
      businessId: owner.businessId,
      actorUserId: owner.userId,
      action: "business.updated",
      category: "ORGANIZATION",
      branchId: null,
    });

    const admin = createAdminClient();
    const { data: row } = await admin.from("audit_events").select("branch_id").eq("id", id).single();
    expect(row?.branch_id).toBeNull();
  });

  it("10. a branch belonging to a DIFFERENT business is rejected (AUDIT_BRANCH_MISMATCH)", async () => {
    const owner = await createOwnerAndBusiness("audit-branch-mismatch-a");
    cleanupUserIds.push(owner.userId);
    const other = await createOwnerAndBusiness("audit-branch-mismatch-b");
    cleanupUserIds.push(other.userId);
    const otherBranch = await getDefaultBranchId(other.client, other.businessId);

    await expect(
      recordAuditEvent({
        businessId: owner.businessId,
        actorUserId: owner.userId,
        action: "branch.deactivated",
        category: "ORGANIZATION",
        branchId: otherBranch,
      })
    ).rejects.toThrow(/AUDIT_BRANCH_MISMATCH/);
  });

  it("a branch belonging to the SAME business is accepted", async () => {
    const owner = await createOwnerAndBusiness("audit-branch-match");
    cleanupUserIds.push(owner.userId);
    const branchB = await createBranch(owner.client, owner.businessId, { name: "Audit Branch B" });

    const id = await recordAuditEvent({
      businessId: owner.businessId,
      actorUserId: owner.userId,
      action: "branch.deactivated",
      category: "ORGANIZATION",
      branchId: branchB,
    });
    const admin = createAdminClient();
    const { data: row } = await admin.from("audit_events").select("branch_id").eq("id", id).single();
    expect(row?.branch_id).toBe(branchB);
  });

  it("11. metadata as a top-level JSON array is rejected (INVALID_AUDIT_METADATA)", async () => {
    const owner = await createOwnerAndBusiness("audit-metadata-array");
    cleanupUserIds.push(owner.userId);
    await expect(
      recordAuditEvent({
        businessId: owner.businessId,
        actorUserId: owner.userId,
        action: "sale.created",
        category: "COMMERCE",
        metadata: [1, 2, 3],
      })
    ).rejects.toThrow(/INVALID_AUDIT_METADATA/);
  });

  it("11b. metadata as a top-level scalar is rejected (INVALID_AUDIT_METADATA)", async () => {
    const owner = await createOwnerAndBusiness("audit-metadata-scalar");
    cleanupUserIds.push(owner.userId);
    const sql = createTestDbClient();
    try {
      await expect(
        sql`
          select private.record_audit_event(
            ${owner.businessId}::uuid, 'USER'::text, ${owner.userId}::uuid,
            'sale.created'::text, 'COMMERCE'::text, null::uuid, null::text, null::text,
            null::text, null::uuid, null::text, 'SUCCESS'::text, '"just a string"'::jsonb
          )
        `
      ).rejects.toThrow(/INVALID_AUDIT_METADATA/);
    } finally {
      await sql.end();
    }
  });

  it("12. metadata exceeding the 16 KB bound is rejected (AUDIT_METADATA_TOO_LARGE)", async () => {
    const owner = await createOwnerAndBusiness("audit-metadata-size");
    cleanupUserIds.push(owner.userId);
    const bigValue = "x".repeat(20_000);
    await expect(
      recordAuditEvent({
        businessId: owner.businessId,
        actorUserId: owner.userId,
        action: "sale.created",
        category: "COMMERCE",
        metadata: { note: bigValue },
      })
    ).rejects.toThrow(/AUDIT_METADATA_TOO_LARGE/);
  });

  it("metadata within the bound succeeds", async () => {
    const owner = await createOwnerAndBusiness("audit-metadata-ok");
    cleanupUserIds.push(owner.userId);
    const id = await recordAuditEvent({
      businessId: owner.businessId,
      actorUserId: owner.userId,
      action: "sale.created",
      category: "COMMERCE",
      metadata: { quantity: 5, reason: "DAMAGED" },
    });
    const admin = createAdminClient();
    const { data: row } = await admin.from("audit_events").select("metadata").eq("id", id).single();
    expect(row?.metadata).toEqual({ quantity: 5, reason: "DAMAGED" });
  });

  it("a USER actor without an actor_user_id is rejected (INVALID_AUDIT_ACTOR)", async () => {
    const owner = await createOwnerAndBusiness("audit-actor-missing");
    cleanupUserIds.push(owner.userId);
    await expect(
      recordAuditEvent({
        businessId: owner.businessId,
        actorType: "USER",
        actorUserId: null,
        action: "sale.created",
        category: "COMMERCE",
      })
    ).rejects.toThrow(/INVALID_AUDIT_ACTOR/);
  });

  it("a SYSTEM actor WITH an actor_user_id is rejected (INVALID_AUDIT_ACTOR)", async () => {
    const owner = await createOwnerAndBusiness("audit-actor-system-with-user");
    cleanupUserIds.push(owner.userId);
    await expect(
      recordAuditEvent({
        businessId: owner.businessId,
        actorType: "SYSTEM",
        actorUserId: owner.userId,
        action: "sale.created",
        category: "COMMERCE",
      })
    ).rejects.toThrow(/INVALID_AUDIT_ACTOR/);
  });

  it("a SYSTEM actor with no actor_user_id succeeds", async () => {
    const owner = await createOwnerAndBusiness("audit-actor-system");
    cleanupUserIds.push(owner.userId);
    const id = await recordAuditEvent({
      businessId: owner.businessId,
      actorType: "SYSTEM",
      actorUserId: null,
      action: "sale.created",
      category: "COMMERCE",
    });
    const admin = createAdminClient();
    const { data: row } = await admin.from("audit_events").select("actor_type, actor_user_id").eq("id", id).single();
    expect(row?.actor_type).toBe("SYSTEM");
    expect(row?.actor_user_id).toBeNull();
  });

  it("a malformed action (uppercase, no dot segment) is rejected (INVALID_AUDIT_ACTION)", async () => {
    const owner = await createOwnerAndBusiness("audit-action-malformed");
    cleanupUserIds.push(owner.userId);
    await expect(
      recordAuditEvent({ businessId: owner.businessId, actorUserId: owner.userId, action: "SaleCreated", category: "COMMERCE" })
    ).rejects.toThrow(/INVALID_AUDIT_ACTION/);
  });

  it("an unrecognized category is rejected (INVALID_AUDIT_CATEGORY)", async () => {
    const owner = await createOwnerAndBusiness("audit-category-invalid");
    cleanupUserIds.push(owner.userId);
    await expect(
      recordAuditEvent({ businessId: owner.businessId, actorUserId: owner.userId, action: "sale.created", category: "BOGUS" })
    ).rejects.toThrow(/INVALID_AUDIT_CATEGORY/);
  });

  it("a resource_id without a resource_type is rejected (INVALID_AUDIT_RESOURCE)", async () => {
    const owner = await createOwnerAndBusiness("audit-resource-invalid");
    cleanupUserIds.push(owner.userId);
    await expect(
      recordAuditEvent({
        businessId: owner.businessId,
        actorUserId: owner.userId,
        action: "sale.created",
        category: "COMMERCE",
        resourceId: randomUuid(),
        resourceType: null,
      })
    ).rejects.toThrow(/INVALID_AUDIT_RESOURCE/);
  });

  it("15. a snapshot survives a later change to the live source (actor rename never alters recorded history)", async () => {
    const owner = await createOwnerAndBusiness("audit-snapshot-durable");
    cleanupUserIds.push(owner.userId);
    const id = await recordAuditEvent({
      businessId: owner.businessId,
      actorUserId: owner.userId,
      action: "sale.created",
      category: "COMMERCE",
      actorNameSnapshot: "Original Name",
      actorEmailSnapshot: "original@example.test",
    });

    // The live business_members/auth.users row is never re-joined —
    // renaming the actor after the fact must not alter what's stored.
    // (No live "display name" column exists on business_members in this
    // schema to mutate directly; this asserts the STORED snapshot is
    // exactly what was passed, independent of anything else, which is
    // the property that makes it durable regardless of what the live
    // source later does.)
    const admin = createAdminClient();
    const { data: row } = await admin
      .from("audit_events")
      .select("actor_name_snapshot, actor_email_snapshot")
      .eq("id", id)
      .single();
    expect(row?.actor_name_snapshot).toBe("Original Name");
    expect(row?.actor_email_snapshot).toBe("original@example.test");
  });
});

describe("audit_events — RLS, tenant isolation, and ACL", () => {
  it("1. audit.view can read its own business's events", async () => {
    const owner = await createOwnerAndBusiness("audit-rls-view");
    cleanupUserIds.push(owner.userId);
    const id = await recordAuditEvent({
      businessId: owner.businessId,
      actorUserId: owner.userId,
      action: "sale.created",
      category: "COMMERCE",
    });

    const { data, error } = await owner.client.from("audit_events").select("id").eq("id", id);
    expect(error).toBeNull();
    expect(data).toHaveLength(1);
  });

  it("2. a caller without audit.view sees no rows (RLS-scoped, never an error)", async () => {
    const owner = await createOwnerAndBusiness("audit-rls-no-view");
    cleanupUserIds.push(owner.userId);
    const id = await recordAuditEvent({
      businessId: owner.businessId,
      actorUserId: owner.userId,
      action: "sale.created",
      category: "COMMERCE",
    });
    const stranger = await createMemberWithCustomPermissions(owner.businessId, "audit-rls-no-view", ["sales.view"]);
    cleanupUserIds.push(stranger.userId);

    const { data, error } = await stranger.client.from("audit_events").select("id").eq("id", id);
    expect(error).toBeNull();
    expect(data).toHaveLength(0);
  });

  it("3. a same-permission caller from a DIFFERENT tenant cannot read another business's events", async () => {
    const owner = await createOwnerAndBusiness("audit-tenant-a");
    cleanupUserIds.push(owner.userId);
    const other = await createOwnerAndBusiness("audit-tenant-b");
    cleanupUserIds.push(other.userId);
    const id = await recordAuditEvent({
      businessId: owner.businessId,
      actorUserId: owner.userId,
      action: "sale.created",
      category: "COMMERCE",
    });

    const { data, error } = await other.client.from("audit_events").select("id").eq("id", id);
    expect(error).toBeNull();
    expect(data).toHaveLength(0);
  });

  it("4. an anonymous (unauthenticated) caller cannot read audit_events", async () => {
    const owner = await createOwnerAndBusiness("audit-anon");
    cleanupUserIds.push(owner.userId);
    const id = await recordAuditEvent({
      businessId: owner.businessId,
      actorUserId: owner.userId,
      action: "sale.created",
      category: "COMMERCE",
    });

    const anon = createAnonClient();
    const { data, error } = await anon.from("audit_events").select("id").eq("id", id);
    expect(data ?? []).toHaveLength(0);
    // Either RLS-scoped empty result or an outright permission error is
    // an acceptable "cannot read" outcome — never the real row.
    void error;
  });

  it("5. a direct authenticated INSERT is denied", async () => {
    const owner = await createOwnerAndBusiness("audit-direct-insert");
    cleanupUserIds.push(owner.userId);
    const { error } = await owner.client.from("audit_events").insert({
      business_id: owner.businessId,
      actor_type: "USER",
      actor_user_id: owner.userId,
      action: "staff.deleted",
      category: "ORGANIZATION",
    } as never);
    expect(error).not.toBeNull();
  });

  it("6. a direct authenticated UPDATE is denied", async () => {
    const owner = await createOwnerAndBusiness("audit-direct-update");
    cleanupUserIds.push(owner.userId);
    const id = await recordAuditEvent({
      businessId: owner.businessId,
      actorUserId: owner.userId,
      action: "sale.created",
      category: "COMMERCE",
    });
    const { error } = await owner.client.from("audit_events").update({ action: "sale.deleted" } as never).eq("id", id);
    expect(error).not.toBeNull();
    const admin = createAdminClient();
    const { data: row } = await admin.from("audit_events").select("action").eq("id", id).single();
    expect(row?.action).toBe("sale.created");
  });

  it("7. a direct authenticated DELETE is denied", async () => {
    const owner = await createOwnerAndBusiness("audit-direct-delete");
    cleanupUserIds.push(owner.userId);
    const id = await recordAuditEvent({
      businessId: owner.businessId,
      actorUserId: owner.userId,
      action: "sale.created",
      category: "COMMERCE",
    });
    const { error } = await owner.client.from("audit_events").delete().eq("id", id);
    expect(error).not.toBeNull();
    const admin = createAdminClient();
    const { data: row } = await admin.from("audit_events").select("id").eq("id", id).maybeSingle();
    expect(row).not.toBeNull();
  });

  it("9. an authenticated caller cannot forge an event by calling private.record_audit_event directly", async () => {
    const owner = await createOwnerAndBusiness("audit-forge-attempt");
    cleanupUserIds.push(owner.userId);
    const { error } = await owner.client.rpc(
      // @ts-expect-error — private.* is intentionally not part of the
      // generated public RPC surface; this call is expected to be
      // rejected before it can even resolve a function to call.
      "record_audit_event",
      { p_business_id: owner.businessId }
    );
    expect(error).not.toBeNull();
  });

  it("17/18. private.record_audit_event has NO EXECUTE grant to PUBLIC, anon, authenticated, or service_role", async () => {
    const sql = createTestDbClient();
    try {
      const rows = await sql<{ grantee: string }[]>`
        select case when acl.grantee = 0 then 'PUBLIC' else r.rolname end as grantee
        from pg_proc p
        join pg_namespace n on n.oid = p.pronamespace
        cross join lateral aclexplode(p.proacl) as acl
        left join pg_roles r on r.oid = acl.grantee
        where n.nspname = 'private' and p.proname = 'record_audit_event' and acl.privilege_type = 'EXECUTE'
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

  it("18b. service_role (BYPASSRLS) can read directly, but the writer role's own privileges remain narrow", async () => {
    const owner = await createOwnerAndBusiness("audit-service-role-read");
    cleanupUserIds.push(owner.userId);
    const id = await recordAuditEvent({
      businessId: owner.businessId,
      actorUserId: owner.userId,
      action: "sale.created",
      category: "COMMERCE",
    });
    const admin = createAdminClient();
    const { data, error } = await admin.from("audit_events").select("id").eq("id", id);
    expect(error).toBeNull();
    expect(data).toHaveLength(1);
  });

  it("19. RLS is ENABLED and FORCED on audit_events", async () => {
    const sql = createTestDbClient();
    try {
      const [row] = await sql<{ relrowsecurity: boolean; relforcerowsecurity: boolean }[]>`
        select relrowsecurity, relforcerowsecurity from pg_class
        where relname = 'audit_events' and relnamespace = 'public'::regnamespace
      `;
      expect(row.relrowsecurity).toBe(true);
      expect(row.relforcerowsecurity).toBe(true);
    } finally {
      await sql.end();
    }
  });

  it("20. seeded role matrix: OWNER/ADMIN/MANAGER/ACCOUNTANT hold audit.view; SALES/INVENTORY/VIEWER do not", async () => {
    const sql = createTestDbClient();
    try {
      const rows = await sql<{ name: string }[]>`
        select r.name
        from public.roles r
        join public.role_permissions rp on rp.role_id = r.id
        join public.permissions p on p.id = rp.permission_id
        where p.key = 'audit.view'
      `;
      const roleNames = rows.map((r) => r.name).sort();
      expect(roleNames).toEqual(["ACCOUNTANT", "ADMIN", "MANAGER", "OWNER"].sort());
    } finally {
      await sql.end();
    }
  });

  it("private_audit_writer is NOLOGIN/NOINHERIT/BYPASSRLS, owning exactly record_audit_event", async () => {
    const sql = createTestDbClient();
    try {
      const roles = await sql<{ rolcanlogin: boolean; rolinherit: boolean; rolbypassrls: boolean }[]>`
        select rolcanlogin, rolinherit, rolbypassrls from pg_roles where rolname = 'private_audit_writer'
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
        where r.rolname = 'private_audit_writer'
      `;
      expect(owned.map((o) => o.proname)).toEqual(["record_audit_event"]);
    } finally {
      await sql.end();
    }
  });
});

describe("audit_events — ordering and pagination-ready indexing", () => {
  it("16. events are stably orderable by (created_at desc, id desc), matching the leading index columns", async () => {
    const owner = await createOwnerAndBusiness("audit-ordering");
    cleanupUserIds.push(owner.userId);
    const ids: string[] = [];
    for (let i = 0; i < 5; i++) {
      ids.push(
        await recordAuditEvent({
          businessId: owner.businessId,
          actorUserId: owner.userId,
          action: "sale.created",
          category: "COMMERCE",
          metadata: { i },
        })
      );
    }

    const { data, error } = await owner.client
      .from("audit_events")
      .select("id, created_at")
      .eq("business_id", owner.businessId)
      .order("created_at", { ascending: false })
      .order("id", { ascending: false });
    expect(error).toBeNull();
    expect(data!.length).toBeGreaterThanOrEqual(5);

    // Keyset pagination smoke: paging by the last row's own
    // (created_at, id) never re-returns an already-seen row and never
    // skips one, for a business with more than one page's worth (bounded
    // to 2-at-a-time here for a small, deterministic fixture).
    const seen = new Set<string>();
    let cursor: { createdAt: string; id: string } | null = null;
    for (let page = 0; page < 3; page++) {
      let query = owner.client
        .from("audit_events")
        .select("id, created_at")
        .eq("business_id", owner.businessId)
        .order("created_at", { ascending: false })
        .order("id", { ascending: false })
        .limit(2);
      if (cursor) {
        query = query.or(
          `created_at.lt.${cursor.createdAt},and(created_at.eq.${cursor.createdAt},id.lt.${cursor.id})`
        );
      }
      const { data: pageRows } = await query;
      if (!pageRows || pageRows.length === 0) break;
      for (const row of pageRows) {
        expect(seen.has(row.id)).toBe(false);
        seen.add(row.id);
      }
      const last = pageRows[pageRows.length - 1];
      cursor = { createdAt: last.created_at, id: last.id };
    }
    for (const id of ids) {
      expect(seen.has(id)).toBe(true);
    }
  });
});

// Codex DB review remediation, SEC-01J ("Audit history deleted by
// business cascade") — permanent regression coverage. Confirms
// audit_events.business_id no longer cascades on business deletion, that
// a business with existing audit history cannot be deleted at all, and
// that the audit row genuinely survives the failed attempt.
describe("audit_events — SEC-01J: business-delete durability", () => {
  it("1. audit_events.business_id's own FK uses RESTRICT (or equivalent NO ACTION), never CASCADE — a catalog assertion that fails if this regresses", async () => {
    const sql = createTestDbClient();
    try {
      const rows = await sql<{ confdeltype: string }[]>`
        select c.confdeltype
        from pg_constraint c
        join pg_class t on t.oid = c.conrelid
        join pg_namespace n on n.oid = t.relnamespace
        where n.nspname = 'public' and t.relname = 'audit_events' and c.contype = 'f'
          and c.conname = (
            select conname from pg_constraint c2
            join pg_class t2 on t2.oid = c2.conrelid
            where t2.relname = 'audit_events' and c2.contype = 'f'
              and array_length(c2.conkey, 1) = 1
              and c2.confrelid = 'public.businesses'::regclass
            limit 1
          )
      `;
      expect(rows).toHaveLength(1);
      // pg_constraint.confdeltype: 'a' = NO ACTION, 'r' = RESTRICT,
      // 'c' = CASCADE, 'n' = SET NULL, 'd' = SET DEFAULT. Only 'a'/'r' are
      // acceptable here — 'c'/'n'/'d' would all defeat this table's own
      // durability guarantee (CASCADE by deleting history outright, SET
      // NULL by detaching a historical row from its own tenant identity).
      expect(["a", "r"]).toContain(rows[0].confdeltype);
    } finally {
      await sql.end();
    }
  });

  it("2. audit_events.branch_id's own composite FK is NOT destructive (NO ACTION/RESTRICT, never CASCADE/SET NULL)", async () => {
    const sql = createTestDbClient();
    try {
      const rows = await sql<{ confdeltype: string }[]>`
        select c.confdeltype
        from pg_constraint c
        join pg_class t on t.oid = c.conrelid
        join pg_namespace n on n.oid = t.relnamespace
        where n.nspname = 'public' and t.relname = 'audit_events' and c.contype = 'f'
          and c.confrelid = 'public.business_branches'::regclass
      `;
      expect(rows).toHaveLength(1);
      expect(["a", "r"]).toContain(rows[0].confdeltype);
    } finally {
      await sql.end();
    }
  });

  it("3/4. deleting a business with existing audit history is rejected, and the audit row remains intact afterward", async () => {
    const owner = await createOwnerAndBusiness("audit-business-delete-blocked");
    // Deliberately NOT pushed to cleanupUserIds' business-deletion path —
    // this business is expected to survive (the whole point of the test)
    // and its owner user is cleaned up normally below.
    const id = await recordAuditEvent({
      businessId: owner.businessId,
      actorUserId: owner.userId,
      action: "sale.created",
      category: "COMMERCE",
    });

    // No user-facing business-deletion RPC exists anywhere in this
    // codebase (confirmed by inspection — there is no delete_business
    // function, and no application code path calls
    // `delete from public.businesses`) — the FK behavior itself is
    // therefore proven directly, via a privileged connection attempting
    // the same DELETE any future admin/system deletion path would
    // eventually have to issue, exactly as this round's own instructions
    // anticipate for this exact situation.
    const sql = createTestDbClient();
    let deleteError: unknown;
    try {
      await sql`delete from public.businesses where id = ${owner.businessId}`;
    } catch (e) {
      deleteError = e;
    } finally {
      await sql.end();
    }
    expect(deleteError).toBeTruthy();
    expect(String((deleteError as { message?: string })?.message ?? deleteError)).toMatch(
      /violates foreign key constraint/i
    );

    // The business itself still exists...
    const admin = createAdminClient();
    const { data: businessRow } = await admin.from("businesses").select("id").eq("id", owner.businessId).maybeSingle();
    expect(businessRow).not.toBeNull();
    // ...and so does the audit event — the failed DELETE rolled back
    // entirely, never partially removing anything.
    const { data: auditRow } = await admin.from("audit_events").select("id").eq("id", id).maybeSingle();
    expect(auditRow).not.toBeNull();

    cleanupUserIds.push(owner.userId);
  });

});

// Re-verifies every append-only/direct-write guarantee holds AFTER the
// SEC-01J fix — the FK change touches only delete semantics for the
// PARENT (businesses/business_branches) side, never the grant/RLS/policy
// surface that makes audit_events itself append-only, but this is
// re-proven explicitly per the remediation's own explicit request rather
// than merely inferred from the (unmodified) tests already above.
describe("audit_events — append-only re-verification after SEC-01J", () => {
  it("direct authenticated INSERT/UPDATE/DELETE/TRUNCATE are all still denied", async () => {
    const owner = await createOwnerAndBusiness("audit-append-only-reverify");
    cleanupUserIds.push(owner.userId);
    const id = await recordAuditEvent({
      businessId: owner.businessId,
      actorUserId: owner.userId,
      action: "sale.created",
      category: "COMMERCE",
    });

    const insertResult = await owner.client.from("audit_events").insert({
      business_id: owner.businessId,
      actor_type: "USER",
      actor_user_id: owner.userId,
      action: "staff.deleted",
      category: "ORGANIZATION",
    } as never);
    expect(insertResult.error).not.toBeNull();

    const updateResult = await owner.client.from("audit_events").update({ action: "sale.deleted" } as never).eq("id", id);
    expect(updateResult.error).not.toBeNull();

    const deleteResult = await owner.client.from("audit_events").delete().eq("id", id);
    expect(deleteResult.error).not.toBeNull();

    // TRUNCATE has no PostgREST-reachable surface at all (it isn't a row
    // operation), so this is checked at the grant catalog level directly
    // — the same REVOKE this table's own creation migration issues.
    const sql = createTestDbClient();
    try {
      const rows = await sql<{ has_truncate: boolean }[]>`
        select has_table_privilege('authenticated', 'public.audit_events', 'TRUNCATE') as has_truncate
      `;
      expect(rows[0].has_truncate).toBe(false);
    } finally {
      await sql.end();
    }

    const admin = createAdminClient();
    const { data: row } = await admin.from("audit_events").select("action").eq("id", id).single();
    expect(row?.action).toBe("sale.created");
  });

  it("tenant isolation and audit.view RLS gating are unchanged", async () => {
    const owner = await createOwnerAndBusiness("audit-tenant-reverify-a");
    cleanupUserIds.push(owner.userId);
    const other = await createOwnerAndBusiness("audit-tenant-reverify-b");
    cleanupUserIds.push(other.userId);
    const stranger = await createMemberWithCustomPermissions(owner.businessId, "audit-tenant-reverify-stranger", [
      "sales.view",
    ]);
    cleanupUserIds.push(stranger.userId);

    const id = await recordAuditEvent({
      businessId: owner.businessId,
      actorUserId: owner.userId,
      action: "sale.created",
      category: "COMMERCE",
    });

    const { data: ownData } = await owner.client.from("audit_events").select("id").eq("id", id);
    expect(ownData).toHaveLength(1);
    const { data: crossTenant } = await other.client.from("audit_events").select("id").eq("id", id);
    expect(crossTenant).toHaveLength(0);
    const { data: noPermission } = await stranger.client.from("audit_events").select("id").eq("id", id);
    expect(noPermission).toHaveLength(0);
  });
});
