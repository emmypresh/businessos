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
