import { CircleAlert } from "lucide-react";
import { EmptyState } from "@/components/dashboard/empty-state";

/**
 * Phase 1Q-0C follow-up — the fail-closed counterpart to the removed
 * `business?.currency_code ?? "NGN"` fallbacks on operational money-entry
 * pages (new expense, new product). If the authoritative business record
 * cannot be loaded, the correct behavior is to refuse to render a monetary
 * form under an assumed currency, never to silently substitute NGN for a
 * business that may use a different one. Mirrors NoActiveBranchState's
 * "blocked, not broken" EmptyState pattern.
 */
export function CurrencyUnavailableState({ action }: { action?: string }) {
  return (
    <EmptyState
      icon={CircleAlert}
      title="Business currency unavailable"
      description={`We couldn't load this business's currency${
        action ? ` to ${action}` : ""
      }, so the form can't be shown safely. Try again, or contact an administrator if this continues.`}
    />
  );
}
