import { describe, expect, it, afterEach } from "vitest";
import { deleteTestUser } from "./helpers/admin-client";
import {
  createOwnerAndBusiness,
  createMemberWithCustomPermissions,
  getDefaultLocationId,
  randomUuid,
} from "./helpers/inventory";
import { makeSaleProduct } from "./helpers/sales";
import { getDefaultBranchId, createBranch, getBranchLocationId, assignMemberToBranch, getMemberId } from "./helpers/staff";
import { createTestDbClient } from "./helpers/db-client";

// Phase 1G: branch-aware inventory locations and movements.
// (20260829080000_branch_aware_inventory_locations.sql,
// 20260829080200_branch_aware_inventory_movements.sql)

let cleanupUserIds: string[] = [];
afterEach(async () => {
  for (const id of cleanupUserIds) await deleteTestUser(id);
  cleanupUserIds = [];
});

describe("inventory_locations — branch model and backfill", () => {
  it("16. the one pre-existing location is backfilled to the business's default branch, as its canonical location, WITHOUT creating a second location", async () => {
    const owner = await createOwnerAndBusiness("binv-backfill");
    cleanupUserIds.push(owner.userId);
    const defaultBranchId = await getDefaultBranchId(owner.client, owner.businessId);
    const defaultLocationId = await getDefaultLocationId(owner.client, owner.businessId);
    const branchLocationId = await getBranchLocationId(owner.businessId, defaultBranchId);

    // Exactly the SAME row — reused, not duplicated (see the migration's
    // own "reuse, don't duplicate" header comment).
    expect(branchLocationId).toBe(defaultLocationId);

    const sql = createTestDbClient();
    try {
      const rows = await sql<{ count: string }[]>`
        select count(*)::text as count from public.inventory_locations where business_id = ${owner.businessId}
      `;
      expect(rows[0].count).toBe("1");
    } finally {
      await sql.end();
    }
  });

  it("a new branch automatically gets its own, distinct canonical location", async () => {
    const owner = await createOwnerAndBusiness("binv-new-branch-location");
    cleanupUserIds.push(owner.userId);
    const branchId = await createBranch(owner.client, owner.businessId, { name: "Second Branch" });
    const defaultLocationId = await getDefaultLocationId(owner.client, owner.businessId);
    const branchLocationId = await getBranchLocationId(owner.businessId, branchId);

    expect(branchLocationId).not.toBe(defaultLocationId);

    const { data: location } = await owner.client
      .from("inventory_locations")
      .select("name, is_default, status")
      .eq("id", branchLocationId)
      .single();
    expect(location!.name).toBe("Second Branch Store");
    expect(location!.is_default).toBe(false);  // business-wide default is untouched
    expect(location!.status).toBe("active");
  });

  it("17. location/branch tenant consistency is enforced structurally — a location can never reference another business's branch", async () => {
    const sql = createTestDbClient();
    try {
      const owner = await createOwnerAndBusiness("binv-tenant-a");
      const stranger = await createOwnerAndBusiness("binv-tenant-b");
      cleanupUserIds.push(owner.userId, stranger.userId);
      const strangerBranchId = await getDefaultBranchId(stranger.client, stranger.businessId);

      await expect(
        sql`
          insert into public.inventory_locations (business_id, branch_id, name, is_branch_default, status, created_by)
          values (${owner.businessId}, ${strangerBranchId}, 'Cross-tenant attempt', true, 'active', ${owner.userId})
        `
      ).rejects.toThrow();
    } finally {
      await sql.end();
    }
  });
});

describe("record_inventory_movement — branch access", () => {
  it("18. an adjustment on an accessible ACTIVE branch's location succeeds", async () => {
    const owner = await createOwnerAndBusiness("binv-adjust-ok");
    cleanupUserIds.push(owner.userId);
    const productId = (await makeSaleProduct(owner.client, owner.businessId, { openingQuantity: 0 })).id;
    const defaultLocationId = await getDefaultLocationId(owner.client, owner.businessId);

    const { error } = await owner.client.rpc("record_inventory_movement", {
      p_business_id: owner.businessId,
      p_product_id: productId,
      p_inventory_location_id: defaultLocationId,
      p_movement_type: "ADJUSTMENT_IN",
      p_quantity: 5,
      p_idempotency_key: randomUuid(),
      p_reason: "Stock count",
    });
    expect(error).toBeNull();
  });

  it("19. an adjustment on an INACCESSIBLE (but real, ACTIVE, same-tenant) branch's location is rejected", async () => {
    const owner = await createOwnerAndBusiness("binv-adjust-no-access");
    cleanupUserIds.push(owner.userId);
    const productId = (await makeSaleProduct(owner.client, owner.businessId, { openingQuantity: 0 })).id;
    const branchId = await createBranch(owner.client, owner.businessId, { name: "Restricted Branch" });
    const locationId = await getBranchLocationId(owner.businessId, branchId);
    // inventory.view_cost included solely to satisfy this codebase's own
    // globally-enforced RBAC implication rule (rbac-implication.test.ts) —
    // irrelevant to what this test is actually proving (branch access).
    const worker = await createMemberWithCustomPermissions(owner.businessId, "binv-adjust-no-access", [
      "inventory.adjust",
      "inventory.view_cost",
    ]);
    cleanupUserIds.push(worker.userId);
    // worker has real access to the business's own DEFAULT branch only
    // (createMemberWithCustomPermissions's own fixture grants that — see
    // helpers/inventory.ts's addMemberWithRole) — never to this separate,
    // freshly-created `branchId`.

    const { error } = await worker.client.rpc("record_inventory_movement", {
      p_business_id: owner.businessId,
      p_product_id: productId,
      p_inventory_location_id: locationId,
      p_movement_type: "ADJUSTMENT_IN",
      p_quantity: 5,
      p_idempotency_key: randomUuid(),
      p_reason: "Unauthorized attempt",
    });
    expect(error?.message).toContain("insufficient_privilege");
  });

  it("a caller WITH inventory.adjust AND branch access succeeds against that branch's own location", async () => {
    const owner = await createOwnerAndBusiness("binv-adjust-has-access");
    cleanupUserIds.push(owner.userId);
    const productId = (await makeSaleProduct(owner.client, owner.businessId, { openingQuantity: 0 })).id;
    const branchId = await createBranch(owner.client, owner.businessId, { name: "Granted Branch" });
    const locationId = await getBranchLocationId(owner.businessId, branchId);
    const worker = await createMemberWithCustomPermissions(owner.businessId, "binv-adjust-has-access", [
      "inventory.adjust",
      "inventory.view_cost",
    ]);
    cleanupUserIds.push(worker.userId);
    const workerMemberId = await getMemberId(owner.businessId, worker.userId);
    await assignMemberToBranch(owner.client, owner.businessId, workerMemberId, [branchId]);

    const { error } = await worker.client.rpc("record_inventory_movement", {
      p_business_id: owner.businessId,
      p_product_id: productId,
      p_inventory_location_id: locationId,
      p_movement_type: "ADJUSTMENT_IN",
      p_quantity: 5,
      p_idempotency_key: randomUuid(),
      p_reason: "Authorized stock count",
    });
    expect(error).toBeNull();
  });

  it("20. record_inventory_movement against an INACTIVE branch's location is rejected (has_branch_access requires ACTIVE)", async () => {
    const owner = await createOwnerAndBusiness("binv-adjust-inactive");
    cleanupUserIds.push(owner.userId);
    const productId = (await makeSaleProduct(owner.client, owner.businessId, { openingQuantity: 0 })).id;
    const branchId = await createBranch(owner.client, owner.businessId, { name: "Deactivating Branch" });
    const locationId = await getBranchLocationId(owner.businessId, branchId);
    const worker = await createMemberWithCustomPermissions(owner.businessId, "binv-adjust-inactive", [
      "inventory.adjust",
      "inventory.view_cost",
    ]);
    cleanupUserIds.push(worker.userId);
    const workerMemberId = await getMemberId(owner.businessId, worker.userId);
    await assignMemberToBranch(owner.client, owner.businessId, workerMemberId, [branchId]);
    await owner.client.rpc("deactivate_business_branch", { p_business_id: owner.businessId, p_branch_id: branchId });

    const { error } = await worker.client.rpc("record_inventory_movement", {
      p_business_id: owner.businessId,
      p_product_id: productId,
      p_inventory_location_id: locationId,
      p_movement_type: "ADJUSTMENT_IN",
      p_quantity: 5,
      p_idempotency_key: randomUuid(),
      p_reason: "Should be blocked",
    });
    expect(error?.message).toContain("insufficient_privilege");
  });

  it("21. a foreign-tenant location id is rejected by the existing LOCATION_NOT_FOUND check, unpre-empted by the new branch-access guard", async () => {
    const owner = await createOwnerAndBusiness("binv-foreign-a");
    const stranger = await createOwnerAndBusiness("binv-foreign-b");
    cleanupUserIds.push(owner.userId, stranger.userId);
    const productId = (await makeSaleProduct(owner.client, owner.businessId, { openingQuantity: 0 })).id;
    const strangerLocationId = await getDefaultLocationId(stranger.client, stranger.businessId);

    const { error } = await owner.client.rpc("record_inventory_movement", {
      p_business_id: owner.businessId,
      p_product_id: productId,
      p_inventory_location_id: strangerLocationId,
      p_movement_type: "ADJUSTMENT_IN",
      p_quantity: 5,
      p_idempotency_key: randomUuid(),
      p_reason: "Cross-tenant attempt",
    });
    expect(error?.message).toContain("LOCATION_NOT_FOUND");
  });

  it("create_product's bundled opening-stock path enforces the identical branch-access gate for an explicit p_opening_location_id", async () => {
    const owner = await createOwnerAndBusiness("binv-product-opening");
    cleanupUserIds.push(owner.userId);
    const branchId = await createBranch(owner.client, owner.businessId, { name: "No Access Branch" });
    const locationId = await getBranchLocationId(owner.businessId, branchId);
    // inventory.view_cost included solely to satisfy this codebase's own
    // established, globally-enforced RBAC implication rule (rbac-implication.test.ts:
    // every role with products.manage/inventory.adjust also has
    // inventory.view_cost) — this custom test-fixture role persists in
    // the shared public.roles table for the rest of the run, exactly like
    // every other createMemberWithCustomPermissions role does, so it must
    // satisfy the same invariant a real seeded role would. Irrelevant to
    // what this specific test is actually proving (branch access).
    const worker = await createMemberWithCustomPermissions(owner.businessId, "binv-product-opening", [
      "products.manage",
      "inventory.adjust",
      "inventory.view_cost",
    ]);
    cleanupUserIds.push(worker.userId);
    // worker has products.manage + inventory.adjust but no access to `branchId`.

    const { error } = await worker.client.rpc("create_product", {
      p_business_id: owner.businessId,
      p_creation_key: randomUuid(),
      p_name: "Gap Test Product",
      p_sku: `gap-${randomUuid()}`,
      p_selling_price: 100,
      p_opening_quantity: 5,
      p_opening_location_id: locationId,
    });
    expect(error?.message).toContain("insufficient_privilege");
  });

  it("an EXPLICIT foreign-tenant p_opening_location_id is rejected by the existing LOCATION_NOT_FOUND check, unpre-empted by the new branch-access guard", async () => {
    const owner = await createOwnerAndBusiness("binv-product-foreign-a");
    const stranger = await createOwnerAndBusiness("binv-product-foreign-b");
    cleanupUserIds.push(owner.userId, stranger.userId);
    const strangerLocationId = await getDefaultLocationId(stranger.client, stranger.businessId);

    const { error } = await owner.client.rpc("create_product", {
      p_business_id: owner.businessId,
      p_creation_key: randomUuid(),
      p_name: "Foreign Location Product",
      p_sku: `foreign-${randomUuid()}`,
      p_selling_price: 100,
      p_opening_quantity: 5,
      p_opening_location_id: strangerLocationId,
    });
    expect(error?.message).toContain("LOCATION_NOT_FOUND");
  });
});

describe("create_product — Medium 2B: omitted opening-location resolves via the caller's own primary branch", () => {
  it("Medium 2B confirmed defect: a Branch-B-only product-creation caller using the OLD app-style omitted p_opening_location_id succeeds, and opening stock lands in Branch B's own canonical location", async () => {
    const owner = await createOwnerAndBusiness("binv-product-branchb");
    cleanupUserIds.push(owner.userId);
    const branchB = await createBranch(owner.client, owner.businessId, { name: "Branch B" });
    const branchBLocationId = await getBranchLocationId(owner.businessId, branchB);
    const worker = await createMemberWithCustomPermissions(owner.businessId, "binv-product-branchb", [
      "products.manage",
      "inventory.adjust",
      "inventory.view_cost",
    ]);
    cleanupUserIds.push(worker.userId);
    const workerMemberId = await getMemberId(owner.businessId, worker.userId);
    // Branch B ONLY, and it is their PRIMARY.
    await assignMemberToBranch(owner.client, owner.businessId, workerMemberId, [branchB]);

    // The exact current, UNMODIFIED Phase 1F application's own calling
    // shape: never sends p_opening_location_id when relying on the default.
    const { data: product, error } = await worker.client.rpc("create_product", {
      p_business_id: owner.businessId,
      p_creation_key: randomUuid(),
      p_name: "Branch B Opening Stock Product",
      p_sku: `branchb-${randomUuid()}`,
      p_selling_price: 100,
      p_opening_quantity: 7,
    });
    expect(error).toBeNull();

    const { data: balance } = await owner.client
      .from("inventory_balances")
      .select("quantity")
      .eq("business_id", owner.businessId)
      .eq("product_id", product!.id)
      .eq("inventory_location_id", branchBLocationId)
      .single();
    expect(Number(balance!.quantity)).toBe(7);
  });

  it("an omitted p_opening_location_id for a caller with NO primary branch assignment at all fails with a controlled, safe error", async () => {
    const owner = await createOwnerAndBusiness("binv-product-no-primary");
    cleanupUserIds.push(owner.userId);
    const worker = await createMemberWithCustomPermissions(owner.businessId, "binv-product-no-primary", [
      "products.manage",
      "inventory.adjust",
      "inventory.view_cost",
    ]);
    cleanupUserIds.push(worker.userId);
    const sql = createTestDbClient();
    try {
      const [{ id: workerMemberId }] = await sql<{ id: string }[]>`
        select id from public.business_members where business_id = ${owner.businessId} and user_id = ${worker.userId}
      `;
      await sql`delete from public.business_member_branches where member_id = ${workerMemberId}`;
    } finally {
      await sql.end();
    }

    const { error } = await worker.client.rpc("create_product", {
      p_business_id: owner.businessId,
      p_creation_key: randomUuid(),
      p_name: "No Primary Branch Product",
      p_sku: `no-primary-${randomUuid()}`,
      p_selling_price: 100,
      p_opening_quantity: 3,
    });
    expect(error?.message).toContain("NO_PRIMARY_BRANCH_ASSIGNED");
  });

  it("an omitted p_opening_location_id whose caller's primary branch has since become INACTIVE is rejected, never silently let through", async () => {
    const owner = await createOwnerAndBusiness("binv-product-inactive-primary");
    cleanupUserIds.push(owner.userId);
    const branchB = await createBranch(owner.client, owner.businessId, { name: "Deactivating Branch B" });
    const worker = await createMemberWithCustomPermissions(owner.businessId, "binv-product-inactive-primary", [
      "products.manage",
      "inventory.adjust",
      "inventory.view_cost",
    ]);
    cleanupUserIds.push(worker.userId);
    const workerMemberId = await getMemberId(owner.businessId, worker.userId);
    await assignMemberToBranch(owner.client, owner.businessId, workerMemberId, [branchB]);
    await owner.client.rpc("deactivate_business_branch", { p_business_id: owner.businessId, p_branch_id: branchB });

    const { error } = await worker.client.rpc("create_product", {
      p_business_id: owner.businessId,
      p_creation_key: randomUuid(),
      p_name: "Inactive Primary Branch Product",
      p_sku: `inactive-primary-${randomUuid()}`,
      p_selling_price: 100,
      p_opening_quantity: 3,
    });
    expect(error?.message).toContain("insufficient_privilege");
  });
});

describe("record_inventory_movement — Medium 2C: narrow legacy business-default-location compatibility alias", () => {
  it("Medium 2C confirmed defect: a Branch-B-only inventory adjustment using the legacy business-wide default location succeeds, but the movement actually lands on Branch B's own canonical location, never the legacy alias itself", async () => {
    const owner = await createOwnerAndBusiness("binv-2c-branchb");
    cleanupUserIds.push(owner.userId);
    const productId = (await makeSaleProduct(owner.client, owner.businessId, { openingQuantity: 0 })).id;
    const branchB = await createBranch(owner.client, owner.businessId, { name: "Branch B" });
    const branchBLocationId = await getBranchLocationId(owner.businessId, branchB);
    const legacyDefaultLocationId = await getDefaultLocationId(owner.client, owner.businessId);
    const worker = await createMemberWithCustomPermissions(owner.businessId, "binv-2c-branchb", [
      "inventory.adjust",
      "inventory.view_cost",
    ]);
    cleanupUserIds.push(worker.userId);
    const workerMemberId = await getMemberId(owner.businessId, worker.userId);
    await assignMemberToBranch(owner.client, owner.businessId, workerMemberId, [branchB]);

    // The exact current, UNMODIFIED Phase 1F application's own calling
    // shape: always supplies the business-wide legacy default location,
    // since it has no branch/location chooser yet.
    const { data: ledgerRow, error } = await worker.client.rpc("record_inventory_movement", {
      p_business_id: owner.businessId,
      p_product_id: productId,
      p_inventory_location_id: legacyDefaultLocationId,
      p_movement_type: "ADJUSTMENT_IN",
      p_quantity: 5,
      p_idempotency_key: randomUuid(),
      p_reason: "Legacy-app stock count",
    });
    expect(error).toBeNull();
    expect(ledgerRow!.inventory_location_id).toBe(branchBLocationId);

    const { data: branchBBalance } = await owner.client
      .from("inventory_balances")
      .select("quantity")
      .eq("business_id", owner.businessId)
      .eq("product_id", productId)
      .eq("inventory_location_id", branchBLocationId)
      .single();
    expect(Number(branchBBalance!.quantity)).toBe(5);

    const { data: legacyBalance } = await owner.client
      .from("inventory_balances")
      .select("quantity")
      .eq("business_id", owner.businessId)
      .eq("product_id", productId)
      .eq("inventory_location_id", legacyDefaultLocationId)
      .maybeSingle();
    expect(Number(legacyBalance?.quantity ?? 0)).toBe(0);
  });

  it("the Medium 2C alias never activates for a caller with NO primary branch assignment — supplying the legacy default location still fails", async () => {
    const owner = await createOwnerAndBusiness("binv-2c-no-primary");
    cleanupUserIds.push(owner.userId);
    const productId = (await makeSaleProduct(owner.client, owner.businessId, { openingQuantity: 0 })).id;
    const legacyDefaultLocationId = await getDefaultLocationId(owner.client, owner.businessId);
    const worker = await createMemberWithCustomPermissions(owner.businessId, "binv-2c-no-primary", [
      "inventory.adjust",
      "inventory.view_cost",
    ]);
    cleanupUserIds.push(worker.userId);
    const sql = createTestDbClient();
    try {
      const [{ id: workerMemberId }] = await sql<{ id: string }[]>`
        select id from public.business_members where business_id = ${owner.businessId} and user_id = ${worker.userId}
      `;
      await sql`delete from public.business_member_branches where member_id = ${workerMemberId}`;
    } finally {
      await sql.end();
    }

    const { error } = await worker.client.rpc("record_inventory_movement", {
      p_business_id: owner.businessId,
      p_product_id: productId,
      p_inventory_location_id: legacyDefaultLocationId,
      p_movement_type: "ADJUSTMENT_IN",
      p_quantity: 5,
      p_idempotency_key: randomUuid(),
      p_reason: "Should be blocked — no primary branch",
    });
    expect(error?.message).toContain("insufficient_privilege");
  });

  it("the Medium 2C alias never activates for a caller whose PRIMARY branch has since become INACTIVE — inactive branches never silently receive new activity", async () => {
    const owner = await createOwnerAndBusiness("binv-2c-inactive-primary");
    cleanupUserIds.push(owner.userId);
    const productId = (await makeSaleProduct(owner.client, owner.businessId, { openingQuantity: 0 })).id;
    const legacyDefaultLocationId = await getDefaultLocationId(owner.client, owner.businessId);
    const branchB = await createBranch(owner.client, owner.businessId, { name: "Deactivating Branch B" });
    const worker = await createMemberWithCustomPermissions(owner.businessId, "binv-2c-inactive-primary", [
      "inventory.adjust",
      "inventory.view_cost",
    ]);
    cleanupUserIds.push(worker.userId);
    const workerMemberId = await getMemberId(owner.businessId, worker.userId);
    await assignMemberToBranch(owner.client, owner.businessId, workerMemberId, [branchB]);
    await owner.client.rpc("deactivate_business_branch", { p_business_id: owner.businessId, p_branch_id: branchB });

    const { error } = await worker.client.rpc("record_inventory_movement", {
      p_business_id: owner.businessId,
      p_product_id: productId,
      p_inventory_location_id: legacyDefaultLocationId,
      p_movement_type: "ADJUSTMENT_IN",
      p_quantity: 5,
      p_idempotency_key: randomUuid(),
      p_reason: "Should be blocked — inactive primary branch",
    });
    expect(error?.message).toContain("insufficient_privilege");
  });

  it("idempotency reflects the ACTUAL resolved location, not the stale legacy alias — replaying the identical legacy-alias request returns the SAME ledger row, already resolved to Branch B's canonical location", async () => {
    const owner = await createOwnerAndBusiness("binv-2c-idempotent");
    cleanupUserIds.push(owner.userId);
    const productId = (await makeSaleProduct(owner.client, owner.businessId, { openingQuantity: 0 })).id;
    const branchB = await createBranch(owner.client, owner.businessId, { name: "Branch B" });
    const branchBLocationId = await getBranchLocationId(owner.businessId, branchB);
    const legacyDefaultLocationId = await getDefaultLocationId(owner.client, owner.businessId);
    const worker = await createMemberWithCustomPermissions(owner.businessId, "binv-2c-idempotent", [
      "inventory.adjust",
      "inventory.view_cost",
    ]);
    cleanupUserIds.push(worker.userId);
    const workerMemberId = await getMemberId(owner.businessId, worker.userId);
    await assignMemberToBranch(owner.client, owner.businessId, workerMemberId, [branchB]);
    const idempotencyKey = randomUuid();

    const first = await worker.client.rpc("record_inventory_movement", {
      p_business_id: owner.businessId,
      p_product_id: productId,
      p_inventory_location_id: legacyDefaultLocationId,
      p_movement_type: "ADJUSTMENT_IN",
      p_quantity: 5,
      p_idempotency_key: idempotencyKey,
      p_reason: "Legacy-app stock count",
    });
    expect(first.error).toBeNull();
    expect(first.data!.inventory_location_id).toBe(branchBLocationId);

    const replay = await worker.client.rpc("record_inventory_movement", {
      p_business_id: owner.businessId,
      p_product_id: productId,
      p_inventory_location_id: legacyDefaultLocationId,
      p_movement_type: "ADJUSTMENT_IN",
      p_quantity: 5,
      p_idempotency_key: idempotencyKey,
      p_reason: "Legacy-app stock count",
    });
    expect(replay.error).toBeNull();
    expect(replay.data!.id).toBe(first.data!.id);
    expect(replay.data!.inventory_location_id).toBe(branchBLocationId);

    const { data: branchBBalance } = await owner.client
      .from("inventory_balances")
      .select("quantity")
      .eq("business_id", owner.businessId)
      .eq("product_id", productId)
      .eq("inventory_location_id", branchBLocationId)
      .single();
    // A single movement, not two — the replay must not double-apply.
    expect(Number(branchBBalance!.quantity)).toBe(5);
  });
});

describe("inventory ledger/balances — unchanged invariants", () => {
  it("22. the ledger stays append-only — no UPDATE/DELETE grant exists for authenticated even after Phase 1G", async () => {
    const owner = await createOwnerAndBusiness("binv-append-only");
    cleanupUserIds.push(owner.userId);
    const productId = (await makeSaleProduct(owner.client, owner.businessId, { openingQuantity: 5 })).id;
    const { data: ledgerRows } = await owner.client
      .from("inventory_ledger")
      .select("id")
      .eq("business_id", owner.businessId)
      .eq("product_id", productId)
      .limit(1);
    const ledgerId = ledgerRows![0].id;

    const { error: updateError } = await owner.client.from("inventory_ledger").update({ quantity_delta: 999 }).eq("id", ledgerId);
    expect(updateError).not.toBeNull();
    const { error: deleteError } = await owner.client.from("inventory_ledger").delete().eq("id", ledgerId);
    expect(deleteError).not.toBeNull();
  });

  it("23. cost visibility permissions are unaffected by branch awareness — inventory.view_cost is still required for the cost accessor", async () => {
    const owner = await createOwnerAndBusiness("binv-cost-unaffected");
    cleanupUserIds.push(owner.userId);
    const productId = (await makeSaleProduct(owner.client, owner.businessId, { costPrice: 250 })).id;
    const viewer = await createMemberWithCustomPermissions(owner.businessId, "binv-cost-unaffected", ["inventory.view"]);
    cleanupUserIds.push(viewer.userId);

    const { error } = await viewer.client.rpc("get_product_cost", { p_product_id: productId });
    expect(error?.message).toContain("insufficient_privilege");
  });

  it("24. existing balances remain correct after the branch-aware migration — opening stock still reflects on inventory_balances", async () => {
    const owner = await createOwnerAndBusiness("binv-balances-correct");
    cleanupUserIds.push(owner.userId);
    const productId = (await makeSaleProduct(owner.client, owner.businessId, { openingQuantity: 12 })).id;
    const locationId = await getDefaultLocationId(owner.client, owner.businessId);

    const { data: balance } = await owner.client
      .from("inventory_balances")
      .select("quantity")
      .eq("business_id", owner.businessId)
      .eq("product_id", productId)
      .eq("inventory_location_id", locationId)
      .single();
    expect(Number(balance!.quantity)).toBe(12);
  });
});
