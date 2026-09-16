import Link from "next/link";
import { ArrowUpRight, MessageCircle } from "lucide-react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";

type Props = {
  businessId: string;
  /**
   * Mirrors get_management_reporting_aggregate's whatsapp_follow_up_count
   * exactly (20260916090000_management_reporting_aggregates.sql): null
   * means the caller lacks whatsapp.view and the field was withheld, not
   * that the count is zero. The two must never be conflated — a null
   * count renders nothing at all, never a fabricated zero.
   */
  followUpCount: number | null;
};

/**
 * Count-only indicator for the frozen "needs follow-up" queue definition:
 * an OPEN WhatsApp conversation whose last recorded inbound message is
 * newer than its last recorded outbound message, or which has no recorded
 * outbound message at all. No priority, SLA, or response-time metric
 * exists in the source aggregate, so none is rendered here.
 */
export function WhatsAppFollowUp({ businessId, followUpCount }: Props) {
  if (followUpCount === null) return null;

  return (
    <Card role="region" aria-labelledby="whatsapp-follow-up-heading">
      <CardHeader>
        <CardTitle id="whatsapp-follow-up-heading" className="flex items-center gap-2">
          <MessageCircle className="size-4 text-muted-foreground" aria-hidden="true" />
          WhatsApp follow-up
        </CardTitle>
      </CardHeader>
      <CardContent>
        {followUpCount === 0 ? (
          <p className="text-sm">No WhatsApp conversations currently need a follow-up.</p>
        ) : (
          <p className="text-sm">
            <span className="font-semibold tabular-nums">{followUpCount}</span>{" "}
            {followUpCount === 1 ? "conversation may" : "conversations may"} need a follow-up.
          </p>
        )}
        <p className="mt-1 text-xs text-muted-foreground">
          Open conversations where newer inbound activity has not yet been followed by outbound activity.
        </p>
        <Link
          href={`/${businessId}/whatsapp`}
          className="mt-3 inline-flex min-h-11 items-center gap-1 text-sm font-medium text-primary hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2"
        >
          View WhatsApp conversations <ArrowUpRight className="size-3.5" aria-hidden="true" />
        </Link>
      </CardContent>
    </Card>
  );
}
