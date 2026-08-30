import { describe, expect, it, afterEach } from "vitest";
import { deleteTestUser } from "./helpers/admin-client";
import {
  createOwnerAndBusiness,
  createMemberWithCustomPermissions,
  randomUuid,
} from "./helpers/inventory";
import { makeSaleProduct, saleItem } from "./helpers/sales";
import {
  getDefaultBranchId,
  createBranch,
  getBranchLocationId,
  assignMemberToBranch,
  getMemberId,
} from "./helpers/staff";
import { createTestDbClient } from "./helpers/db-client";

// Phase 1G: branch-aware sales. Every sale now carries an authoritative
// branch_id, resolved and access-checked by public.create_sale itself
// (20260829080100_branch_aware_sales.sql) — never trusted from the
// application layer alone.
//
// NOTE on fixture design: public.replace_member_branches (Phase 1F,
// frozen) explicitly forbids a caller from ever targeting their OWN
// membership (CANNOT_MANAGE_SELF) — a deliberate, already-reviewed
// restriction this phase does not touch or weaken. This means the OWNER
// fixture below can only ever be granted branch access to their
// business's own DEFAULT branch (auto-assigned by
// ensure_member_branch_access.sql at business-creation time) — never to
// any branch created afterward, by themselves. Tests that need an actor
// with explicit access to a SECOND, non-default branch therefore use a
// dedicated staff member the OWNER assigns (never the OWNER acting on
// themselves) — exactly the realistic "OWNER creates a branch, then
// assigns a staff member to operate there" workflow.

let cleanupUserIds: string[] = [];
afterEach(async () => {
  for (const id of cleanupUserIds) await deleteTestUser(id);
  cleanupUserIds = [];
});

describe("create_sale — branch resolution and backward compatibility", () => {
  it("1. a sale created by the OWNER without p_branch_id (the pre-Phase-1G calling pattern) resolves to the OWNER's own primary branch — which happens to be the business default, since ensure_member_branch_access.sql assigns it there", async () => {
    const owner = await createOwnerAndBusiness("bsale-default");
    cleanupUserIds.push(owner.userId);
    const productId = (await makeSaleProduct(owner.client, owner.businessId)).id;
    const defaultBranchId = await getDefaultBranchId(owner.client, owner.businessId);

    const { data: saleId, error } = await owner.client.rpc("create_sale", {
      p_business_id: owner.businessId,
      p_creation_key: randomUuid(),
      p_items: [saleItem(productId, 1)],
    });
    expect(error).toBeNull();

    const { data: sale } = await owner.client.from("sales").select("branch_id, branch_name_snapshot").eq("id", saleId!).single();
    expect(sale!.branch_id).toBe(defaultBranchId);
    expect(sale!.branch_name_snapshot).toBe("Main Branch");
  });

  it("Medium 2A confirmed defect: a Branch-B-only SALES member using the OLD app-style omitted p_branch_id succeeds and operates on Branch B — never the business default they have no access to", async () => {
    const owner = await createOwnerAndBusiness("bsale-branchb-legacy");
    cleanupUserIds.push(owner.userId);
    // Not tracking inventory: this test proves branch RESOLUTION (via the
    // seller's own primary), never stock deduction specifics (covered by
    // tests 11/12 above).
    const productId = (await makeSaleProduct(owner.client, owner.businessId, { trackInventory: false })).id;
    const branchB = await createBranch(owner.client, owner.businessId, { name: "Branch B" });
    const seller = await createMemberWithCustomPermissions(owner.businessId, "bsale-branchb-legacy", ["sales.create"]);
    cleanupUserIds.push(seller.userId);
    const sellerMemberId = await getMemberId(owner.businessId, seller.userId);
    // Branch B ONLY, and it is their PRIMARY (assignMemberToBranch/
    // replace_member_branches makes the sole assigned branch the primary
    // by default — see that helper's own p_primary_branch_id default).
    await assignMemberToBranch(owner.client, owner.businessId, sellerMemberId, [branchB]);

    // The exact current, UNMODIFIED Phase 1F application's own calling
    // shape: createSale (lib/sales/actions.ts) never sends a p_branch_id
    // key at all today.
    const { data: saleId, error } = await seller.client.rpc("create_sale", {
      p_business_id: owner.businessId,
      p_creation_key: randomUuid(),
      p_items: [saleItem(productId, 1)],
    });
    expect(error).toBeNull();

    const { data: sale } = await owner.client.from("sales").select("branch_id, branch_name_snapshot").eq("id", saleId!).single();
    expect(sale!.branch_id).toBe(branchB);
    expect(sale!.branch_name_snapshot).toBe("Branch B");
  });

  it("an omitted p_branch_id for a caller with NO primary branch assignment at all fails with a controlled, safe error", async () => {
    const owner = await createOwnerAndBusiness("bsale-no-primary");
    cleanupUserIds.push(owner.userId);
    const productId = (await makeSaleProduct(owner.client, owner.businessId, { trackInventory: false })).id;
    const seller = await createMemberWithCustomPermissions(owner.businessId, "bsale-no-primary", ["sales.create"]);
    cleanupUserIds.push(seller.userId);
    // Strip the default assignment the fixture normally grants, via raw
    // SQL (no RPC can ever construct a zero-assignment ACTIVE member —
    // see ensure_member_branch_access.sql's own LOCKED INVARIANT
    // reasoning; this reconstructs the state deliberately, purely to
    // prove the defensive guard).
    const sql = createTestDbClient();
    try {
      const [{ id: sellerMemberId }] = await sql<{ id: string }[]>`
        select id from public.business_members where business_id = ${owner.businessId} and user_id = ${seller.userId}
      `;
      await sql`delete from public.business_member_branches where member_id = ${sellerMemberId}`;
    } finally {
      await sql.end();
    }

    const { error } = await seller.client.rpc("create_sale", {
      p_business_id: owner.businessId,
      p_creation_key: randomUuid(),
      p_items: [saleItem(productId, 1)],
    });
    expect(error?.message).toContain("NO_PRIMARY_BRANCH_ASSIGNED");
  });

  it("2. an explicit, ACTIVE, same-tenant branch the caller has access to succeeds and is recorded on the sale", async () => {
    const owner = await createOwnerAndBusiness("bsale-explicit");
    cleanupUserIds.push(owner.userId);
    // Not tracking inventory: this test proves explicit branch acceptance,
    // never stock deduction (opening stock always lands at the DEFAULT
    // branch's location — see makeSaleProduct's own comment — which would
    // otherwise make a sale at a DIFFERENT branch fail with an unrelated
    // INSUFFICIENT_STOCK).
    const productId = (await makeSaleProduct(owner.client, owner.businessId, { trackInventory: false })).id;
    const branchId = await createBranch(owner.client, owner.businessId, { name: "Branch Two" });
    const seller = await createMemberWithCustomPermissions(owner.businessId, "bsale-explicit", ["sales.create"]);
    cleanupUserIds.push(seller.userId);
    const sellerMemberId = await getMemberId(owner.businessId, seller.userId);
    await assignMemberToBranch(owner.client, owner.businessId, sellerMemberId, [branchId]);

    const { data: saleId, error } = await seller.client.rpc("create_sale", {
      p_business_id: owner.businessId,
      p_creation_key: randomUuid(),
      p_items: [saleItem(productId, 1)],
      p_branch_id: branchId,
    });
    expect(error).toBeNull();

    const { data: sale } = await owner.client.from("sales").select("branch_id, branch_name_snapshot").eq("id", saleId!).single();
    expect(sale!.branch_id).toBe(branchId);
    expect(sale!.branch_name_snapshot).toBe("Branch Two");
  });

  it("3. a foreign-tenant branch id is rejected with BRANCH_NOT_FOUND", async () => {
    const owner = await createOwnerAndBusiness("bsale-foreign-a");
    const stranger = await createOwnerAndBusiness("bsale-foreign-b");
    cleanupUserIds.push(owner.userId, stranger.userId);
    const productId = (await makeSaleProduct(owner.client, owner.businessId)).id;
    const strangerBranchId = await getDefaultBranchId(stranger.client, stranger.businessId);

    const { error } = await owner.client.rpc("create_sale", {
      p_business_id: owner.businessId,
      p_creation_key: randomUuid(),
      p_items: [saleItem(productId, 1)],
      p_branch_id: strangerBranchId,
    });
    expect(error?.message).toContain("BRANCH_NOT_FOUND");
  });

  it("4. an INACTIVE, same-tenant branch is rejected (has_branch_access itself requires ACTIVE) even for a caller who would otherwise be assigned there", async () => {
    const owner = await createOwnerAndBusiness("bsale-inactive");
    cleanupUserIds.push(owner.userId);
    const productId = (await makeSaleProduct(owner.client, owner.businessId)).id;
    const branchId = await createBranch(owner.client, owner.businessId, { name: "Soon Inactive" });
    const seller = await createMemberWithCustomPermissions(owner.businessId, "bsale-inactive", ["sales.create"]);
    cleanupUserIds.push(seller.userId);
    const sellerMemberId = await getMemberId(owner.businessId, seller.userId);
    await assignMemberToBranch(owner.client, owner.businessId, sellerMemberId, [branchId]);
    await owner.client.rpc("deactivate_business_branch", { p_business_id: owner.businessId, p_branch_id: branchId });

    const { error } = await seller.client.rpc("create_sale", {
      p_business_id: owner.businessId,
      p_creation_key: randomUuid(),
      p_items: [saleItem(productId, 1)],
      p_branch_id: branchId,
    });
    expect(error?.message).toContain("insufficient_privilege");
  });

  it("5. a caller without branch access is rejected, even holding sales.create", async () => {
    const owner = await createOwnerAndBusiness("bsale-no-access");
    cleanupUserIds.push(owner.userId);
    const productId = (await makeSaleProduct(owner.client, owner.businessId)).id;
    const branchId = await createBranch(owner.client, owner.businessId, { name: "Unassigned Branch" });
    const seller = await createMemberWithCustomPermissions(owner.businessId, "bsale-no-access", ["sales.create"]);
    cleanupUserIds.push(seller.userId);
    // seller has real access to the business's own DEFAULT branch only
    // (createMemberWithCustomPermissions's own fixture now grants that —
    // see helpers/inventory.ts's addMemberWithRole) — never to this
    // separate, freshly-created `branchId`.

    const { error } = await seller.client.rpc("create_sale", {
      p_business_id: owner.businessId,
      p_creation_key: randomUuid(),
      p_items: [saleItem(productId, 1)],
      p_branch_id: branchId,
    });
    expect(error?.message).toContain("insufficient_privilege");
  });

  it("6. a caller WITH sales.create AND branch access succeeds", async () => {
    const owner = await createOwnerAndBusiness("bsale-has-access");
    cleanupUserIds.push(owner.userId);
    const productId = (await makeSaleProduct(owner.client, owner.businessId)).id;
    const defaultBranchId = await getDefaultBranchId(owner.client, owner.businessId);
    const seller = await createMemberWithCustomPermissions(owner.businessId, "bsale-has-access", ["sales.create"]);
    cleanupUserIds.push(seller.userId);
    const sellerMemberId = await getMemberId(owner.businessId, seller.userId);
    await assignMemberToBranch(owner.client, owner.businessId, sellerMemberId, [defaultBranchId]);

    const { error } = await seller.client.rpc("create_sale", {
      p_business_id: owner.businessId,
      p_creation_key: randomUuid(),
      p_items: [saleItem(productId, 1)],
      p_branch_id: defaultBranchId,
    });
    expect(error).toBeNull();
  });

  it("7. sales.create alone, without branch access, is insufficient (the two are independently required)", async () => {
    const owner = await createOwnerAndBusiness("bsale-perm-only");
    cleanupUserIds.push(owner.userId);
    const productId = (await makeSaleProduct(owner.client, owner.businessId)).id;
    // A NON-default branch, deliberately: createMemberWithCustomPermissions's
    // own fixture (helpers/inventory.ts's addMemberWithRole) now gives every
    // new member real access to the business's DEFAULT branch — matching
    // what any genuinely onboarded staff member actually has (see that
    // helper's own Phase 1G comment) — so proving "branch access absent"
    // requires targeting a branch that default assignment does NOT cover.
    const branchId = await createBranch(owner.client, owner.businessId, { name: "Perm Only Test Branch" });
    const seller = await createMemberWithCustomPermissions(owner.businessId, "bsale-perm-only", ["sales.create"]);
    cleanupUserIds.push(seller.userId);
    // No assignMemberToBranch call for `branchId` at all.

    const { error } = await seller.client.rpc("create_sale", {
      p_business_id: owner.businessId,
      p_creation_key: randomUuid(),
      p_items: [saleItem(productId, 1)],
      p_branch_id: branchId,
    });
    expect(error?.message).toContain("insufficient_privilege");
  });

  it("8. branch access alone, without sales.create, is insufficient", async () => {
    const owner = await createOwnerAndBusiness("bsale-branch-only");
    cleanupUserIds.push(owner.userId);
    const productId = (await makeSaleProduct(owner.client, owner.businessId)).id;
    const defaultBranchId = await getDefaultBranchId(owner.client, owner.businessId);
    // branches.view only — no sales.create at all.
    const viewer = await createMemberWithCustomPermissions(owner.businessId, "bsale-branch-only", ["branches.view"]);
    cleanupUserIds.push(viewer.userId);
    const viewerMemberId = await getMemberId(owner.businessId, viewer.userId);
    await assignMemberToBranch(owner.client, owner.businessId, viewerMemberId, [defaultBranchId]);

    const { error } = await viewer.client.rpc("create_sale", {
      p_business_id: owner.businessId,
      p_creation_key: randomUuid(),
      p_items: [saleItem(productId, 1)],
      p_branch_id: defaultBranchId,
    });
    expect(error?.message).toContain("insufficient_privilege");
  });

  it("9. branch_id is part of the canonical idempotency payload — an exact replay (same branch) returns the same sale", async () => {
    const owner = await createOwnerAndBusiness("bsale-idem-replay");
    cleanupUserIds.push(owner.userId);
    const productId = (await makeSaleProduct(owner.client, owner.businessId)).id;
    const defaultBranchId = await getDefaultBranchId(owner.client, owner.businessId);
    const creationKey = randomUuid();

    const { data: first, error: firstError } = await owner.client.rpc("create_sale", {
      p_business_id: owner.businessId,
      p_creation_key: creationKey,
      p_items: [saleItem(productId, 1)],
      p_branch_id: defaultBranchId,
    });
    expect(firstError).toBeNull();

    const { data: second, error: secondError } = await owner.client.rpc("create_sale", {
      p_business_id: owner.businessId,
      p_creation_key: creationKey,
      p_items: [saleItem(productId, 1)],
      p_branch_id: defaultBranchId,
    });
    expect(secondError).toBeNull();
    expect(second).toBe(first);
  });

  it("10. a reused creation_key with a DIFFERENT branch is rejected as payload reuse, not silently resolved", async () => {
    const owner = await createOwnerAndBusiness("bsale-idem-conflict");
    cleanupUserIds.push(owner.userId);
    const productId = (await makeSaleProduct(owner.client, owner.businessId)).id;
    const defaultBranchId = await getDefaultBranchId(owner.client, owner.businessId);
    const secondBranchId = await createBranch(owner.client, owner.businessId, { name: "Conflict Branch" });
    const seller = await createMemberWithCustomPermissions(owner.businessId, "bsale-idem-conflict", ["sales.create"]);
    cleanupUserIds.push(seller.userId);
    const sellerMemberId = await getMemberId(owner.businessId, seller.userId);
    await assignMemberToBranch(owner.client, owner.businessId, sellerMemberId, [defaultBranchId, secondBranchId]);
    const creationKey = randomUuid();

    const { error: firstError } = await seller.client.rpc("create_sale", {
      p_business_id: owner.businessId,
      p_creation_key: creationKey,
      p_items: [saleItem(productId, 1)],
      p_branch_id: defaultBranchId,
    });
    expect(firstError).toBeNull();

    const { error: secondError } = await seller.client.rpc("create_sale", {
      p_business_id: owner.businessId,
      p_creation_key: creationKey,
      p_items: [saleItem(productId, 1)],
      p_branch_id: secondBranchId,
    });
    expect(secondError?.message).toContain("SALE_IDEMPOTENCY_KEY_REUSED");
  });

  it("11/12. stock is deducted ONLY from the selected branch's own canonical location — never a different branch's", async () => {
    const owner = await createOwnerAndBusiness("bsale-stock-branch");
    cleanupUserIds.push(owner.userId);
    const productId = (await makeSaleProduct(owner.client, owner.businessId, { openingQuantity: 10 })).id;
    const defaultBranchId = await getDefaultBranchId(owner.client, owner.businessId);
    const secondBranchId = await createBranch(owner.client, owner.businessId, { name: "Other Stock Branch" });
    const seller = await createMemberWithCustomPermissions(owner.businessId, "bsale-stock-branch", ["sales.create"]);
    cleanupUserIds.push(seller.userId);
    const sellerMemberId = await getMemberId(owner.businessId, seller.userId);
    await assignMemberToBranch(owner.client, owner.businessId, sellerMemberId, [defaultBranchId, secondBranchId]);

    const defaultLocationId = await getBranchLocationId(owner.businessId, defaultBranchId);
    const secondLocationId = await getBranchLocationId(owner.businessId, secondBranchId);
    expect(secondLocationId).not.toBe(defaultLocationId);

    // Opening stock (10 units) landed at the DEFAULT branch's location
    // only (makeSaleProduct/create_product defaults to the business-wide
    // default location, which the previous migration proves IS the
    // default branch's own canonical location for a single-branch
    // business). A sale against the SECOND branch must therefore fail —
    // proving stock is genuinely scoped per branch/location, not pooled
    // business-wide.
    const { error: crossBranchError } = await seller.client.rpc("create_sale", {
      p_business_id: owner.businessId,
      p_creation_key: randomUuid(),
      p_items: [saleItem(productId, 1)],
      p_branch_id: secondBranchId,
    });
    expect(crossBranchError?.message).toContain("INSUFFICIENT_STOCK");

    // The SAME product, sold against the DEFAULT branch (where the real
    // stock actually is), succeeds and deducts from that branch's own
    // location.
    const { error: sameBranchError } = await seller.client.rpc("create_sale", {
      p_business_id: owner.businessId,
      p_creation_key: randomUuid(),
      p_items: [saleItem(productId, 3)],
      p_branch_id: defaultBranchId,
    });
    expect(sameBranchError).toBeNull();

    const { data: balance } = await owner.client
      .from("inventory_balances")
      .select("quantity")
      .eq("business_id", owner.businessId)
      .eq("product_id", productId)
      .eq("inventory_location_id", defaultLocationId)
      .single();
    expect(Number(balance!.quantity)).toBe(7);
  });

  it("13. the no-negative-stock invariant is preserved for a branch-scoped sale", async () => {
    const owner = await createOwnerAndBusiness("bsale-no-negative");
    cleanupUserIds.push(owner.userId);
    const productId = (await makeSaleProduct(owner.client, owner.businessId, { openingQuantity: 2 })).id;
    const defaultBranchId = await getDefaultBranchId(owner.client, owner.businessId);

    const { error } = await owner.client.rpc("create_sale", {
      p_business_id: owner.businessId,
      p_creation_key: randomUuid(),
      p_items: [saleItem(productId, 5)],
      p_branch_id: defaultBranchId,
    });
    expect(error?.message).toContain("INSUFFICIENT_STOCK");
  });

  it("14. sale snapshot semantics are unchanged — a branch rename after the fact does not alter an already-completed sale's rendering", async () => {
    const owner = await createOwnerAndBusiness("bsale-snapshot");
    cleanupUserIds.push(owner.userId);
    const productId = (await makeSaleProduct(owner.client, owner.businessId, { trackInventory: false })).id;
    const branchId = await createBranch(owner.client, owner.businessId, { name: "Original Branch Name" });
    const seller = await createMemberWithCustomPermissions(owner.businessId, "bsale-snapshot", ["sales.create"]);
    cleanupUserIds.push(seller.userId);
    const sellerMemberId = await getMemberId(owner.businessId, seller.userId);
    await assignMemberToBranch(owner.client, owner.businessId, sellerMemberId, [branchId]);

    const { data: saleId } = await seller.client.rpc("create_sale", {
      p_business_id: owner.businessId,
      p_creation_key: randomUuid(),
      p_items: [saleItem(productId, 1)],
      p_branch_id: branchId,
    });

    await owner.client.rpc("update_business_branch", {
      p_business_id: owner.businessId,
      p_branch_id: branchId,
      p_name: "Renamed Branch",
    });

    const { data: sale } = await owner.client.from("sales").select("branch_name_snapshot").eq("id", saleId!).single();
    expect(sale!.branch_name_snapshot).toBe("Original Branch Name");
  });

  it("15. a historical sale at a since-deactivated branch remains readable to a sales.view holder", async () => {
    const owner = await createOwnerAndBusiness("bsale-inactive-history");
    cleanupUserIds.push(owner.userId);
    const productId = (await makeSaleProduct(owner.client, owner.businessId, { trackInventory: false })).id;
    const branchId = await createBranch(owner.client, owner.businessId, { name: "Will Go Inactive" });
    const seller = await createMemberWithCustomPermissions(owner.businessId, "bsale-inactive-history", ["sales.create"]);
    cleanupUserIds.push(seller.userId);
    const sellerMemberId = await getMemberId(owner.businessId, seller.userId);
    await assignMemberToBranch(owner.client, owner.businessId, sellerMemberId, [branchId]);

    const { data: saleId } = await seller.client.rpc("create_sale", {
      p_business_id: owner.businessId,
      p_creation_key: randomUuid(),
      p_items: [saleItem(productId, 1)],
      p_branch_id: branchId,
    });

    await owner.client.rpc("deactivate_business_branch", { p_business_id: owner.businessId, p_branch_id: branchId });

    // sales.view is business-wide (Phase 1D's own established RLS
    // treatment, deliberately unchanged by Phase 1G — see the migration's
    // own header comment) — history must remain visible regardless of the
    // branch's now-inactive status. Read via the OWNER (who never lost any
    // access) — reading never required has_branch_access to begin with.
    const { data: sale, error } = await owner.client.from("sales").select("id, branch_id").eq("id", saleId!).single();
    expect(error).toBeNull();
    expect(sale!.branch_id).toBe(branchId);
  });
});

describe("create_sale — Medium 4: omitted-branch idempotency is stored, never recomputed on replay", () => {
  it("A. key K, NULL branch resolves A; retry key K, NULL, resolver still A => same sale", async () => {
    const owner = await createOwnerAndBusiness("bsale-idem-a");
    cleanupUserIds.push(owner.userId);
    const productId = (await makeSaleProduct(owner.client, owner.businessId, { trackInventory: false })).id;
    const branchA = await createBranch(owner.client, owner.businessId, { name: "Idem Branch A" });
    const seller = await createMemberWithCustomPermissions(owner.businessId, "bsale-idem-a", ["sales.create"]);
    cleanupUserIds.push(seller.userId);
    const sellerMemberId = await getMemberId(owner.businessId, seller.userId);
    await assignMemberToBranch(owner.client, owner.businessId, sellerMemberId, [branchA]);
    const key = randomUuid();

    const { data: first, error: firstError } = await seller.client.rpc("create_sale", {
      p_business_id: owner.businessId,
      p_creation_key: key,
      p_items: [saleItem(productId, 1)],
    });
    expect(firstError).toBeNull();

    const { data: second, error: secondError } = await seller.client.rpc("create_sale", {
      p_business_id: owner.businessId,
      p_creation_key: key,
      p_items: [saleItem(productId, 1)],
    });
    expect(secondError).toBeNull();
    expect(second).toBe(first);

    const { data: sale } = await owner.client.from("sales").select("branch_id").eq("id", first!).single();
    expect(sale!.branch_id).toBe(branchA);
  });

  it("B. key K, NULL resolves A; business DEFAULT branch changes; retry key K, NULL => same original sale (regression coverage for the original confirmed defect)", async () => {
    const owner = await createOwnerAndBusiness("bsale-idem-b");
    cleanupUserIds.push(owner.userId);
    const productId = (await makeSaleProduct(owner.client, owner.businessId, { trackInventory: false })).id;
    const defaultBranchId = await getDefaultBranchId(owner.client, owner.businessId);
    const key = randomUuid();

    // OWNER's primary IS the default branch — the original confirmed
    // defect (re-resolving against the business default on replay) would
    // have manifested for exactly this caller.
    const { data: first, error: firstError } = await owner.client.rpc("create_sale", {
      p_business_id: owner.businessId,
      p_creation_key: key,
      p_items: [saleItem(productId, 1)],
    });
    expect(firstError).toBeNull();

    const newDefaultBranch = await createBranch(owner.client, owner.businessId, { name: "New Business Default" });
    const { error: switchError } = await owner.client.rpc("set_default_business_branch", {
      p_business_id: owner.businessId,
      p_branch_id: newDefaultBranch,
    });
    expect(switchError).toBeNull();

    const { data: second, error: secondError } = await owner.client.rpc("create_sale", {
      p_business_id: owner.businessId,
      p_creation_key: key,
      p_items: [saleItem(productId, 1)],
    });
    expect(secondError).toBeNull();
    expect(second).toBe(first);

    const { data: sale } = await owner.client.from("sales").select("branch_id").eq("id", first!).single();
    expect(sale!.branch_id).toBe(defaultBranchId); // still the ORIGINAL branch, never the new default
  });

  it("C. key K, NULL resolves A; caller's PRIMARY branch is changed to B by an authorized admin; retry key K, NULL => same original sale — proving resolution is genuinely STORED, not recomputed", async () => {
    const owner = await createOwnerAndBusiness("bsale-idem-c");
    cleanupUserIds.push(owner.userId);
    const productId = (await makeSaleProduct(owner.client, owner.businessId, { trackInventory: false })).id;
    const branchA = await createBranch(owner.client, owner.businessId, { name: "Idem C Branch A" });
    const branchB = await createBranch(owner.client, owner.businessId, { name: "Idem C Branch B" });
    const seller = await createMemberWithCustomPermissions(owner.businessId, "bsale-idem-c", ["sales.create"]);
    cleanupUserIds.push(seller.userId);
    const sellerMemberId = await getMemberId(owner.businessId, seller.userId);
    await assignMemberToBranch(owner.client, owner.businessId, sellerMemberId, [branchA]);
    const key = randomUuid();

    const { data: first, error: firstError } = await seller.client.rpc("create_sale", {
      p_business_id: owner.businessId,
      p_creation_key: key,
      p_items: [saleItem(productId, 1)],
    });
    expect(firstError).toBeNull();

    // A SECOND, authorized staff.manage admin reassigns the seller's
    // primary branch to B — never the seller acting on themselves
    // (replace_member_branches forbids that).
    const admin = await createMemberWithCustomPermissions(owner.businessId, "bsale-idem-c-admin", ["staff.manage"]);
    cleanupUserIds.push(admin.userId);
    await assignMemberToBranch(admin.client, owner.businessId, sellerMemberId, [branchB]);

    const { data: second, error: secondError } = await seller.client.rpc("create_sale", {
      p_business_id: owner.businessId,
      p_creation_key: key,
      p_items: [saleItem(productId, 1)],
    });
    expect(secondError).toBeNull();
    expect(second).toBe(first);

    const { data: sale } = await owner.client.from("sales").select("branch_id").eq("id", first!).single();
    expect(sale!.branch_id).toBe(branchA); // the ORIGINAL resolution, never re-resolved to the new primary B
  });

  it("D. key K, explicit A, then explicit B => reuse rejected", async () => {
    const owner = await createOwnerAndBusiness("bsale-idem-d");
    cleanupUserIds.push(owner.userId);
    const productId = (await makeSaleProduct(owner.client, owner.businessId, { trackInventory: false })).id;
    const branchA = await createBranch(owner.client, owner.businessId, { name: "Idem D Branch A" });
    const branchB = await createBranch(owner.client, owner.businessId, { name: "Idem D Branch B" });
    const seller = await createMemberWithCustomPermissions(owner.businessId, "bsale-idem-d", ["sales.create"]);
    cleanupUserIds.push(seller.userId);
    const sellerMemberId = await getMemberId(owner.businessId, seller.userId);
    await assignMemberToBranch(owner.client, owner.businessId, sellerMemberId, [branchA, branchB]);
    const key = randomUuid();

    const { error: firstError } = await seller.client.rpc("create_sale", {
      p_business_id: owner.businessId,
      p_creation_key: key,
      p_items: [saleItem(productId, 1)],
      p_branch_id: branchA,
    });
    expect(firstError).toBeNull();

    const { error: secondError } = await seller.client.rpc("create_sale", {
      p_business_id: owner.businessId,
      p_creation_key: key,
      p_items: [saleItem(productId, 1)],
      p_branch_id: branchB,
    });
    expect(secondError?.message).toContain("SALE_IDEMPOTENCY_KEY_REUSED");
  });

  it("E. key K, NULL resolved A, then explicit B => reuse rejected", async () => {
    const owner = await createOwnerAndBusiness("bsale-idem-e");
    cleanupUserIds.push(owner.userId);
    const productId = (await makeSaleProduct(owner.client, owner.businessId, { trackInventory: false })).id;
    const branchA = await createBranch(owner.client, owner.businessId, { name: "Idem E Branch A" });
    const branchB = await createBranch(owner.client, owner.businessId, { name: "Idem E Branch B" });
    const seller = await createMemberWithCustomPermissions(owner.businessId, "bsale-idem-e", ["sales.create"]);
    cleanupUserIds.push(seller.userId);
    const sellerMemberId = await getMemberId(owner.businessId, seller.userId);
    await assignMemberToBranch(owner.client, owner.businessId, sellerMemberId, [branchA, branchB]);
    const key = randomUuid();

    const { error: firstError } = await seller.client.rpc("create_sale", {
      p_business_id: owner.businessId,
      p_creation_key: key,
      p_items: [saleItem(productId, 1)],
    });
    expect(firstError).toBeNull();

    const { error: secondError } = await seller.client.rpc("create_sale", {
      p_business_id: owner.businessId,
      p_creation_key: key,
      p_items: [saleItem(productId, 1)],
      p_branch_id: branchB,
    });
    expect(secondError?.message).toContain("SALE_IDEMPOTENCY_KEY_REUSED");
  });

  it("F. key K, NULL resolved A, then explicit A (same authoritative branch) => allowed, returns the original sale — explicit-vs-omitted is irrelevant once both resolve to the identical branch", async () => {
    const owner = await createOwnerAndBusiness("bsale-idem-f");
    cleanupUserIds.push(owner.userId);
    const productId = (await makeSaleProduct(owner.client, owner.businessId, { trackInventory: false })).id;
    const branchA = await createBranch(owner.client, owner.businessId, { name: "Idem F Branch A" });
    const seller = await createMemberWithCustomPermissions(owner.businessId, "bsale-idem-f", ["sales.create"]);
    cleanupUserIds.push(seller.userId);
    const sellerMemberId = await getMemberId(owner.businessId, seller.userId);
    await assignMemberToBranch(owner.client, owner.businessId, sellerMemberId, [branchA]);
    const key = randomUuid();

    const { data: first, error: firstError } = await seller.client.rpc("create_sale", {
      p_business_id: owner.businessId,
      p_creation_key: key,
      p_items: [saleItem(productId, 1)],
    });
    expect(firstError).toBeNull();

    const { data: second, error: secondError } = await seller.client.rpc("create_sale", {
      p_business_id: owner.businessId,
      p_creation_key: key,
      p_items: [saleItem(productId, 1)],
      p_branch_id: branchA,
    });
    expect(secondError).toBeNull();
    expect(second).toBe(first);
  });
});

describe("create_sale — structural proof of the default-branch invariant", () => {
  it("every business has exactly one ACTIVE default branch, always, by construction", async () => {
    const owner = await createOwnerAndBusiness("bsale-default-proof");
    cleanupUserIds.push(owner.userId);
    const sql = createTestDbClient();
    try {
      const rows = await sql<{ count: string; status: string }[]>`
        select count(*)::text as count, max(status) as status
        from public.business_branches
        where business_id = ${owner.businessId} and is_default = true
      `;
      expect(rows[0].count).toBe("1");
      expect(rows[0].status).toBe("ACTIVE");
    } finally {
      await sql.end();
    }
  });

  it("the auto-created OWNER has real, immediate operational access to the business's own default branch", async () => {
    const owner = await createOwnerAndBusiness("bsale-owner-access");
    cleanupUserIds.push(owner.userId);
    const defaultBranchId = await getDefaultBranchId(owner.client, owner.businessId);

    const { data: hasAccess, error } = await owner.client.rpc("has_branch_access", {
      p_business_id: owner.businessId,
      p_branch_id: defaultBranchId,
    });
    expect(error).toBeNull();
    expect(hasAccess).toBe(true);
  });
});
