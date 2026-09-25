// Phase 1Q-0D blocker remediation: /sales/new must fail closed with
// CurrencyUnavailableState (never a raw throw, never a silent NGN
// fallback) when the authoritative business record can't be loaded —
// mirrors products/new and expenses/new's own established pattern.
import { beforeEach, describe, expect, it, vi } from "vitest";

const { requirePermissionOrNotFound, getBusinessDetails } = vi.hoisted(() => ({
  requirePermissionOrNotFound: vi.fn(),
  getBusinessDetails: vi.fn(),
}));
const { listCustomers } = vi.hoisted(() => ({ listCustomers: vi.fn() }));
const { getOperationalBranchOptions } = vi.hoisted(() => ({ getOperationalBranchOptions: vi.fn() }));

vi.mock("@/lib/business/dal", () => ({ requirePermissionOrNotFound, getBusinessDetails }));
vi.mock("@/lib/customers/dal", () => ({ listCustomers }));
vi.mock("@/lib/branches/dal", () => ({ getOperationalBranchOptions }));
vi.mock("@/components/sales/sale-form", () => ({ SaleForm: (props: Record<string, unknown>) => ({ type: "SaleForm", props }) }));
vi.mock("@/components/business/currency-unavailable-state", () => ({
  CurrencyUnavailableState: (props: Record<string, unknown>) => ({ type: "CurrencyUnavailableState", props }),
}));

function typeName(el: { type?: unknown }): string {
  return typeof el.type === "string" ? el.type : typeof el.type === "function" ? (el.type as { name: string }).name : String(el.type);
}

const NewSalePage = (await import("@/app/[businessId]/sales/new/page")).default;

const businessId = "11111111-1111-4111-8111-111111111111";

function renderTree(element: unknown): string[] {
  if (element === null || typeof element !== "object") return [];
  const el = element as { type?: unknown; props?: { children?: unknown } };
  const label = typeof el.type === "string" ? el.type : typeof el.type === "function" ? el.type.name : String(el.type);
  const children = el.props?.children;
  const childList = Array.isArray(children) ? children : children !== undefined ? [children] : [];
  return [label, ...childList.flatMap(renderTree)];
}

describe("NewSalePage missing-currency path", () => {
  beforeEach(() => {
    requirePermissionOrNotFound.mockReset();
    getBusinessDetails.mockReset();
    listCustomers.mockReset();
    getOperationalBranchOptions.mockReset();
    requirePermissionOrNotFound.mockResolvedValue(new Set(["sales.create"]));
    listCustomers.mockResolvedValue({ rows: [] });
    getOperationalBranchOptions.mockResolvedValue({ options: [{ id: "branch-a", name: "Main" }], primaryBranchId: "branch-a" });
  });

  it("renders CurrencyUnavailableState, never throws, when the business record fails to load", async () => {
    getBusinessDetails.mockResolvedValue(null);

    const element = await NewSalePage({
      params: Promise.resolve({ businessId }),
      searchParams: Promise.resolve({}),
    });

    expect(typeName(element as { type?: unknown })).toBe("CurrencyUnavailableState");
    expect((element as { props: { action: string } }).props.action).toBe("record a sale");
  });

  it("never renders SaleForm under an assumed NGN currency when the business record is missing", async () => {
    getBusinessDetails.mockResolvedValue(null);

    const element = await NewSalePage({
      params: Promise.resolve({ businessId }),
      searchParams: Promise.resolve({}),
    });

    expect(renderTree(element)).not.toContain("SaleForm");
  });

  it("renders SaleForm with the business's real (non-NGN) currency when the business record loads", async () => {
    getBusinessDetails.mockResolvedValue({ id: businessId, currency_code: "GHS", country_code: "GH" });

    const element = (await NewSalePage({
      params: Promise.resolve({ businessId }),
      searchParams: Promise.resolve({}),
    })) as { props: { children: unknown[] } };

    const saleForm = (element.props.children as unknown[]).flat(Infinity).find(
      (child): child is { type: unknown; props: Record<string, unknown> } =>
        Boolean(child) && typeof child === "object" && typeName(child as { type?: unknown }) === "SaleForm"
    );
    expect(saleForm?.props.currencyCode).toBe("GHS");
  });
});
