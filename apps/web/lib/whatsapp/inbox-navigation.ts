import type { WhatsappInboxConversationRow } from "./dal";

/**
 * WAI-005: the mobile base route (no ?conversation= query) must show the
 * conversation list, never auto-select the first conversation. Falling
 * back to conversations[0] made the mobile "Back" flow (which navigates
 * to this same base route) immediately re-select the first conversation
 * instead of returning to the list.
 *
 * Also the sole authority for turning a `?conversation=` query value into
 * a selection: only a row already present in this business's own
 * tenant-scoped `conversations` array can ever be selected. An arbitrary,
 * stale, or cross-business id never falls through to any other row — it
 * simply selects nothing.
 */
export function selectActiveWhatsappConversation(
  conversations: WhatsappInboxConversationRow[],
  requestedConversationId: string | undefined
): WhatsappInboxConversationRow | null {
  if (!requestedConversationId) return null;
  return conversations.find((row) => row.id === requestedConversationId) ?? null;
}
