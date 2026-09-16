import { beforeEach, describe, expect, it, vi } from "vitest";

const { getBusinessMembership, getPermissions } = vi.hoisted(() => ({ getBusinessMembership: vi.fn(), getPermissions: vi.fn() }));
const { getFinancialSummary, getManagementReportingAggregate } = vi.hoisted(() => ({ getFinancialSummary: vi.fn(), getManagementReportingAggregate: vi.fn() }));

vi.mock("@/lib/business/dal", () => ({ getBusinessMembership, getPermissions }));
vi.mock("@/lib/reports/dal", () => ({ getFinancialSummary, getManagementReportingAggregate }));
vi.mock("@/components/dashboard/management-overview", () => ({ ManagementOverview: (props: Record<string, unknown>) => ({ type: "ManagementOverview", props }) }));

const BusinessDashboardPage = (await import("@/app/[businessId]/page")).default;

const businessId = "11111111-1111-4111-8111-111111111111";
const summary = { currencyCode: "NGN", grossSales: 0, cashCollected: 0, outstandingSales: 0, expenses: 0, netCashFlow: 0, salesCount: 0, expenseCount: 0 };
const reporting = { salesTrend: [], customerSummary: { newCustomers: 0, returningCustomers: 0, repeatCustomers: 0 }, inventoryRisk: { lowStockProducts: 0, outOfStockProducts: 0, slowMovingProducts: 0 }, branchPerformance: [], whatsappFollowUpCount: null };

describe("BusinessDashboardPage reports.view path", () => {
  beforeEach(() => {
    getBusinessMembership.mockReset(); getPermissions.mockReset(); getFinancialSummary.mockReset(); getManagementReportingAggregate.mockReset();
    getBusinessMembership.mockResolvedValue({ businesses: { name: "Acme" }, roles: { name: "Member" } });
    getFinancialSummary.mockResolvedValue(summary); getManagementReportingAggregate.mockResolvedValue(reporting);
  });

  it("renders the KPI overview only for reports.view and requests adjacent UTC comparable ranges server-side", async () => {
    getPermissions.mockResolvedValue(new Set(["reports.view"]));
    const element = (await BusinessDashboardPage({ params: Promise.resolve({ businessId }), searchParams: Promise.resolve({}) })) as { props: Record<string, unknown> };
    expect(element.props.businessId).toBe(businessId);
    expect(getFinancialSummary).toHaveBeenCalledTimes(2);
    expect(getManagementReportingAggregate).toHaveBeenCalledTimes(2);
    const calls = getManagementReportingAggregate.mock.calls.map((call) => call.slice(1));
    expect(new Date(calls[0][1] as string).getTime() - new Date(calls[0][0] as string).getTime()).toBe(new Date(calls[1][1] as string).getTime() - new Date(calls[1][0] as string).getTime());
    expect(calls[1][1]).toBe(calls[0][0]);
  });

  it("preserves the welcome view and makes no protected reporting call without reports.view", async () => {
    getPermissions.mockResolvedValue(new Set());
    const element = await BusinessDashboardPage({ params: Promise.resolve({ businessId }), searchParams: Promise.resolve({}) });
    expect(getFinancialSummary).not.toHaveBeenCalled();
    expect(getManagementReportingAggregate).not.toHaveBeenCalled();
    expect(element).toMatchObject({ props: { children: expect.anything() } });
  });
});
