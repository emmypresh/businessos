import { describe, expect, it, vi, afterEach } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";
import type { Database } from "@/lib/supabase/database.types";
import { deleteTestUser } from "./helpers/admin-client";
import { createOwnerAndBusiness, createMemberWithCustomPermissions, randomUuid } from "./helpers/inventory";
import { makeSaleProduct, makeCustomer } from "./helpers/sales";
import { PERMISSION } from "@/lib/business/constants";

/**
 * Codex review round 2, Finding 4: every SEEDED role (SALES, ACCOUNTANT,
 * ...) bundles several Phase 1D permissions together, so no seeded role
 * can prove two permissions are checked independently rather than one
 * implying the other. These tests use deliberately constructed,
 * nonstandard fixture roles (helpers/inventory.ts's
 * createMemberWithCustomPermissions) that hold EXACTLY one permission and
 * nothing else, then exercise the real Server Action / page code paths
 * against them — never a permission-helper mock standing in for the real
 * check.
 */

let currentClient: SupabaseClient<Database>;

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
vi.mock("next/cache", () => ({
  revalidatePath: () => {},
}));

const { createSale } = await import("@/lib/sales/actions");
const CustomerDetailPage = (await import("@/app/[businessId]/customers/[customerId]/page")).default;
const salesDal = await import("@/lib/sales/dal");

function isRedirect(e: unknown): boolean {
  return (
    typeof e === "object" &&
    e !== null &&
    "digest" in e &&
    typeof (e as { digest?: unknown }).digest === "string" &&
    (e as { digest: string }).digest.startsWith("NEXT_REDIRECT")
  );
}

// Mirrors Next's own getURLFromRedirectError exactly (next/dist/client/components/redirect.js):
// `${REDIRECT_ERROR_CODE};${type};${url};${statusCode};` — decoded here
// from the public, documented digest shape rather than importing an
// internal API.
function redirectUrl(e: unknown): string | undefined {
  if (!isRedirect(e)) return undefined;
  return (e as { digest: string }).digest.split(";").slice(2, -2).join(";");
}

// The page/component tree returned here is an UNRENDERED React element
// tree (plain React.createElement objects) — walking .props.children
// never invokes Card/Link/SaleListTable's own function bodies, so this is
// safe to do without a DOM or a real Next request context.
function containsText(node: unknown, text: string): boolean {
  if (typeof node === "string") return node.includes(text);
  if (Array.isArray(node)) return node.some((n) => containsText(n, text));
  if (node && typeof node === "object" && "props" in (node as Record<string, unknown>)) {
    return containsText((node as { props?: { children?: unknown } }).props?.children, text);
  }
  return false;
}

function formData(fields: Record<string, string>): FormData {
  const fd = new FormData();
  for (const [k, v] of Object.entries(fields)) fd.set(k, v);
  return fd;
}

let cleanupUserIds: string[] = [];
afterEach(async () => {
  for (const id of cleanupUserIds) await deleteTestUser(id);
  cleanupUserIds = [];
});

describe("A. sales.create=true, sales.view=false", () => {
  it("creation succeeds and redirects to the safe destination, never to the sale detail route, and the list/detail remain unavailable", async () => {
    const owner = await createOwnerAndBusiness("perm-a-create-only");
    cleanupUserIds.push(owner.userId);
    const product = await makeSaleProduct(owner.client, owner.businessId, { openingQuantity: 5 });
    const member = await createMemberWithCustomPermissions(owner.businessId, "perm-a-create-only", [
      PERMISSION.SALES_CREATE,
    ]);
    cleanupUserIds.push(member.userId);

    currentClient = member.client;
    let caught: unknown;
    try {
      await createSale(
        undefined,
        formData({
          businessId: owner.businessId,
          creationKey: randomUuid(),
          items: JSON.stringify([{ productId: product.id, quantity: "1" }]),
          paymentStatus: "UNPAID",
        })
      );
    } catch (e) {
      caught = e;
    }
    expect(isRedirect(caught)).toBe(true);
    // The safe, sales.view-independent destination — never the sale
    // detail route, which this caller cannot reach.
    expect(redirectUrl(caught)).toBe(`/${owner.businessId}/sales/new?created=1`);

    // The sale genuinely exists — creation itself was not blocked.
    const { data: sales } = await owner.client.from("sales").select("id").eq("business_id", owner.businessId);
    expect(sales).toHaveLength(1);
    const saleId = sales![0].id;

    // But sales.view — not sales.create — is what actually gates reading
    // sales back, at the exact same RLS layer the list/detail DAL and
    // routes rely on.
    const { data: listResult, error: listError } = await member.client
      .from("sales")
      .select("id")
      .eq("business_id", owner.businessId);
    expect(listError).toBeNull();
    expect(listResult).toEqual([]);

    const { data: detailResult } = await member.client
      .from("sales")
      .select("id")
      .eq("id", saleId)
      .maybeSingle();
    expect(detailResult).toBeNull();
  });
});

describe("B. customers.view=true, sales.view=false", () => {
  it("customer detail renders, but the sale-history DAL is never called and no sale history is rendered", async () => {
    const owner = await createOwnerAndBusiness("perm-b-view-only");
    cleanupUserIds.push(owner.userId);
    const customerId = await makeCustomer(owner.client, owner.businessId, { name: "Perm B Customer" });
    const member = await createMemberWithCustomPermissions(owner.businessId, "perm-b-view-only", [
      PERMISSION.CUSTOMERS_VIEW,
    ]);
    cleanupUserIds.push(member.userId);

    currentClient = member.client;
    const listSpy = vi.spyOn(salesDal, "listSalesForCustomer");
    try {
      const element = await CustomerDetailPage({
        params: Promise.resolve({ businessId: owner.businessId, customerId }),
        searchParams: Promise.resolve({}),
      });

      expect(listSpy).not.toHaveBeenCalled();
      expect(containsText(element, "Perm B Customer")).toBe(true);
      expect(containsText(element, "Sale history")).toBe(false);
    } finally {
      listSpy.mockRestore();
    }
  });
});

describe("C. customers.manage=true, customers.view=false", () => {
  it("the customer detail route still requires customers.view specifically — manage does not imply view", async () => {
    const owner = await createOwnerAndBusiness("perm-c-manage-only");
    cleanupUserIds.push(owner.userId);
    const customerId = await makeCustomer(owner.client, owner.businessId, { name: "Perm C Customer" });
    const member = await createMemberWithCustomPermissions(owner.businessId, "perm-c-manage-only", [
      PERMISSION.CUSTOMERS_MANAGE,
    ]);
    cleanupUserIds.push(member.userId);

    currentClient = member.client;
    // requirePermissionOrNotFound calls next/navigation's notFound(),
    // which throws a NEXT_NOT_FOUND-tagged error outside a real request —
    // the throw itself is the proof, matching the existing
    // customer-dal.test.ts convention for the exact same mechanism.
    await expect(
      CustomerDetailPage({
        params: Promise.resolve({ businessId: owner.businessId, customerId }),
        searchParams: Promise.resolve({}),
      })
    ).rejects.toThrow();
  });
});
