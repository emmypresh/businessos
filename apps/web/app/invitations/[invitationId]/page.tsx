import { redirect } from "next/navigation";
import { notFound } from "next/navigation";
import { getAuthUser } from "@/lib/auth/dal";
import { IdSchema } from "@/lib/validation/staff";
import { AcceptInvitationForm } from "@/components/staff/accept-invitation-form";
import { Card, CardContent } from "@/components/ui/card";

/**
 * Security-critical route — the ONLY thing this page is allowed to do
 * before a real, identity-verified accept_business_invitation call is:
 * confirm the caller is authenticated (redirecting to log in, with a safe
 * continuation, otherwise) and render a wholly GENERIC "you've been
 * invited" card. It deliberately never queries public.business_invitations
 * directly — that table's own SELECT policy requires staff.invite in the
 * TARGET business, which an unrelated invitee obviously does not hold, so
 * an ordinary authenticated read would return nothing useful anyway, and
 * attempting one here would only tempt a future edit into building a
 * second, parallel (and likely inconsistent) privacy check outside the
 * RPC's own carefully-ordered one. accept_business_invitation itself is
 * the SOLE authority on whether this invitation exists, is addressed to
 * this caller, and is still usable — see that RPC's own header comment
 * (business_invitation_rpcs.sql) for the exact non-disclosure contract:
 * a nonexistent invitation id and one addressed to a different email
 * both fail identically (INVITATION_NOT_FOUND), and only after identity
 * is confirmed does a lifecycle-specific reason (already
 * accepted/revoked/expired) ever surface. lib/errors.ts's mapping for
 * every one of those codes is equally generic — this page adds no detail
 * beyond what that mapping already safely allows.
 */
export default async function AcceptInvitationPage({ params }: PageProps<"/invitations/[invitationId]">) {
  const { invitationId } = await params;

  if (!IdSchema.safeParse(invitationId).success) {
    notFound();
  }

  const user = await getAuthUser();
  if (!user) {
    redirect(`/login?next=${encodeURIComponent(`/invitations/${invitationId}`)}`);
  }

  return (
    <div className="mx-auto flex min-h-[60vh] max-w-md flex-col justify-center gap-6 px-4">
      <Card>
        <CardContent className="flex flex-col gap-4">
          <div className="flex flex-col gap-1">
            <h1 className="text-xl font-semibold tracking-tight">Business invitation</h1>
            <p className="text-sm text-muted-foreground">
              You&rsquo;ve been invited to join a business on BusinessOS. If this invitation was sent
              to <span className="font-medium text-foreground">{user.email}</span>, accepting will add
              you as a staff member.
            </p>
          </div>
          <AcceptInvitationForm invitationId={invitationId} />
        </CardContent>
      </Card>
    </div>
  );
}
