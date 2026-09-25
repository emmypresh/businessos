// Phase 1Q-0D blocker remediation: /invoices/new must fail closed with
// CurrencyUnavailableState (never a raw throw, never a silent NGN
// fallback) when the authoritative business record can't be loaded —
// mirrors sales/new.test.tsx's coverage.
import { beforeEach, describe, expect, it, vi } from "vitest";

const { requirePermissionOrNotFound, getBusinessDetails } = vi.hoisted(() => ({
  requirePermissionOrNotFound: vi.fn(),
  getBusinessDetails: vi.fn(),
}));
const { getInvoiceBranchOptions } = vi.hoisted(() => ({ getInvoiceBranchOptions: vi.fn() }));

vi.mock("@/lib/business/dal", () => ({ requirePermissionOrNotFound, getBusinessDetails }));
vi.mock("@/lib/invoices/dal", () => ({ getInvoiceBranchOptions }));
vi.mock("@/components/invoices/invoice-form", () => ({ InvoiceForm: (props: Record<string, unknown>) => ({ type: "InvoiceForm", props }) }));
vi.mock("@/components/business/currency-unavailable-state", () => ({
  CurrencyUnavailableState: (props: Record<string, unknown>) => ({ type: "CurrencyUnavailableState", props }),
}));

function typeName(el: { type?: unknown }): string {
  return typeof el.type === "string" ? el.type : typeof el.type === "function" ? (el.type as { name: string }).name : String(el.type);
}

const NewInvoicePage = (await import("@/app/[businessId]/invoices/new/page")).default;

const businessId = "11111111-1111-4111-8111-111111111111";

describe("NewInvoicePage missing-currency path", () => {
  beforeEach(() => {
    requirePermissionOrNotFound.mockReset();
    getBusinessDetails.mockReset();
    getInvoiceBranchOptions.mockReset();
    requirePermissionOrNotFound.mockResolvedValue(new Set(["invoices.manage"]));
    getInvoiceBranchOptions.mockResolvedValue({ options: [{ id: "branch-a", name: "Main" }], primaryBranchId: "branch-a" });
  });

  it("renders CurrencyUnavailableState, never throws, when the business record fails to load", async () => {
    getBusinessDetails.mockResolvedValue(null);

    const element = await NewInvoicePage({
      params: Promise.resolve({ businessId }),
      searchParams: Promise.resolve({}),
    });

    expect(typeName(element as { type?: unknown })).toBe("CurrencyUnavailableState");
    expect((element as { props: { action: string } }).props.action).toBe("create an invoice");
  });

  it("renders InvoiceForm with the business's real (non-NGN) currency when the business record loads", async () => {
    getBusinessDetails.mockResolvedValue({ id: businessId, currency_code: "KES", country_code: "KE" });

    const element = (await NewInvoicePage({
      params: Promise.resolve({ businessId }),
      searchParams: Promise.resolve({}),
    })) as { props: { children: unknown[] } };

    const invoiceForm = (element.props.children as unknown[]).flat(Infinity).find(
      (child): child is { type: unknown; props: Record<string, unknown> } =>
        Boolean(child) && typeof child === "object" && typeName(child as { type?: unknown }) === "InvoiceForm"
    );
    expect(invoiceForm?.props.currencyCode).toBe("KES");
  });
});
