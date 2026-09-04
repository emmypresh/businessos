"use server";

import { revalidatePath } from "next/cache";
import { createClient } from "@/lib/supabase/server";
import { requireUser } from "@/lib/auth/dal";
import { IdSchema, UpdatePreferenceSchema } from "@/lib/validation/notifications";
import { getRecentNotificationsForCurrentUser, type NotificationRow } from "@/lib/notifications/dal";
import type { ActionState } from "@/lib/auth/actions";

const MALFORMED_REQUEST: ActionState = {
  error: "Something went wrong. Please try again.",
};

const GENERIC_FAILURE: ActionState = {
  error: "Something went wrong. Please try again.",
};

function getValidId(formData: FormData, field: string): string | null {
  const value = formData.get(field);
  if (typeof value !== "string") return null;
  return IdSchema.safeParse(value).success ? value : null;
}

// SECURITY MODEL FOR EVERY ACTION BELOW: none of these ever accepts or
// forwards a user_id, and none targets a row by notification_recipients.id
// alone — every UPDATE is scoped by business_id (validated shape) AND,
// beneath that, RLS's own `user_id = auth.uid()` USING/WITH CHECK clause
// (notification_recipients_update — see the Phase 1K DB foundation).
// A caller can only ever affect ROWS THAT WERE ALREADY THEIRS; a
// business/notification id belonging to someone else's recipient row (or
// a caller who is no longer an active member) matches ZERO rows — never
// an error, never a cross-user/cross-tenant disclosure, mirroring every
// other RLS-scoped mutation in this codebase's own established
// non-disclosing-failure convention.
//
// `(prevState, formData)` signature — this codebase's own established
// convention for every form/useActionState-invoked mutation (see
// lib/staff/actions.ts's suspendMember/reactivateMember) — used here for
// every mutation with natural form semantics.

export async function markNotificationReadAction(
  _prevState: ActionState,
  formData: FormData
): Promise<ActionState> {
  await requireUser();
  const businessId = getValidId(formData, "businessId");
  const notificationId = getValidId(formData, "notificationId");
  if (!businessId || !notificationId) {
    return MALFORMED_REQUEST;
  }

  const supabase = await createClient();
  const { error } = await supabase
    .from("notification_recipients")
    .update({ read_at: new Date().toISOString() })
    .eq("business_id", businessId)
    .eq("notification_id", notificationId);

  if (error) {
    return GENERIC_FAILURE;
  }

  revalidatePath(`/${businessId}/notifications`);
  return { success: true };
}

export async function markNotificationUnreadAction(
  _prevState: ActionState,
  formData: FormData
): Promise<ActionState> {
  await requireUser();
  const businessId = getValidId(formData, "businessId");
  const notificationId = getValidId(formData, "notificationId");
  if (!businessId || !notificationId) {
    return MALFORMED_REQUEST;
  }

  const supabase = await createClient();
  const { error } = await supabase
    .from("notification_recipients")
    .update({ read_at: null })
    .eq("business_id", businessId)
    .eq("notification_id", notificationId);

  if (error) {
    return GENERIC_FAILURE;
  }

  revalidatePath(`/${businessId}/notifications`);
  return { success: true };
}

// "Mark all read" — RLS's own `user_id = auth.uid()` clause is what
// actually bounds this to the caller's own rows; the `.eq("business_id",
// ...)` here additionally bounds it to ONE business, so this can never
// spill into another business the same user also belongs to.
export async function markAllNotificationsReadAction(
  _prevState: ActionState,
  formData: FormData
): Promise<ActionState> {
  await requireUser();
  const businessId = getValidId(formData, "businessId");
  if (!businessId) {
    return MALFORMED_REQUEST;
  }

  const supabase = await createClient();
  const { error } = await supabase
    .from("notification_recipients")
    .update({ read_at: new Date().toISOString() })
    .eq("business_id", businessId)
    .is("read_at", null);

  if (error) {
    return GENERIC_FAILURE;
  }

  revalidatePath(`/${businessId}/notifications`);
  return { success: true };
}

// Marks a BOUNDED, caller-supplied set of notification ids as seen —
// used by the bell dropdown when it opens, for exactly the recent slice
// it just rendered (see components/notifications/notification-bell.tsx)
// — never "every notification this user has ever received." Deliberately
// a PLAIN async function, not a (prevState, formData) action: this is a
// fire-and-forget background call with no form/confirmation semantics of
// its own. Each id is shape-validated; a malformed one anywhere in the
// array fails the whole call closed rather than silently skipping it.
export async function markNotificationsSeenAction(
  businessId: string,
  notificationIds: string[]
): Promise<ActionState> {
  await requireUser();
  if (!IdSchema.safeParse(businessId).success) {
    return MALFORMED_REQUEST;
  }
  if (notificationIds.length === 0) {
    return { success: true };
  }
  if (notificationIds.length > 50 || !notificationIds.every((id) => IdSchema.safeParse(id).success)) {
    return MALFORMED_REQUEST;
  }

  const supabase = await createClient();
  const { error } = await supabase
    .from("notification_recipients")
    .update({ seen_at: new Date().toISOString() })
    .eq("business_id", businessId)
    .in("notification_id", notificationIds)
    .is("seen_at", null);

  if (error) {
    return GENERIC_FAILURE;
  }

  return { success: true };
}

// Fetches the bell dropdown's own small recent slice on demand — called
// only when the dropdown actually opens (never prefetched on every page
// load), matching this phase's own "the count/feed may refresh on
// navigation/request... never fake live updates" instruction. Returns
// the SAME shape the feed page itself uses, so the bell can reuse
// NotificationFeed's own row rendering rather than a second, divergent
// presentation.
export async function getRecentNotificationsAction(businessId: string): Promise<NotificationRow[]> {
  if (!IdSchema.safeParse(businessId).success) {
    return [];
  }
  try {
    return await getRecentNotificationsForCurrentUser(businessId);
  } catch {
    return [];
  }
}

// Self-service upsert — mirrors the DB foundation's own established
// contract exactly (see 20260903080200_create_notification_preferences.sql's
// own UPDATE-policy comment for why business_id/user_id/notification_type
// are safely re-sendable in an upsert payload: WITH CHECK, not the
// client's own honesty, is what actually prevents cross-user/cross-tenant
// abuse). user_id is NEVER accepted as a parameter here — it is never
// read from anything but the server's own authenticated session. A plain
// async function (not a form action) — the preferences UI toggles many
// independent switches on one page, each firing its own imperative call,
// rather than one big form submission.
export async function updateNotificationPreferenceAction(
  businessId: string,
  input: { notificationType: string; inAppEnabled: boolean }
): Promise<ActionState> {
  const user = await requireUser();
  if (!IdSchema.safeParse(businessId).success) {
    return MALFORMED_REQUEST;
  }
  const parsed = UpdatePreferenceSchema.safeParse(input);
  if (!parsed.success) {
    return MALFORMED_REQUEST;
  }

  const supabase = await createClient();
  const { error } = await supabase.from("notification_preferences").upsert(
    {
      business_id: businessId,
      user_id: user.id,
      notification_type: parsed.data.notificationType,
      in_app_enabled: parsed.data.inAppEnabled,
    },
    { onConflict: "business_id,user_id,notification_type" }
  );

  if (error) {
    return GENERIC_FAILURE;
  }

  revalidatePath(`/${businessId}/notifications/preferences`);
  return { success: true };
}
