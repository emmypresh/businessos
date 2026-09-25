import "server-only";
import { cache } from "react";
import { z } from "zod";
import { createClient } from "@/lib/supabase/server";
import { requireUser } from "@/lib/auth/dal";
import { mapDatabaseError } from "@/lib/errors";

// Phase 1N-C3. Allowlisted sort keys — the ONLY values ever sent to
// get_customer_detail_report's p_sort, mirroring that RPC's own plpgsql
// allowlist (see its migration's header comment). Never a raw client
// string forwarded as-is.
export const CUSTOMER_REPORT_SORT_KEYS = ["revenue", "orders", "last_purchase", "name"] as const;
export type CustomerReportSortKey = (typeof CUSTOMER_REPORT_SORT_KEYS)[number];

const QuerySchema = z.object({
  search: z.string().trim().max(200).optional(),
  sort: z.enum(CUSTOMER_REPORT_SORT_KEYS).default("revenue"),
  direction: z.enum(["asc", "desc"]).default("desc"),
  page: z.coerce.number().int().min(1).max(100000).default(1),
});

export function parseCustomerReportQuery(input: {
  search?: string;
  sort?: string;
  direction?: string;
  page?: string;
}) {
  return QuerySchema.parse({
    search: input.search || undefined,
    sort: CUSTOMER_REPORT_SORT_KEYS.includes(input.sort as CustomerReportSortKey) ? input.sort : undefined,
    direction: input.direction === "asc" ? "asc" : undefined,
    page: input.page,
  });
}

export const CUSTOMER_REPORT_PAGE_SIZE = 25;

export type CustomerReportRow = {
  customerId: string;
  name: string;
  phone: string | null;
  email: string | null;
  totalOrders: number;
  revenue: number;
  averageOrderValue: number;
  firstPurchase: string | null;
  lastPurchase: string | null;
  isNew: boolean;
  isReturning: boolean;
};

export type CustomerReport = {
  currencyCode: string;
  kpis: {
    totalCustomers: number;
    activeCustomers: number;
    newCustomers: number;
    returningCustomers: number;
    revenue: number;
    averageRevenuePerActiveCustomer: number;
  };
  rows: CustomerReportRow[];
  totalCount: number;
  page: number;
  pageSize: number;
};

// Deliberately NOT gated on customers.view/sales.view — reports.view alone
// is what get_customer_detail_report itself checks (defense in depth is
// the RPC's job here, exactly like getFinancialSummary's own convention;
// see this file's sibling lib/reports/dal.ts for the identical pattern).
export const getCustomerDetailReport = cache(
  async (
    businessId: string,
    from: string,
    to: string,
    options: { branchId?: string; search?: string; sort?: CustomerReportSortKey; direction?: "asc" | "desc"; page?: number } = {}
  ): Promise<CustomerReport> => {
    await requireUser();
    const supabase = await createClient();

    const { data, error } = await supabase.rpc("get_customer_detail_report", {
      p_business_id: businessId,
      p_from: from,
      p_to: to,
      p_branch_id: options.branchId,
      p_search: options.search,
      p_sort: options.sort ?? "revenue",
      p_direction: options.direction ?? "desc",
      p_page: options.page ?? 1,
      p_page_size: CUSTOMER_REPORT_PAGE_SIZE,
    });

    if (error) {
      throw new Error(mapDatabaseError(error).message);
    }

    const raw = data as {
      currency_code: string;
      kpis: {
        total_customers: number;
        active_customers: number;
        new_customers: number;
        returning_customers: number;
        revenue: number;
        average_revenue_per_active_customer: number;
      };
      rows: {
        customer_id: string;
        name: string;
        phone: string | null;
        email: string | null;
        total_orders: number;
        revenue: number;
        average_order_value: number;
        first_purchase: string | null;
        last_purchase: string | null;
        is_new: boolean;
        is_returning: boolean;
      }[];
      total_count: number;
      page: number;
      page_size: number;
    };

    return {
      currencyCode: raw.currency_code,
      kpis: {
        totalCustomers: raw.kpis.total_customers,
        activeCustomers: raw.kpis.active_customers,
        newCustomers: raw.kpis.new_customers,
        returningCustomers: raw.kpis.returning_customers,
        revenue: raw.kpis.revenue,
        averageRevenuePerActiveCustomer: raw.kpis.average_revenue_per_active_customer,
      },
      rows: raw.rows.map((r) => ({
        customerId: r.customer_id,
        name: r.name,
        phone: r.phone,
        email: r.email,
        totalOrders: r.total_orders,
        revenue: r.revenue,
        averageOrderValue: r.average_order_value,
        firstPurchase: r.first_purchase,
        lastPurchase: r.last_purchase,
        isNew: r.is_new,
        isReturning: r.is_returning,
      })),
      totalCount: raw.total_count,
      page: raw.page,
      pageSize: raw.page_size,
    };
  }
);
