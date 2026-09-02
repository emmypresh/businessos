import "server-only";
import { cache } from "react";
import { notFound } from "next/navigation";
import { createClient } from "@/lib/supabase/server";
import { requireUser } from "@/lib/auth/dal";
import { encodeCursor, decodeCursor, DEFAULT_PAGE_SIZE, type Cursor } from "@/lib/pagination";
import { MAX_SEARCH_LENGTH, type ReturnReason } from "@/lib/returns/constants";

// Mirrors lib/branches/dal.ts's own UUID_PATTERN convention — a malformed
// route identifier must never reach Postgres as a raw comparison value.
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export type ReturnListRow = {
  id: string;
  return_number: string;
  sale_id: string;
  sale_number: string;
  branch_name_snapshot: string;
  reason: ReturnReason | null;
  refund_amount: number;
  refund_method: string | null;
  status: string;
  created_at: string;
};

// Backs the returns list — routed through list_returns_for_viewer
// (returns.view-gated alone, 20260902080000_returns_application_picker_rpcs.sql)
// rather than a plain PostgREST select, since the list's own "Sale #"
// column requires a cross-table read into public.sales (gated on
// sales.view, a permission returns.view does not imply) — see that RPC's
// own header comment for the full gap this closes.
export const listReturns = cache(
  async (
    businessId: string,
    options: { search?: string; branchId?: string; reason?: ReturnReason; cursor?: string } = {}
  ): Promise<{ rows: ReturnListRow[]; nextCursor: string | null }> => {
    await requireUser();
    const supabase = await createClient();

    const cursor = decodeCursor(options.cursor);

    // Codex security review, SEC-01: a cheap, deterministic bound — never
    // a rate-limiting subsystem (INFO-01 carryover, deferred to Phase
    // 1P) — applied BEFORE RPC dispatch, mirroring
    // searchReturnableSalesAction's own identical boundSearch truncation
    // (lib/returns/actions.ts). Truncates rather than rejects: list
    // search is a live, as-you-type filter, not a form field with a
    // validation error to show. `undefined` stays `undefined` — slicing
    // only ever runs on an actual string.
    const search = options.search ? options.search.slice(0, MAX_SEARCH_LENGTH) : options.search;

    const { data, error } = await supabase.rpc("list_returns_for_viewer", {
      p_business_id: businessId,
      p_search: search,
      p_branch_id: options.branchId,
      p_reason: options.reason,
      p_cursor_created_at: cursor?.createdAt,
      p_cursor_id: cursor?.id,
      // One extra row requested to detect whether a next page exists —
      // mirrors every other keyset-paginated list in this app exactly.
      p_limit: DEFAULT_PAGE_SIZE + 1,
    });
    if (error) {
      // Codex security review, SEC-02: never interpolate a raw
      // Supabase/PostgREST/database error message into a user-facing
      // error — it can carry SQLSTATE codes, relation/function/schema
      // names, or other internal detail. A generic, controlled message
      // is thrown instead; there is no established server-side
      // diagnostics/logging pattern elsewhere in this codebase to route
      // the original error through, so it is simply not preserved here.
      throw new Error("Unable to load returns.");
    }

    const rows = (data ?? []) as ReturnListRow[];
    const hasMore = rows.length > DEFAULT_PAGE_SIZE;
    const page = hasMore ? rows.slice(0, DEFAULT_PAGE_SIZE) : rows;

    const last = page[page.length - 1];
    const nextCursor = hasMore && last ? encodeCursor({ createdAt: last.created_at, id: last.id }) : null;

    return { rows: page, nextCursor };
  }
);

export type ReturnRow = {
  id: string;
  business_id: string;
  return_number: string;
  sale_id: string;
  branch_id: string;
  branch_name_snapshot: string;
  status: string;
  refund_amount: number;
  refund_method: string | null;
  reason: ReturnReason | null;
  notes: string | null;
  created_by: string;
  created_at: string;
};

const RETURN_COLUMNS =
  "id, business_id, return_number, sale_id, branch_id, branch_name_snapshot, " +
  "status, refund_amount, refund_method, reason, notes, created_by, created_at";

// Explicit column select, gated by public.sale_returns' own RLS
// (returns.view) — no cross-table join needed here (unlike the list),
// since a detail page reads one row at a time and every column it shows
// already lives directly on sale_returns.
export const getReturn = cache(async (businessId: string, returnId: string): Promise<ReturnRow> => {
  await requireUser();
  if (!UUID_PATTERN.test(businessId) || !UUID_PATTERN.test(returnId)) {
    notFound();
  }
  const supabase = await createClient();

  const { data, error } = await supabase
    .from("sale_returns")
    .select(RETURN_COLUMNS)
    .eq("business_id", businessId)
    .eq("id", returnId)
    .maybeSingle();

  if (error) {
    // Codex security review, SEC-02: see listReturns' own identical
    // comment above — never interpolate error.message.
    throw new Error("Unable to load return details.");
  }
  if (!data) {
    notFound();
  }

  return data as unknown as ReturnRow;
});

export type ReturnItemRow = {
  id: string;
  business_id: string;
  sale_return_id: string;
  sale_item_id: string;
  product_id: string;
  product_name_snapshot: string;
  sku_snapshot: string | null;
  quantity: number;
  unit_price_snapshot: number;
  line_total: number;
  restock: boolean;
  position: number;
  created_at: string;
};

// Ordered by the server-assigned `position` column — the caller's own
// submitted line order, never created_at (two lines inserted in the same
// transaction can share an identical timestamp). Mirrors
// lib/invoices/dal.ts's own getInvoiceItems exactly.
export const getReturnItems = cache(async (businessId: string, returnId: string): Promise<ReturnItemRow[]> => {
  await requireUser();
  const supabase = await createClient();

  const { data, error } = await supabase
    .from("sale_return_items")
    .select(
      "id, business_id, sale_return_id, sale_item_id, product_id, product_name_snapshot, sku_snapshot, quantity, unit_price_snapshot, line_total, restock, position, created_at"
    )
    .eq("business_id", businessId)
    .eq("sale_return_id", returnId)
    .order("position", { ascending: true });

  if (error) {
    // Codex security review, SEC-02: see listReturns' own identical
    // comment above — never interpolate error.message.
    throw new Error("Unable to load return items.");
  }
  return (data ?? []) as unknown as ReturnItemRow[];
});

export type ReturnBranchFilterOption = { id: string; name: string; code: string | null; status: string };

// Backs the returns list's branch filter. Authorized on returns.view
// alone via get_returns_branch_filter_options — never branches.view. See
// that RPC's own header comment (20260902080000_returns_application_picker_rpcs.sql).
export const getReturnsBranchFilterOptions = cache(
  async (businessId: string): Promise<ReturnBranchFilterOption[]> => {
    await requireUser();
    const supabase = await createClient();
    const { data, error } = await supabase.rpc("get_returns_branch_filter_options", {
      p_business_id: businessId,
    });
    if (error) {
      // Codex security review, SEC-02: see listReturns' own identical
      // comment above — never interpolate error.message.
      throw new Error("Unable to load return filters.");
    }
    return (data ?? []) as ReturnBranchFilterOption[];
  }
);

export type { Cursor };
