import "server-only";
import { cache } from "react";
import { z } from "zod";
import { createClient } from "@/lib/supabase/server";
import { requireUser } from "@/lib/auth/dal";
import { mapDatabaseError } from "@/lib/errors";

// Phase 1N-C4. Allowlisted sort keys — the ONLY values ever sent to
// get_branch_detail_report's p_sort, mirroring that RPC's own plpgsql
// allowlist. Never a raw client string forwarded as-is.
export const BRANCH_REPORT_SORT_KEYS = [
  "revenue",
  "name",
  "sales_count",
  "average_order_value",
  "active_customers",
  "units_sold",
  "last_sale",
] as const;
export type BranchReportSortKey = (typeof BRANCH_REPORT_SORT_KEYS)[number];

const QuerySchema = z.object({
  search: z.string().trim().max(200).optional(),
  sort: z.enum(BRANCH_REPORT_SORT_KEYS).default("revenue"),
  direction: z.enum(["asc", "desc"]).default("desc"),
  page: z.coerce.number().int().min(1).max(100000).default(1),
});

export function parseBranchReportQuery(input: {
  search?: string;
  sort?: string;
  direction?: string;
  page?: string;
}) {
  return QuerySchema.parse({
    search: input.search || undefined,
    sort: BRANCH_REPORT_SORT_KEYS.includes(input.sort as BranchReportSortKey) ? input.sort : undefined,
    direction: input.direction === "asc" ? "asc" : undefined,
    page: input.page,
  });
}

export const BRANCH_REPORT_PAGE_SIZE = 25;

export type BranchReportRow = {
  branchId: string;
  name: string;
  code: string | null;
  completedSales: number;
  revenue: number;
  averageOrderValue: number;
  activeCustomers: number;
  unitsSold: number;
  movementCount: number;
  expenseTotal: number;
  lastSale: string | null;
  isActiveInPeriod: boolean;
};

export type BranchReportSelectedBranch = {
  branchId: string;
  name: string;
  code: string | null;
  completedSales: number;
  revenue: number;
  averageOrderValue: number;
  activeCustomers: number;
  unitsSold: number;
  lastSale: string | null;
  trend: { date: string; revenue: number }[];
  topProducts: { productId: string; name: string; unitsSold: number }[];
};

export type BranchReport = {
  currencyCode: string;
  kpis: {
    totalBranches: number;
    activeBranches: number;
    completedSales: number;
    revenue: number;
    averageOrderValue: number;
    unitsSold: number;
    activeCustomers: number;
    expenseTotal: number;
  };
  rows: BranchReportRow[];
  totalCount: number;
  page: number;
  pageSize: number;
  selectedBranch: BranchReportSelectedBranch | null;
};

// Deliberately NOT gated on branches.view — reports.view alone is what
// get_branch_detail_report itself checks, exactly like
// getCustomerDetailReport's own sibling convention.
export const getBranchDetailReport = cache(
  async (
    businessId: string,
    from: string,
    to: string,
    options: {
      branchId?: string;
      search?: string;
      sort?: BranchReportSortKey;
      direction?: "asc" | "desc";
      page?: number;
    } = {}
  ): Promise<BranchReport> => {
    await requireUser();
    const supabase = await createClient();

    const { data, error } = await supabase.rpc("get_branch_detail_report", {
      p_business_id: businessId,
      p_from: from,
      p_to: to,
      p_branch_id: options.branchId,
      p_search: options.search,
      p_sort: options.sort ?? "revenue",
      p_direction: options.direction ?? "desc",
      p_page: options.page ?? 1,
      p_page_size: BRANCH_REPORT_PAGE_SIZE,
    });

    if (error) {
      throw new Error(mapDatabaseError(error).message);
    }

    const raw = data as {
      currency_code: string;
      kpis: {
        total_branches: number;
        active_branches: number;
        completed_sales: number;
        revenue: number;
        average_order_value: number;
        units_sold: number;
        active_customers: number;
        expense_total: number;
      };
      rows: {
        branch_id: string;
        name: string;
        code: string | null;
        completed_sales: number;
        revenue: number;
        average_order_value: number;
        active_customers: number;
        units_sold: number;
        movement_count: number;
        expense_total: number;
        last_sale: string | null;
        is_active_in_period: boolean;
      }[];
      total_count: number;
      page: number;
      page_size: number;
      selected_branch: {
        branch_id: string;
        name: string;
        code: string | null;
        completed_sales: number;
        revenue: number;
        average_order_value: number;
        active_customers: number;
        units_sold: number;
        last_sale: string | null;
        trend: { date: string; revenue: number }[];
        top_products: { product_id: string; name: string; units_sold: number }[];
      } | null;
    };

    return {
      currencyCode: raw.currency_code,
      kpis: {
        totalBranches: raw.kpis.total_branches,
        activeBranches: raw.kpis.active_branches,
        completedSales: raw.kpis.completed_sales,
        revenue: raw.kpis.revenue,
        averageOrderValue: raw.kpis.average_order_value,
        unitsSold: raw.kpis.units_sold,
        activeCustomers: raw.kpis.active_customers,
        expenseTotal: raw.kpis.expense_total,
      },
      rows: raw.rows.map((r) => ({
        branchId: r.branch_id,
        name: r.name,
        code: r.code,
        completedSales: r.completed_sales,
        revenue: r.revenue,
        averageOrderValue: r.average_order_value,
        activeCustomers: r.active_customers,
        unitsSold: r.units_sold,
        movementCount: r.movement_count,
        expenseTotal: r.expense_total,
        lastSale: r.last_sale,
        isActiveInPeriod: r.is_active_in_period,
      })),
      totalCount: raw.total_count,
      page: raw.page,
      pageSize: raw.page_size,
      selectedBranch: raw.selected_branch
        ? {
            branchId: raw.selected_branch.branch_id,
            name: raw.selected_branch.name,
            code: raw.selected_branch.code,
            completedSales: raw.selected_branch.completed_sales,
            revenue: raw.selected_branch.revenue,
            averageOrderValue: raw.selected_branch.average_order_value,
            activeCustomers: raw.selected_branch.active_customers,
            unitsSold: raw.selected_branch.units_sold,
            lastSale: raw.selected_branch.last_sale,
            trend: raw.selected_branch.trend,
            topProducts: raw.selected_branch.top_products.map((p) => ({
              productId: p.product_id,
              name: p.name,
              unitsSold: p.units_sold,
            })),
          }
        : null,
    };
  }
);
