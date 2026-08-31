import "server-only";
import { cache } from "react";
import { notFound } from "next/navigation";
import { createClient } from "@/lib/supabase/server";
import { requireUser } from "@/lib/auth/dal";
import { buildImatchSearchValue } from "@/lib/search";
import type { BranchStatus } from "./constants";

// Codex adversarial review, application-layer round 2, Low 3: a malformed
// route identifier (e.g. /branches/not-a-uuid) must never reach Postgres
// as a raw comparison value — that surfaces as a raw 22P02 syntax error
// instead of the generic 404 a nonexistent-but-well-formed id already
// gets. Mirrors lib/expenses/dal.ts's own UUID_PATTERN convention exactly.
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// Explicit column list — never select("*"). created_by is included (it's
// the branch's own creator, safe to display, and already exposed by
// business_branches' own column-restricted SELECT grant to `authenticated`
// — see create_business_branches.sql). There is no creation-key or
// request-ledger column exposed here at all: private.business_branch_creation_requests
// is a `private` schema table with no grant to `authenticated` whatsoever,
// so it is structurally unreachable from this DAL, not merely omitted by
// convention.
const BRANCH_COLUMNS =
  "id, business_id, name, code, address_line1, address_line2, city, state, " +
  "country_code, phone, is_default, status, created_by, created_at, updated_at";

export type BranchRow = {
  id: string;
  business_id: string;
  name: string;
  code: string | null;
  address_line1: string | null;
  address_line2: string | null;
  city: string | null;
  state: string | null;
  country_code: string;
  phone: string | null;
  is_default: boolean;
  status: string;
  created_by: string;
  created_at: string;
  updated_at: string;
};

// Codex adversarial review, application-layer round 2, Low 9: the edit
// form only ever reads/submits id + the seven fields update_business_branch
// actually accepts — it has no use for business_id, created_by,
// created_at, updated_at, status, or is_default at all (status/is_default
// are each their own dedicated action, never part of the edit form's own
// schema — see UpdateBranchSchema's own comment). Serializing the FULL
// BranchRow into the edit page's Client Component sent all six of those
// unnecessary fields across the Server -> Client boundary for no reason.
// This narrow projection is what the edit page now passes down instead.
export type BranchEditValues = {
  id: string;
  name: string;
  code: string | null;
  address_line1: string | null;
  address_line2: string | null;
  city: string | null;
  state: string | null;
  country_code: string;
  phone: string | null;
};

export function toBranchEditValues(branch: BranchRow): BranchEditValues {
  return {
    id: branch.id,
    name: branch.name,
    code: branch.code,
    address_line1: branch.address_line1,
    address_line2: branch.address_line2,
    city: branch.city,
    state: branch.state,
    country_code: branch.country_code,
    phone: branch.phone,
  };
}

// Branches are a small, business-scoped operational reference list (tens,
// not thousands, of rows per business even for a large multi-branch SME)
// — an unpaginated list ordered for a stable, predictable management UI
// (default branch first, then alphabetical), mirroring
// listExpenseCategories' own "small reference list, no pagination needed"
// treatment exactly, rather than adopting keyset pagination for a dataset
// that will realistically never need it in Phase 1F.
export const listBranches = cache(
  async (
    businessId: string,
    options: { search?: string; status?: BranchStatus } = {}
  ): Promise<BranchRow[]> => {
    await requireUser();
    const supabase = await createClient();

    let query = supabase
      .from("business_branches")
      .select(BRANCH_COLUMNS)
      .eq("business_id", businessId)
      .order("is_default", { ascending: false })
      .order("name", { ascending: true });

    if (options.status) {
      query = query.eq("status", options.status);
    }
    if (options.search) {
      // Same hardened imatch encoder used by every other Phase 1C–1E
      // free-text search — see lib/search.ts's own header comment for the
      // full injection/wildcard-aliasing history this defends against.
      const value = buildImatchSearchValue(options.search);
      query = query.or(`name.imatch.${value},code.imatch.${value}`);
    }

    const { data, error } = await query;
    if (error) {
      throw new Error(`Failed to load branches: ${error.message}`);
    }

    return (data ?? []) as unknown as BranchRow[];
  }
);

export const getBranch = cache(async (businessId: string, branchId: string): Promise<BranchRow> => {
  await requireUser();
  // A malformed businessId or branchId (from the route segment, never
  // trusted) resolves to the same generic 404 a genuinely nonexistent
  // one gets below — never a raw database call.
  if (!UUID_PATTERN.test(businessId) || !UUID_PATTERN.test(branchId)) {
    notFound();
  }
  const supabase = await createClient();

  const { data, error } = await supabase
    .from("business_branches")
    .select(BRANCH_COLUMNS)
    .eq("business_id", businessId)
    .eq("id", branchId)
    .maybeSingle();

  if (error) {
    throw new Error(`Failed to load branch: ${error.message}`);
  }
  if (!data) {
    notFound();
  }

  return data as unknown as BranchRow;
});

export type BranchOption = { id: string; name: string; code: string | null };

// The staff-invite / branch-access-editor picker — ACTIVE only (an
// inactive branch can never be selected for a new assignment; the RPC
// layer independently enforces this too — see replace_member_branches'/
// create_business_invitation's own BRANCH_NOT_ACTIVE check), minimal
// columns, ordered the same way the main list is for a familiar,
// predictable picker order.
export const listActiveBranchesForPicker = cache(
  async (businessId: string): Promise<BranchOption[]> => {
    const rows = await listBranches(businessId, { status: "ACTIVE" });
    return rows.map((r) => ({ id: r.id, name: r.name, code: r.code }));
  }
);

// Phase 1G remediation round 2 — RPC-backed branch-option contract --------
//
// Every branch-aware picker in this app now resolves its options through
// ONE database RPC, public.get_business_branch_options, scoped by an
// explicit finite PURPOSE string (never a raw permission name — see the
// RPC's own header comment in
// supabase/migrations/20260830080000_branch_option_rpc.sql). This
// replaces the previous approach of reading business_branches through an
// embedded business_member_branches join, which (Codex adversarial
// review, application-layer round 2, Blocker 1) silently depended on the
// caller ALSO holding branches.view — an unrelated permission — purely
// because PostgREST enforces each embedded table's own RLS independently.
// The RPC is SECURITY DEFINER and authorizes each scope on the exact
// permission that already gates the real operation it backs, so a
// sales.create-only (or expenses.manage-only, reports.view-only, ...)
// caller with no branches.view now resolves real branch names, not an
// empty/degraded result — there is no longer any "unresolved assignment"
// state to represent at this layer.
//
// Five scopes, five thin wrappers below — never one shared "give me
// branches" helper spread across every surface with an ad hoc permission
// argument: each wrapper name says which real workflow it backs, and each
// is fixed to its own scope string, never accepting one from the caller
// (a browser can never choose which scope this hits).
type BranchOptionScope = "operations" | "expenses" | "reports" | "sales_filter" | "inventory_filter";

type RawBranchOptionRow = {
  id: string;
  name: string;
  code: string | null;
  status: string;
  is_default: boolean;
  is_primary: boolean;
};

async function getBranchOptionRows(businessId: string, scope: BranchOptionScope): Promise<RawBranchOptionRow[]> {
  await requireUser();
  const supabase = await createClient();

  const { data, error } = await supabase.rpc("get_business_branch_options", {
    p_business_id: businessId,
    p_scope: scope,
  });

  if (error) {
    throw new Error(`Failed to load branch options: ${error.message}`);
  }
  return data ?? [];
}

// operations ---------------------------------------------------------------
//
// Backs sale creation, product opening stock, and inventory adjustment —
// the caller's OWN assigned, ACTIVE branches only (never every branch of
// the business, unlike the four business-wide scopes below). Ordered
// primary-first, then alphabetically, exactly as the RPC itself returns
// it.
export type OperationalBranchOption = {
  id: string;
  name: string;
  code: string | null;
  isPrimary: boolean;
  isDefault: boolean;
};

export type OperationalBranchOptions = {
  options: OperationalBranchOption[];
  primaryBranchId: string | null;
};

export const getOperationalBranchOptions = cache(
  async (businessId: string): Promise<OperationalBranchOptions> => {
    const rows = await getBranchOptionRows(businessId, "operations");
    const options: OperationalBranchOption[] = rows.map((r) => ({
      id: r.id,
      name: r.name,
      code: r.code,
      isPrimary: r.is_primary,
      isDefault: r.is_default,
    }));
    const primaryBranchId = options.find((o) => o.isPrimary)?.id ?? null;
    return { options, primaryBranchId };
  }
);

// expenses -------------------------------------------------------------
//
// Backs expense-branch attribution. Matches create_expense's own
// authorization exactly (expenses.manage alone, no has_branch_access) —
// every ACTIVE branch of the business is a legitimate choice, never
// narrowed to the caller's own operational assignment. primaryBranchId is
// still surfaced (the RPC flags the caller's own assigned primary branch,
// if any, even within this business-wide result) purely because the
// expense form defaults ITS OWN selection to the caller's primary branch
// as a convenience, alongside the always-available explicit "Company-wide"
// choice — never used to restrict which branches are offered.
export type ExpenseBranchOption = { id: string; name: string };

export type ExpenseBranchOptions = {
  options: ExpenseBranchOption[];
  primaryBranchId: string | null;
};

export const listExpenseBranchOptions = cache(
  async (businessId: string): Promise<ExpenseBranchOptions> => {
    const rows = await getBranchOptionRows(businessId, "expenses");
    const options: ExpenseBranchOption[] = rows.map((r) => ({ id: r.id, name: r.name }));
    const primaryBranchId = rows.find((r) => r.is_primary)?.id ?? null;
    return { options, primaryBranchId };
  }
);

// reports ----------------------------------------------------------------
//
// Backs the financial-report branch filter. Matches get_financial_summary's
// own authorization exactly (reports.view alone) and, uniquely among the
// five scopes, includes INACTIVE branches — historical reporting for a
// since-deactivated branch must remain selectable.
export type ReportBranchOption = { id: string; name: string; status: string };

export const listReportBranchOptions = cache(
  async (businessId: string): Promise<ReportBranchOption[]> => {
    const rows = await getBranchOptionRows(businessId, "reports");
    return rows.map((r) => ({ id: r.id, name: r.name, status: r.status }));
  }
);

// sales_filter -------------------------------------------------------------
//
// Backs the sales list's branch filter. sales.view is business-wide with
// no per-branch restriction, and a historical sale can reference a
// since-deactivated branch — so, like reports, this includes INACTIVE
// branches and imposes no operational-assignment restriction.
export type SalesFilterBranchOption = { id: string; name: string; status: string };

export const listSalesFilterBranchOptions = cache(
  async (businessId: string): Promise<SalesFilterBranchOption[]> => {
    const rows = await getBranchOptionRows(businessId, "sales_filter");
    return rows.map((r) => ({ id: r.id, name: r.name, status: r.status }));
  }
);

// inventory_filter -----------------------------------------------------
//
// Backs the inventory overview's branch filter. inventory.view is
// business-wide (never narrowed to operational assignment — see
// getInventoryOverview's own header comment in lib/inventory/dal.ts).
// ACTIVE only: unlike reports/sales history, current inventory has no
// stated need to filter by a branch that can no longer receive stock
// activity at all.
export type InventoryFilterBranchOption = { id: string; name: string };

export const listInventoryFilterBranchOptions = cache(
  async (businessId: string): Promise<InventoryFilterBranchOption[]> => {
    const rows = await getBranchOptionRows(businessId, "inventory_filter");
    return rows.map((r) => ({ id: r.id, name: r.name }));
  }
);
