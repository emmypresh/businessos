import { requirePermissionOrNotFound, hasPermission } from "@/lib/business/dal";
import { PERMISSION } from "@/lib/business/constants";
import { getBusinessSubscription, getBusinessEntitlement, listPublicPlans, listActivePricesForPlan } from "@/lib/billing/dal";
import { PLAN_LABEL, SUBSCRIPTION_STATUS_LABEL, BILLING_INTERVAL_LABEL, type PlanCode } from "@/lib/billing/constants";
import { formatMoney } from "@/lib/currency";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { CheckoutForm } from "@/components/billing/checkout-form";
import { CancelSubscriptionDialog } from "@/components/billing/cancel-subscription-dialog";

// billing.view (OWNER/ADMIN/ACCOUNTANT, per the frozen matrix) is the
// route's own read gate — mirrors every other Server Component page's
// requirePermissionOrNotFound convention exactly. Management controls
// (checkout, cancel) are rendered ONLY for a caller who ALSO holds
// billing.manage (OWNER-only) — an ADMIN/ACCOUNTANT sees the page but
// never the buttons, and even if they somehow reached the underlying
// Server Action directly, it independently re-checks billing.manage
// itself (lib/billing/actions.ts) — this page's own conditional
// rendering is a courtesy, never the security boundary.
//
// NEVER RENDERED HERE: provider_customer_code, provider_subscription_code,
// provider event keys, or any raw database/provider error detail — see
// lib/billing/dal.ts's own SUBSCRIPTION_COLUMNS comment for why the DAL
// itself never even selects the first two.
export default async function BillingPage({ params }: PageProps<"/[businessId]/settings/billing">) {
  const { businessId } = await params;
  await requirePermissionOrNotFound(businessId, PERMISSION.BILLING_VIEW);
  const canManage = await hasPermission(businessId, PERMISSION.BILLING_MANAGE);

  const [subscription, entitlement] = await Promise.all([
    getBusinessSubscription(businessId),
    getBusinessEntitlement(businessId),
  ]);

  const plans = canManage ? await listPublicPlans() : [];
  const currentPlan = subscription
    ? plans.find((p) => p.id === subscription.planId) ?? null
    : null;
  const prices = canManage && currentPlan ? await listActivePricesForPlan(currentPlan.id) : [];

  const statusLabel = subscription ? SUBSCRIPTION_STATUS_LABEL[subscription.status as keyof typeof SUBSCRIPTION_STATUS_LABEL] ?? subscription.status : "—";
  const planLabel = subscription ? PLAN_LABEL[(currentPlan?.code ?? entitlement?.planCode) as PlanCode] ?? entitlement?.planCode ?? "—" : "—";

  return (
    <div className="flex flex-col gap-6">
      <div>
        <h1 className="text-2xl font-semibold tracking-tight">Billing</h1>
        <p className="text-sm text-muted-foreground">Manage your BusinessOS subscription.</p>
      </div>

      {!entitlement?.isEntitled && subscription ? (
        <Alert variant="destructive">
          <AlertTitle>
            {subscription.status === "PAST_DUE" ? "Payment required" : "Subscription not active"}
          </AlertTitle>
          <AlertDescription>
            {subscription.status === "PAST_DUE"
              ? "Your last payment failed. Update billing to restore access."
              : "Your business data is safe and unaffected — resubscribe below to regain access to paid features."}
          </AlertDescription>
        </Alert>
      ) : null}

      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            {planLabel} plan
            <Badge variant={entitlement?.isEntitled ? "default" : "destructive"}>{statusLabel}</Badge>
          </CardTitle>
          <CardDescription>Current subscription details for this business.</CardDescription>
        </CardHeader>
        <CardContent className="flex flex-col gap-3 text-sm">
          {subscription?.status === "TRIALING" && subscription.trialEndsAt ? (
            <p>
              Trial ends <strong>{new Date(subscription.trialEndsAt).toLocaleDateString()}</strong>
            </p>
          ) : null}
          {subscription?.status === "ACTIVE" && subscription.currentPeriodEndsAt ? (
            <p>
              Paid through <strong>{new Date(subscription.currentPeriodEndsAt).toLocaleDateString()}</strong>
            </p>
          ) : null}
          {subscription?.cancelAtPeriodEnd ? (
            <p className="text-muted-foreground">
              Cancellation scheduled — access continues until the date above.
            </p>
          ) : null}
          {subscription?.billingInterval ? (
            <p className="text-muted-foreground">
              Billing interval: {BILLING_INTERVAL_LABEL[subscription.billingInterval as keyof typeof BILLING_INTERVAL_LABEL] ?? subscription.billingInterval}
            </p>
          ) : null}
          {subscription?.amountMinor && subscription.currency ? (
            <p className="text-muted-foreground">
              Current amount: {formatMoney(Number(subscription.amountMinor) / 100, subscription.currency)}
            </p>
          ) : null}

          {canManage && subscription && !subscription.cancelAtPeriodEnd &&
          ["TRIALING", "ACTIVE", "PAST_DUE"].includes(subscription.status) ? (
            subscription.provider !== "PAYSTACK" || subscription.hasProviderSubscriptionIdentity ? (
              // MANUAL (a trial, or a negotiated/enterprise subscription)
              // has no real Paystack recurrence to disable — the simple
              // local-only cancellation is fully correct for it. A
              // PAYSTACK subscription only reaches this branch once a
              // verified subscription.create event has already bound its
              // own provider identity (APP-1L-03) — CancelSubscriptionDialog's
              // own Server Action performs the real provider-disable
              // flow first in that case.
              <div className="pt-2">
                <CancelSubscriptionDialog businessId={businessId} />
              </div>
            ) : (
              // PAYSTACK subscription with no bound provider identity yet
              // (checkout not yet completed, or a reconciliation gap) —
              // never a false "cancel" affordance; never a silent
              // local-only flag instead.
              <p className="pt-2 text-sm text-muted-foreground">
                Cancellation isn&apos;t available yet for this subscription. Please try again shortly, or contact
                support.
              </p>
            )
          ) : null}
        </CardContent>
      </Card>

      {canManage ? (
        <Card>
          <CardHeader>
            <CardTitle>Available plans</CardTitle>
            <CardDescription>
              {prices.length > 0
                ? "Choose a plan to start or change checkout."
                : "Checkout isn't configured for this plan yet — check back soon."}
            </CardDescription>
          </CardHeader>
          <CardContent className="flex flex-col gap-4">
            {prices.length === 0 ? (
              <Alert>
                <AlertTitle>Checkout unavailable</AlertTitle>
                <AlertDescription>
                  No active price is configured for provider checkout yet in this environment.
                </AlertDescription>
              </Alert>
            ) : (
              prices.map((price) => (
                <CheckoutForm
                  key={price.id}
                  businessId={businessId}
                  priceId={price.id}
                  label={`${BILLING_INTERVAL_LABEL[price.billingInterval as keyof typeof BILLING_INTERVAL_LABEL] ?? price.billingInterval} — ${formatMoney(Number(price.amountMinor) / 100, price.currency)}`}
                />
              ))
            )}
          </CardContent>
        </Card>
      ) : null}
    </div>
  );
}
