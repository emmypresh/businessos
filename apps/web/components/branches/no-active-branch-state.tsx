import { MapPinOff } from "lucide-react";
import { EmptyState } from "@/components/dashboard/empty-state";

/**
 * Phase 1G — the one shared "blocked, not broken" state for every
 * operational create/mutate workflow (sales, opening stock, inventory
 * adjustment) when the caller holds the relevant permission but has no
 * active branch assignment to operate through. Reusing EmptyState (the
 * established Phase 1F "nothing here yet" surface) keeps this visually
 * consistent with every other empty/blocked state in the app, rather than
 * inventing a second pattern. Never shows a broken, empty dropdown, and
 * never leaks the internal NO_PRIMARY_BRANCH_ASSIGNED code — this copy is
 * the safe, actionable equivalent, matching the exact wording
 * lib/errors.ts maps that code to.
 *
 * Phase 1G remediation round 2: previously accepted a `hasUnresolvedAssignments`
 * prop to distinguish "genuinely unassigned" from "assigned, but the name
 * couldn't be resolved because branches.view was missing" — a real gap in
 * getOperationalBranchOptions' old embedded-join implementation (Codex
 * adversarial review, application-layer round 2, Blocker 1). That gap is
 * now closed at the database layer by public.get_business_branch_options
 * (supabase/migrations/20260830080000_branch_option_rpc.sql), which
 * authorizes the operations scope on the caller's own operational
 * permission directly and always resolves real branch names for a real
 * assignment. There is no longer a distinct "unresolved" state to
 * represent, so that prop is removed rather than kept as a dead,
 * permanently-false fallback for an already-fixed contract.
 */
export function NoActiveBranchState({ action }: { action?: string }) {
  return (
    <EmptyState
      icon={MapPinOff}
      title="No active branch assigned"
      description={`You don't currently have an active branch assigned${
        action ? ` for ${action}` : ""
      }. Contact an administrator.`}
    />
  );
}
