import "server-only";
import { cache } from "react";
import { createClient } from "@/lib/supabase/server";
import { requireUser } from "@/lib/auth/dal";
import {
  encodeCursor,
  decodeCursor,
  isCanonicalUuid,
  isCanonicalTimestamptz,
  type Cursor,
} from "@/lib/pagination";
import { buildImatchSearchValue } from "@/lib/search";
import {
  MAX_SEARCH_LENGTH,
  DEFAULT_NOTIFICATION_PAGE_SIZE,
  BELL_RECENT_LIMIT,
  type NotificationCategory,
  type NotificationSeverity,
} from "@/lib/notifications/constants";

// Backed by PLAIN, RLS-gated PostgREST queries — never a SECURITY
// DEFINER read RPC "just for convenience", mirroring lib/audit/dal.ts's
// own established rationale exactly: every filter this feed supports is
// fully expressible against notifications'/notification_recipients' own
// RLS-visible columns, for a caller who already holds a real recipient
// row — there is no permission-contract gap here the way there was for
// the Activity feed's own branch-name filter.

const NOTIFICATION_COLUMNS =
  "id, business_id, branch_id, category, notification_type, title, body, " +
  "severity, resource_type, resource_id, metadata, created_at";

export type NotificationRow = {
  id: string;
  business_id: string;
  branch_id: string | null;
  category: string;
  notification_type: string;
  title: string;
  body: string | null;
  severity: string;
  resource_type: string | null;
  resource_id: string | null;
  metadata: Record<string, unknown>;
  created_at: string;
  // The CALLER's own recipient row — never another user's. recipientId
  // is what markNotificationReadAction/markNotificationsSeenAction
  // target; a notification the caller cannot see never has one.
  recipientId: string;
  readAt: string | null;
  seenAt: string | null;
};

type RawRow = {
  id: string;
  business_id: string;
  branch_id: string | null;
  category: string;
  notification_type: string;
  title: string;
  body: string | null;
  severity: string;
  resource_type: string | null;
  resource_id: string | null;
  metadata: Record<string, unknown>;
  created_at: string;
  notification_recipients: { id: string; read_at: string | null; seen_at: string | null }[];
};

function toNotificationRow(row: RawRow): NotificationRow {
  // `!inner`-embedded, scoped to the caller's own user_id (see every
  // query below) — at most one match, per notification_recipients' own
  // `unique (notification_id, user_id)` constraint.
  const recipient = row.notification_recipients[0];
  return {
    id: row.id,
    business_id: row.business_id,
    branch_id: row.branch_id,
    category: row.category,
    notification_type: row.notification_type,
    title: row.title,
    body: row.body,
    severity: row.severity,
    resource_type: row.resource_type,
    resource_id: row.resource_id,
    metadata: row.metadata,
    created_at: row.created_at,
    recipientId: recipient.id,
    readAt: recipient.read_at,
    seenAt: recipient.seen_at,
  };
}

export const listNotificationsForCurrentUser = cache(
  async (
    businessId: string,
    options: {
      search?: string;
      category?: NotificationCategory;
      severity?: NotificationSeverity;
      readState?: "unread" | "read";
      cursor?: string;
    } = {}
  ): Promise<{ rows: NotificationRow[]; nextCursor: string | null }> => {
    const user = await requireUser();
    const supabase = await createClient();

    let query = supabase
      .from("notifications")
      .select(`${NOTIFICATION_COLUMNS}, notification_recipients!inner(id, read_at, seen_at, user_id)`)
      .eq("business_id", businessId)
      .eq("notification_recipients.user_id", user.id)
      .order("created_at", { ascending: false })
      .order("id", { ascending: false })
      .limit(DEFAULT_NOTIFICATION_PAGE_SIZE + 1);

    if (options.category) {
      query = query.eq("category", options.category);
    }
    if (options.severity) {
      query = query.eq("severity", options.severity);
    }
    if (options.readState === "unread") {
      query = query.is("notification_recipients.read_at", null);
    } else if (options.readState === "read") {
      query = query.not("notification_recipients.read_at", "is", null);
    }
    if (options.search) {
      // Codex security review, INFO-01 carryover: a cheap, deterministic
      // bound, applied BEFORE the search string ever reaches the query
      // builder — mirrors every other Phase 1H-1K search DAL's own
      // identical truncation.
      const bounded = options.search.slice(0, MAX_SEARCH_LENGTH);
      const value = buildImatchSearchValue(bounded);
      query = query.or(`title.imatch.${value},body.imatch.${value}`);
    }

    // SEC-1K-APP-01 remediation: decodeCursor() only confirms
    // `createdAt`/`id` are STRINGS — a forged Base64URL cursor could
    // otherwise carry PostgREST filter grammar (a comma, a closing
    // paren, an operator) straight into the `.or(...)` expression below.
    // Both fields are independently, strictly shape-validated here
    // BEFORE either is ever interpolated; anything that fails either
    // check is treated exactly like decodeCursor's own existing
    // "malformed -> no cursor" convention (never a thrown error, never a
    // distinguishable response — this only ever affects which page of
    // the CALLER's own already-RLS-scoped data they see). The ORIGINAL,
    // validated `createdAt` string is used completely unchanged — never
    // reparsed through a JS Date — so genuine Postgres microsecond
    // precision survives untouched (see isCanonicalTimestamptz's own
    // header comment for why that matters for exact keyset semantics).
    const decoded = decodeCursor(options.cursor);
    const cursor =
      decoded && isCanonicalUuid(decoded.id) && isCanonicalTimestamptz(decoded.createdAt) ? decoded : null;
    if (cursor) {
      query = query.or(
        `created_at.lt.${cursor.createdAt},and(created_at.eq.${cursor.createdAt},id.lt.${cursor.id})`
      );
    }

    const { data, error } = await query;
    if (error) {
      // Never interpolate a raw Supabase/PostgREST/database error message
      // into a user-facing error — see lib/audit/dal.ts's/lib/returns/dal.ts's
      // own identical SEC-02 remediation for the full rationale this mirrors.
      throw new Error("Unable to load notifications.");
    }

    const rows = ((data ?? []) as unknown as RawRow[]).map(toNotificationRow);
    const hasMore = rows.length > DEFAULT_NOTIFICATION_PAGE_SIZE;
    const page = hasMore ? rows.slice(0, DEFAULT_NOTIFICATION_PAGE_SIZE) : rows;

    const last = page[page.length - 1];
    const nextCursor: string | null =
      hasMore && last ? encodeCursor({ createdAt: last.created_at, id: last.id }) : null;

    return { rows: page, nextCursor };
  }
);

// Bell dropdown: a small, FIXED, non-paginated recent slice — never the
// full history, and never all-time unread scan. Deliberately a SEPARATE
// query from listNotificationsForCurrentUser, not that function called
// with a smaller limit, so the bell's own shape (no filters, no cursor)
// stays simple and cannot accidentally grow filter/pagination surface
// over time.
export const getRecentNotificationsForCurrentUser = cache(
  async (businessId: string): Promise<NotificationRow[]> => {
    const user = await requireUser();
    const supabase = await createClient();

    const { data, error } = await supabase
      .from("notifications")
      .select(`${NOTIFICATION_COLUMNS}, notification_recipients!inner(id, read_at, seen_at, user_id)`)
      .eq("business_id", businessId)
      .eq("notification_recipients.user_id", user.id)
      .order("created_at", { ascending: false })
      .order("id", { ascending: false })
      .limit(BELL_RECENT_LIMIT);

    if (error) {
      throw new Error("Unable to load notifications.");
    }

    return ((data ?? []) as unknown as RawRow[]).map(toNotificationRow);
  }
);

// Index-backed (notification_recipients_user_unread_idx) — queries
// notification_recipients directly, never the wider notifications table,
// and never loads a single row of content just to count them. The
// rendered badge caps this at UNREAD_BADGE_CAP+; the underlying count
// itself is never capped.
export const getUnreadNotificationCount = cache(async (businessId: string): Promise<number> => {
  const user = await requireUser();
  const supabase = await createClient();

  const { count, error } = await supabase
    .from("notification_recipients")
    .select("id", { count: "exact", head: true })
    .eq("business_id", businessId)
    .eq("user_id", user.id)
    .is("read_at", null);

  if (error) {
    throw new Error("Unable to load unread notification count.");
  }

  return count ?? 0;
});

export const getNotificationById = cache(
  async (businessId: string, notificationId: string): Promise<NotificationRow | null> => {
    const user = await requireUser();
    const supabase = await createClient();

    const { data, error } = await supabase
      .from("notifications")
      .select(`${NOTIFICATION_COLUMNS}, notification_recipients!inner(id, read_at, seen_at, user_id)`)
      .eq("business_id", businessId)
      .eq("id", notificationId)
      .eq("notification_recipients.user_id", user.id)
      .maybeSingle();

    if (error) {
      throw new Error("Unable to load this notification.");
    }
    if (!data) {
      // Non-disclosing: a notification not addressed to this caller and
      // a genuinely nonexistent one are indistinguishable — RLS already
      // guarantees this (no row is ever returned either way), this is
      // just the DAL's own explicit contract on top of that guarantee.
      return null;
    }

    return toNotificationRow(data as unknown as RawRow);
  }
);

export type NotificationPreferenceRow = {
  notificationType: string;
  inAppEnabled: boolean;
};

// Returns ONLY the rows that actually exist — a MISSING type means
// enabled (the DB column default), which the caller (Server Component)
// applies itself against the fixed, known SUPPORTED set for this round
// (see lib/notifications/constants.ts) — this function never invents a
// row that isn't really there.
export const getNotificationPreferences = cache(
  async (businessId: string): Promise<NotificationPreferenceRow[]> => {
    const user = await requireUser();
    const supabase = await createClient();

    const { data, error } = await supabase
      .from("notification_preferences")
      .select("notification_type, in_app_enabled")
      .eq("business_id", businessId)
      .eq("user_id", user.id);

    if (error) {
      throw new Error("Unable to load notification preferences.");
    }

    return (data ?? []).map((row) => ({
      notificationType: row.notification_type,
      inAppEnabled: row.in_app_enabled,
    }));
  }
);

export type NotificationBranchOption = { id: string; name: string };

// Backs the notification feed's own branch-NAME display. Authorized on
// active business membership ALONE via get_notification_branch_options —
// never branches.view. See that RPC's own header comment
// (20260903090100_notification_read_helpers.sql) for the exact
// permission-contract gap this closes.
export const getNotificationBranchOptions = cache(
  async (businessId: string): Promise<NotificationBranchOption[]> => {
    await requireUser();
    const supabase = await createClient();
    const { data, error } = await supabase.rpc("get_notification_branch_options", {
      p_business_id: businessId,
    });
    if (error) {
      throw new Error("Unable to load notifications.");
    }
    return (data ?? []) as NotificationBranchOption[];
  }
);

export type { Cursor };
