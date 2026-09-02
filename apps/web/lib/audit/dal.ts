import "server-only";
import { cache } from "react";
import { notFound } from "next/navigation";
import { createClient } from "@/lib/supabase/server";
import { requireUser } from "@/lib/auth/dal";
import { encodeCursor, decodeCursor, DEFAULT_PAGE_SIZE, type Cursor } from "@/lib/pagination";
import { buildImatchSearchValue } from "@/lib/search";
import { MAX_SEARCH_LENGTH, type AuditCategory } from "@/lib/audit/constants";

// Mirrors every other Phase 1C-1J domain's own UUID_PATTERN convention —
// a malformed route identifier must never reach Postgres as a raw
// comparison value.
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// SEC-01 remediation: `created_at` is `timestamptz`, which Postgres stores
// at MICROSECOND precision — a literal `T23:59:59.999Z` upper bound (JS
// Date's own maximum sub-second precision is milliseconds) silently
// excludes any real event timestamped between .999000 and .999999 on the
// selected end date. The only precision-independent inclusive-end-date
// boundary is an EXCLUSIVE comparison against the START of the NEXT UTC
// calendar day, so this MUST NOT be re-expressed as a 23:59:59.xxx
// literal of any precision.
//
// `dateString` is already validated as YYYY-MM-DD by ActivityFilterSchema
// before this is ever called. Parsed via `Date.UTC` (never
// `new Date(dateString)` + `.setDate()`) so the result never depends on
// the host machine's local timezone or DST — the Activity feed's date
// filters are UTC-calendar-date based, matching dateFrom's own existing
// `T00:00:00.000Z` semantics, deliberately unchanged here.
function getNextUtcDayStart(dateString: string): string {
  const [year, month, day] = dateString.split("-").map(Number);
  return new Date(Date.UTC(year, month - 1, day + 1)).toISOString();
}

export type ActivityEventRow = {
  id: string;
  business_id: string;
  branch_id: string | null;
  actor_type: string;
  actor_user_id: string | null;
  actor_email_snapshot: string | null;
  actor_name_snapshot: string | null;
  action: string;
  category: string;
  resource_type: string | null;
  resource_id: string | null;
  resource_label_snapshot: string | null;
  outcome: string;
  metadata: Record<string, unknown>;
  created_at: string;
};

const ACTIVITY_COLUMNS =
  "id, business_id, branch_id, actor_type, actor_user_id, actor_email_snapshot, " +
  "actor_name_snapshot, action, category, resource_type, resource_id, " +
  "resource_label_snapshot, outcome, metadata, created_at";

// Backed by a PLAIN, RLS-gated PostgREST query — never a SECURITY DEFINER
// read RPC "just for convenience". Every filter this feed supports
// (search across columns already on this table, category, branch_id,
// actor_user_id, a created_at date range, keyset pagination) is fully
// expressible against audit_events' own columns, which a caller already
// holding audit.view can already read directly under the existing RLS
// policy (20260902090000_create_audit_events.sql) — there is no
// permission-contract gap here the way there was for the branch-name
// filter (see getActivityBranchOptions below, which DOES need a helper,
// for a documented reason).
export const listActivityEvents = cache(
  async (
    businessId: string,
    options: {
      search?: string;
      category?: AuditCategory;
      branchId?: string;
      actorUserId?: string;
      dateFrom?: string;
      dateTo?: string;
      cursor?: string;
    } = {}
  ): Promise<{ rows: ActivityEventRow[]; nextCursor: string | null }> => {
    await requireUser();
    const supabase = await createClient();

    let query = supabase
      .from("audit_events")
      .select(ACTIVITY_COLUMNS)
      .eq("business_id", businessId)
      .order("created_at", { ascending: false })
      .order("id", { ascending: false })
      .limit(DEFAULT_PAGE_SIZE + 1);

    if (options.category) {
      query = query.eq("category", options.category);
    }
    if (options.branchId) {
      query = query.eq("branch_id", options.branchId);
    }
    if (options.actorUserId) {
      query = query.eq("actor_user_id", options.actorUserId);
    }
    if (options.dateFrom) {
      query = query.gte("created_at", `${options.dateFrom}T00:00:00.000Z`);
    }
    if (options.dateTo) {
      query = query.lt("created_at", getNextUtcDayStart(options.dateTo));
    }
    if (options.search) {
      // Codex security review, INFO-01 carryover: a cheap, deterministic
      // bound, applied BEFORE the search string ever reaches the query
      // builder — mirrors every other Phase 1H/1I search DAL's own
      // identical truncation.
      const bounded = options.search.slice(0, MAX_SEARCH_LENGTH);
      const value = buildImatchSearchValue(bounded);
      query = query.or(
        `action.imatch.${value},resource_label_snapshot.imatch.${value},` +
          `actor_name_snapshot.imatch.${value},actor_email_snapshot.imatch.${value}`
      );
    }

    const cursor = decodeCursor(options.cursor);
    if (cursor) {
      query = query.or(
        `created_at.lt.${cursor.createdAt},and(created_at.eq.${cursor.createdAt},id.lt.${cursor.id})`
      );
    }

    const { data, error } = await query;
    if (error) {
      // Never interpolate a raw Supabase/PostgREST/database error
      // message into a user-facing error — see lib/returns/dal.ts's own
      // identical SEC-02 remediation for the full rationale this mirrors.
      throw new Error("Unable to load activity.");
    }

    const rows = (data ?? []) as unknown as ActivityEventRow[];
    const hasMore = rows.length > DEFAULT_PAGE_SIZE;
    const page = hasMore ? rows.slice(0, DEFAULT_PAGE_SIZE) : rows;

    const last = page[page.length - 1];
    const nextCursor = hasMore && last ? encodeCursor({ createdAt: last.created_at, id: last.id }) : null;

    return { rows: page, nextCursor };
  }
);

export const getActivityEvent = cache(async (businessId: string, eventId: string): Promise<ActivityEventRow> => {
  await requireUser();
  if (!UUID_PATTERN.test(businessId) || !UUID_PATTERN.test(eventId)) {
    notFound();
  }
  const supabase = await createClient();

  const { data, error } = await supabase
    .from("audit_events")
    .select(ACTIVITY_COLUMNS)
    .eq("business_id", businessId)
    .eq("id", eventId)
    .maybeSingle();

  if (error) {
    throw new Error("Unable to load activity details.");
  }
  if (!data) {
    notFound();
  }

  return data as unknown as ActivityEventRow;
});

export type ActivityBranchOption = { id: string; name: string; code: string | null; status: string };

// Backs the Activity feed's own branch filter. Authorized on audit.view
// ALONE via get_audit_branch_filter_options — never branches.view. See
// that RPC's own header comment
// (20260902100100_audit_activity_read_helpers.sql) for the exact
// permission-contract gap this closes.
export const getActivityBranchOptions = cache(
  async (businessId: string): Promise<ActivityBranchOption[]> => {
    await requireUser();
    const supabase = await createClient();
    const { data, error } = await supabase.rpc("get_audit_branch_filter_options", {
      p_business_id: businessId,
    });
    if (error) {
      throw new Error("Unable to load activity filters.");
    }
    return (data ?? []) as ActivityBranchOption[];
  }
);

export type ActivityActorOption = { userId: string; name: string | null; email: string | null };

// Backs the Activity feed's own actor filter. Deliberately NOT a new RPC,
// and deliberately NOT dependent on staff.view: derived entirely from
// audit_events' own actor snapshot columns, which a caller already
// holding audit.view can already read directly. Bounded to the most
// recent 500 events (a reasonable MVP heuristic, not a fully
// comprehensive historical actor directory) — de-duplicated here, in the
// server DAL, since PostgREST has no SELECT DISTINCT support.
export const getActivityActorOptions = cache(async (businessId: string): Promise<ActivityActorOption[]> => {
  await requireUser();
  const supabase = await createClient();
  const { data, error } = await supabase
    .from("audit_events")
    .select("actor_user_id, actor_name_snapshot, actor_email_snapshot")
    .eq("business_id", businessId)
    .eq("actor_type", "USER")
    .order("created_at", { ascending: false })
    .limit(500);

  if (error) {
    throw new Error("Unable to load activity filters.");
  }

  const seen = new Map<string, ActivityActorOption>();
  for (const row of (data ?? []) as { actor_user_id: string | null; actor_name_snapshot: string | null; actor_email_snapshot: string | null }[]) {
    if (!row.actor_user_id || seen.has(row.actor_user_id)) continue;
    seen.set(row.actor_user_id, {
      userId: row.actor_user_id,
      name: row.actor_name_snapshot,
      email: row.actor_email_snapshot,
    });
  }
  return Array.from(seen.values());
});

export type { Cursor };
