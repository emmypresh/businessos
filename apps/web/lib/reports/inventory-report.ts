import "server-only";
import { cache } from "react";
import { z } from "zod";
import { createClient } from "@/lib/supabase/server";
import { requireUser } from "@/lib/auth/dal";
import { mapDatabaseError } from "@/lib/errors";

export const INVENTORY_REPORT_SORT_KEYS = ["units_sold", "quantity", "movements", "name"] as const;
export type InventoryReportSortKey = (typeof INVENTORY_REPORT_SORT_KEYS)[number];

const QuerySchema = z.object({
  search: z.string().trim().max(200).optional(),
  sort: z.enum(INVENTORY_REPORT_SORT_KEYS).default("units_sold"),
  direction: z.enum(["asc", "desc"]).default("desc"),
  page: z.coerce.number().int().min(1).max(100000).default(1),
});

export function parseInventoryReportQuery(input: {
  search?: string;
  sort?: string;
  direction?: string;
  page?: string;
}) {
  return QuerySchema.parse({
    search: input.search || undefined,
    sort: INVENTORY_REPORT_SORT_KEYS.includes(input.sort as InventoryReportSortKey) ? input.sort : undefined,
    direction: input.direction === "asc" ? "asc" : undefined,
    page: input.page,
  });
}

export const INVENTORY_REPORT_PAGE_SIZE = 25;

export type StockStatus = "in_stock" | "low_stock" | "out_of_stock";

export type InventoryReportRow = {
  productId: string;
  name: string;
  sku: string | null;
  currentQuantity: number;
  unitsSold: number;
  movementCount: number;
  lastMovement: string | null;
  stockStatus: StockStatus;
};

export type InventoryReport = {
  currencyCode: string;
  kpis: {
    totalProducts: number;
    inStock: number;
    lowStock: number;
    outOfStock: number;
    unitsSold: number;
    movements: number;
  };
  rows: InventoryReportRow[];
  totalCount: number;
  page: number;
  pageSize: number;
};

// Deliberately NOT gated on inventory.view/products.view — reports.view
// alone is what get_inventory_detail_report itself checks, exactly like
// getCustomerDetailReport's own sibling convention.
export const getInventoryDetailReport = cache(
  async (
    businessId: string,
    from: string,
    to: string,
    options: { branchId?: string; search?: string; sort?: InventoryReportSortKey; direction?: "asc" | "desc"; page?: number } = {}
  ): Promise<InventoryReport> => {
    await requireUser();
    const supabase = await createClient();

    const { data, error } = await supabase.rpc("get_inventory_detail_report", {
      p_business_id: businessId,
      p_from: from,
      p_to: to,
      p_branch_id: options.branchId,
      p_search: options.search,
      p_sort: options.sort ?? "units_sold",
      p_direction: options.direction ?? "desc",
      p_page: options.page ?? 1,
      p_page_size: INVENTORY_REPORT_PAGE_SIZE,
    });

    if (error) {
      throw new Error(mapDatabaseError(error).message);
    }

    const raw = data as {
      currency_code: string;
      kpis: {
        total_products: number;
        in_stock: number;
        low_stock: number;
        out_of_stock: number;
        units_sold: number;
        movements: number;
      };
      rows: {
        product_id: string;
        name: string;
        sku: string | null;
        current_quantity: number;
        units_sold: number;
        movement_count: number;
        last_movement: string | null;
        stock_status: StockStatus;
      }[];
      total_count: number;
      page: number;
      page_size: number;
    };

    return {
      currencyCode: raw.currency_code,
      kpis: {
        totalProducts: raw.kpis.total_products,
        inStock: raw.kpis.in_stock,
        lowStock: raw.kpis.low_stock,
        outOfStock: raw.kpis.out_of_stock,
        unitsSold: raw.kpis.units_sold,
        movements: raw.kpis.movements,
      },
      rows: raw.rows.map((r) => ({
        productId: r.product_id,
        name: r.name,
        sku: r.sku,
        currentQuantity: r.current_quantity,
        unitsSold: r.units_sold,
        movementCount: r.movement_count,
        lastMovement: r.last_movement,
        stockStatus: r.stock_status,
      })),
      totalCount: raw.total_count,
      page: raw.page,
      pageSize: raw.page_size,
    };
  }
);
