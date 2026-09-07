import "server-only";
import type { SupabaseClient } from "@supabase/supabase-js";
import type { Database } from "@/lib/supabase/database.types";
import { PAYSTACK_EVENT } from "@/lib/billing/constants";
import { getPaystackEnvironment } from "@/lib/billing/paystack-environment";
import { addUtcMonths } from "@/lib/date-utc";

type AdminClient = SupabaseClient<Database>;

/**
 * All DB reads here go through the SAME service_role admin client the
 * route handler already authenticated as (lib/billing/admin-client.ts) —
 * business_subscriptions/subscription_plan_prices already grant SELECT
 * to `service_role` in the frozen DB foundation, and service_role holds
 * BYPASSRLS, so these reads need no new grant. Every MUTATION instead
 * goes exclusively through the narrow public.*_paystack_* RPC wrappers
 * (20260905080200_billing_provider_writer.sql,
 * 20260906080000_provider_subscription_identity_and_environment.sql) —
 * this module never issues a raw UPDATE/INSERT against
 * business_subscriptions/billing_transactions itself.
 *
 * PROVIDER-EVENT-ORDERING SAFETY: every mutation path below relies on
 * the FROZEN DB layer's own guarantees (row locking, SEC-1L-01's expiry
 * boundary, SEC-1L-02's renewal monotonicity) plus TWO application-level
 * guards those frozen functions cannot themselves express:
 *  1. a STALE invoice.payment_failed (one whose own invoice was created
 *     before the business's CURRENT period even started) is detected
 *     and skipped (handleInvoicePaymentFailed);
 *  2. every RECURRING event (invoice.payment_failed, subscription.disable)
 *     is attributed by provider + environment + customer code + SUBSCRIPTION
 *     CODE, never customer code alone — APP-1L-02's own "a provider
 *     customer may have more than one historical or concurrent
 *     subscription" finding. An event for a subscription code that does
 *     not match this business's CURRENTLY BOUND provider_subscription_code
 *     is ingested as evidence but never mutates authoritative state.
 *
 * ENVIRONMENT: every provider lookup below passes THIS APPLICATION's own
 * configured PAYSTACK_ENVIRONMENT explicitly — never inferred from
 * payload content (Paystack's payload shape does not distinguish
 * TEST/LIVE) — so a lookup can only ever resolve a business whose own
 * provider_customer_code was recorded under this exact same configured
 * environment. app/api/webhooks/paystack/route.ts itself refuses to
 * dispatch any event at all when PAYSTACK_ENVIRONMENT is unset/invalid
 * (fail closed) — the null-checks below are defense in depth, not the
 * only guard.
 */

function isUuid(value: unknown): value is string {
  return (
    typeof value === "string" &&
    /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value)
  );
}

async function resolveBusinessIdByCustomerCode(
  admin: AdminClient,
  customerCode: string | undefined,
  environment: string
): Promise<string | null> {
  if (!customerCode) return null;
  const { data, error } = await admin.rpc("find_paystack_business_by_customer_code", {
    p_provider_customer_code: customerCode,
    p_provider_environment: environment,
  });
  if (error) {
    console.error("[paystack] customer-code lookup failed", { message: error.message });
    return null;
  }
  return data ?? null;
}

type SubscriptionSnapshot = {
  id: string;
  planId: string;
  priceId: string | null;
  status: string;
  currency: string;
  amountMinor: number | null;
  billingInterval: string | null;
  provider: string;
  providerEnvironment: string | null;
  providerCustomerCode: string | null;
  providerSubscriptionCode: string | null;
  currentPeriodStartedAt: string | null;
};

async function loadSubscription(admin: AdminClient, businessId: string): Promise<SubscriptionSnapshot | null> {
  const { data: rawData, error } = await admin
    .from("business_subscriptions")
    .select(
      "id, plan_id, price_id, status, currency, amount_minor, billing_interval, provider, provider_environment, " +
        "provider_customer_code, provider_subscription_code, current_period_started_at"
    )
    .eq("business_id", businessId)
    .maybeSingle();
  if (error || !rawData) return null;
  // A dynamic (non-literal, concatenated) column-list string defeats
  // Supabase's own select-string type inference — mirrors
  // lib/billing/dal.ts's own identical, already-documented pattern.
  const data = rawData as unknown as Record<string, unknown>;
  return {
    id: data.id as string,
    planId: data.plan_id as string,
    priceId: (data.price_id as string | null) ?? null,
    status: data.status as string,
    currency: data.currency as string,
    amountMinor: data.amount_minor == null ? null : Number(data.amount_minor as number | string),
    billingInterval: (data.billing_interval as string | null) ?? null,
    provider: data.provider as string,
    providerEnvironment: (data.provider_environment as string | null) ?? null,
    providerCustomerCode: (data.provider_customer_code as string | null) ?? null,
    providerSubscriptionCode: (data.provider_subscription_code as string | null) ?? null,
    currentPeriodStartedAt: (data.current_period_started_at as string | null) ?? null,
  };
}

/**
 * APP-1L-02-R1 — the ONE place every RECURRING provider lifecycle event
 * (invoice.payment_failed, subscription.disable, and any future one)
 * proves it is safe to mutate authoritative state. Never exported from
 * this module (see this function's own "do not expose to client code"
 * requirement — it is server-only application logic with no meaning
 * outside webhook processing, and nothing outside this file ever needs
 * it).
 *
 * ALL of the following must hold, or this returns a reconciliation
 * reason and NO caller may mutate anything:
 *  - the local subscription exists at all;
 *  - local provider = PAYSTACK (a MANUAL/enterprise subscription has no
 *    provider lifecycle events to receive in the first place);
 *  - local provider_environment matches the caller's OWN already-
 *    validated configured environment (never inferred from the event);
 *  - local provider_customer_code IS NOT NULL;
 *  - local provider_subscription_code IS NOT NULL — an UNBOUND identity
 *    is never "close enough": a recurring event for a business whose
 *    subscription identity was never confirmed by a verified
 *    subscription.create is not authoritative enough to mutate ANY
 *    state (this is the exact gap APP-1L-02-R1 closes: the previous
 *    per-handler checks only compared codes when the LOCAL code was
 *    already non-null, silently skipping the comparison — and therefore
 *    the whole guard — when it was NULL);
 *  - the event's OWN incoming customer code equals the local one;
 *  - the event's OWN incoming subscription code equals the local one.
 *
 * This same guard applies identically regardless of HOW the caller
 * resolved `businessId` — including via this application's own checkout
 * metadata (charge.success's own p_metadata.business_id) — metadata may
 * help LOCATE a candidate business, but it is never treated as
 * sufficient authority on its own: every field above is independently
 * re-read from the CURRENT authoritative row and re-compared against the
 * event's own verified payload before any mutation RPC is ever called.
 */
type RecurringIdentityMatch =
  | { ok: true; subscription: SubscriptionSnapshot }
  | { ok: false; reason: string };

async function resolveVerifiedRecurringSubscription(
  admin: AdminClient,
  businessId: string,
  configuredEnvironment: string,
  incomingCustomerCode: string | undefined,
  incomingSubscriptionCode: string | undefined
): Promise<RecurringIdentityMatch> {
  const sub = await loadSubscription(admin, businessId);
  if (!sub) {
    return { ok: false, reason: "SUBSCRIPTION_NOT_FOUND" };
  }
  if (sub.provider !== "PAYSTACK") {
    return { ok: false, reason: "PROVIDER_MISMATCH" };
  }
  if (sub.providerEnvironment !== configuredEnvironment) {
    return { ok: false, reason: "ENVIRONMENT_MISMATCH" };
  }
  if (!sub.providerCustomerCode) {
    return { ok: false, reason: "CUSTOMER_IDENTITY_NOT_BOUND" };
  }
  if (!sub.providerSubscriptionCode) {
    return { ok: false, reason: "SUBSCRIPTION_IDENTITY_NOT_BOUND" };
  }
  if (!incomingCustomerCode || incomingCustomerCode !== sub.providerCustomerCode) {
    return { ok: false, reason: "CUSTOMER_MISMATCH" };
  }
  if (!incomingSubscriptionCode || incomingSubscriptionCode !== sub.providerSubscriptionCode) {
    return { ok: false, reason: "SUBSCRIPTION_MISMATCH" };
  }
  return { ok: true, subscription: sub };
}

async function handleChargeSuccess(
  admin: AdminClient,
  businessId: string | null,
  data: {
    id: number | string;
    reference: string;
    amount: number;
    currency: string;
    paid_at?: string;
    channel?: string;
    customer: { customer_code?: string; email?: string };
    metadata?: Record<string, unknown>;
  }
): Promise<void> {
  const paystackEnvironment = getPaystackEnvironment();
  if (!paystackEnvironment) {
    console.error("[paystack][config] PAYSTACK_ENVIRONMENT is not validly configured — charge.success ignored");
    return;
  }

  const metaBusinessId = isUuid(data.metadata?.business_id) ? (data.metadata!.business_id as string) : null;
  const resolvedBusinessId =
    businessId ??
    metaBusinessId ??
    (await resolveBusinessIdByCustomerCode(admin, data.customer.customer_code, paystackEnvironment));

  if (!resolvedBusinessId) {
    console.error("[paystack][reconciliation] charge.success could not be mapped to any business", {
      reference: data.reference,
    });
    return;
  }

  const sub = await loadSubscription(admin, resolvedBusinessId);
  if (!sub) {
    console.error("[paystack][reconciliation] charge.success mapped to a business with no subscription row", {
      businessId: resolvedBusinessId,
    });
    return;
  }

  const metaPriceId = isUuid(data.metadata?.price_id) ? (data.metadata!.price_id as string) : null;
  const priceId = metaPriceId ?? sub.priceId;

  let planId = sub.planId;
  let billingInterval = sub.billingInterval ?? "MONTHLY";
  let expectedCurrency = sub.currency;
  let expectedAmountMinor = sub.amountMinor;
  let providerEnvironment: string = paystackEnvironment;

  if (priceId) {
    const { data: price } = await admin
      .from("subscription_plan_prices")
      .select("id, plan_id, currency, amount_minor, billing_interval, provider_environment, is_active")
      .eq("id", priceId)
      .maybeSingle();
    if (price && price.is_active) {
      planId = price.plan_id;
      billingInterval = price.billing_interval;
      expectedCurrency = price.currency;
      expectedAmountMinor = Number(price.amount_minor);
      providerEnvironment = price.provider_environment;
    }
  }

  // Reconciliation: never trust the provider's own reported amount/
  // currency blindly — cross-check against the authoritative,
  // server-configured price/subscription expectation. A mismatch means
  // this charge does NOT correspond to what BusinessOS thinks it sold;
  // the charge is still recorded (real money moved — that is durable
  // evidence this application must never silently drop), but NO
  // entitlement is granted for it. This transaction row is EVIDENCE
  // only — see this module's own header comment and lib/billing/dal.ts:
  // subscription state (business_subscriptions.status), never a
  // billing_transactions row, is the sole entitlement authority anywhere
  // in this application.
  const currencyMatches = data.currency.toUpperCase() === expectedCurrency.toUpperCase();
  const amountMatches = expectedAmountMinor != null && expectedAmountMinor === data.amount;

  if (!currencyMatches || !amountMatches) {
    console.error("[paystack][reconciliation] charge.success amount/currency mismatch — entitlement NOT granted", {
      businessId: resolvedBusinessId,
      reference: data.reference,
      expectedCurrency,
      expectedAmountMinor,
      providerCurrency: data.currency,
      providerAmount: data.amount,
    });
    await recordTransaction(admin, resolvedBusinessId, sub.id, data, "SUCCESS");
    return;
  }

  const periodStart = data.paid_at ? new Date(data.paid_at) : new Date();
  const periodEnd = billingInterval === "ANNUAL" ? addUtcMonths(periodStart, 12) : addUtcMonths(periodStart, 1);

  try {
    if (sub.status === "ACTIVE") {
      // A renewal charge for an already-active subscription — the
      // monotonic-safe path (SEC-1L-02(A)). A duplicate/replayed
      // charge.success for the SAME period is safe here even without
      // the provider-event idempotency layer above, because equality is
      // itself defined as an idempotent no-op by the frozen function.
      await admin.rpc("renew_paystack_subscription", {
        p_business_id: resolvedBusinessId,
        p_period_start: periodStart.toISOString(),
        p_period_end: periodEnd.toISOString(),
      });
    } else {
      // TRIALING/PAST_DUE/INCOMPLETE -> ACTIVE. The frozen function
      // itself re-validates price/plan/provider/environment consistency
      // (SEC-1L-03) — this application never assumes its own read above
      // is still correct by the time this call actually executes.
      await admin.rpc("activate_paystack_subscription", {
        p_business_id: resolvedBusinessId,
        p_plan_id: planId,
        p_period_start: periodStart.toISOString(),
        p_period_end: periodEnd.toISOString(),
        p_price_id: priceId ?? undefined,
        p_provider_environment: providerEnvironment,
        p_provider_customer_code: data.customer.customer_code ?? undefined,
      });
    }
  } catch (cause) {
    // Activation/renewal legitimately refused (e.g. a stale/insufficient
    // period, a mismatch the frozen layer itself caught) — never crash
    // the webhook route for this; log and still record the transaction
    // below as evidence.
    console.error("[paystack][reconciliation] activation/renewal rejected", {
      businessId: resolvedBusinessId,
      message: cause instanceof Error ? cause.message : String(cause),
    });
  }

  await recordTransaction(admin, resolvedBusinessId, sub.id, data, "SUCCESS");
}

async function recordTransaction(
  admin: AdminClient,
  businessId: string,
  subscriptionId: string,
  data: {
    id: number | string;
    reference: string;
    amount: number;
    currency: string;
    paid_at?: string;
    channel?: string;
  },
  status: "SUCCESS"
): Promise<void> {
  const { error } = await admin.rpc("record_paystack_billing_transaction", {
    p_business_id: businessId,
    p_subscription_id: subscriptionId,
    p_provider_reference: data.reference,
    p_amount_minor: data.amount,
    p_currency: data.currency.toUpperCase(),
    p_status: status,
    p_provider_transaction_code: String(data.id),
    p_paid_at: data.paid_at ?? new Date().toISOString(),
    p_provider_channel: data.channel ?? undefined,
  });
  // provider_reference is unique per (provider, reference) — an exact
  // replay of the SAME charge is a safe, idempotent no-op at the DB
  // layer regardless (private.record_billing_transaction's own ON
  // CONFLICT DO NOTHING); a genuine failure here is logged, never
  // thrown, so it can never take down webhook processing that has
  // already correctly granted entitlement above.
  if (error) {
    console.error("[paystack] record_paystack_billing_transaction failed", { message: error.message });
  }
}

/**
 * subscription.create: persists VERIFIED provider subscription identity
 * (APP-1L-02). Never mutates entitlement state itself — activation is
 * driven exclusively by charge.success (see handleChargeSuccess).
 */
async function handleSubscriptionCreate(
  admin: AdminClient,
  businessId: string | null,
  data: {
    subscription_code: string;
    email_token?: string;
    customer?: { customer_code?: string };
  }
): Promise<void> {
  const paystackEnvironment = getPaystackEnvironment();
  if (!paystackEnvironment) {
    console.error("[paystack][config] PAYSTACK_ENVIRONMENT is not validly configured — subscription.create ignored");
    return;
  }

  const resolvedBusinessId =
    businessId ??
    (await resolveBusinessIdByCustomerCode(admin, data.customer?.customer_code, paystackEnvironment));

  if (!resolvedBusinessId) {
    console.error("[paystack][reconciliation] subscription.create could not be mapped to any business", {
      subscriptionCode: data.subscription_code,
    });
    return;
  }
  if (!data.customer?.customer_code) {
    console.error("[paystack][reconciliation] subscription.create missing customer_code — identity not bound", {
      businessId: resolvedBusinessId,
    });
    return;
  }

  try {
    await admin.rpc("bind_paystack_subscription_identity", {
      p_business_id: resolvedBusinessId,
      p_provider_customer_code: data.customer.customer_code,
      p_provider_subscription_code: data.subscription_code,
      p_provider_email_token: data.email_token ?? undefined,
    });
  } catch (cause) {
    const message = cause instanceof Error ? cause.message : String(cause);
    // PROVIDER_SUBSCRIPTION_CONFLICT: this business is already bound to a
    // DIFFERENT provider_subscription_code — a genuine identity conflict
    // (the same customer has more than one historical/concurrent
    // subscription). Logged as a controlled reconciliation issue, never
    // silently overwritten, never crashes the webhook route.
    // PROVIDER_CUSTOMER_MISMATCH: the event's own customer code disagrees
    // with what this business is already bound to — same treatment.
    console.error("[paystack][reconciliation] subscription.create identity conflict — not bound", {
      businessId: resolvedBusinessId,
      subscriptionCode: data.subscription_code,
      message,
    });
  }
}

async function handleInvoicePaymentFailed(
  admin: AdminClient,
  businessId: string | null,
  data: {
    created_at?: string;
    customer?: { customer_code?: string };
    subscription?: { subscription_code?: string };
  }
): Promise<void> {
  const paystackEnvironment = getPaystackEnvironment();
  if (!paystackEnvironment) {
    console.error("[paystack][config] PAYSTACK_ENVIRONMENT is not validly configured — invoice.payment_failed ignored");
    return;
  }

  const resolvedBusinessId =
    businessId ??
    (await resolveBusinessIdByCustomerCode(admin, data.customer?.customer_code, paystackEnvironment));
  if (!resolvedBusinessId) {
    console.error("[paystack][reconciliation] invoice.payment_failed could not be mapped to any business");
    return;
  }

  // APP-1L-02-R1: the ONE shared identity guard — never bypassed even
  // when `businessId` above came from THIS APPLICATION's own checkout
  // metadata. Every field (provider, environment, customer code,
  // subscription code) is independently re-verified against the CURRENT
  // authoritative row, and an UNBOUND local provider_subscription_code
  // is treated as "not authoritative enough to mutate", never as "no
  // check needed" (see resolveVerifiedRecurringSubscription's own header
  // comment for the exact gap this closes).
  const match = await resolveVerifiedRecurringSubscription(
    admin,
    resolvedBusinessId,
    paystackEnvironment,
    data.customer?.customer_code,
    data.subscription?.subscription_code
  );
  if (!match.ok) {
    console.warn("[paystack][reconciliation] invoice.payment_failed did not pass identity verification — no mutation", {
      businessId: resolvedBusinessId,
      reason: match.reason,
    });
    return;
  }
  const sub = match.subscription;

  // STALE-FAILURE GUARD: an invoice created BEFORE the business's
  // CURRENT period even started describes a billing cycle a later,
  // already-processed successful renewal has superseded — applying it
  // now would incorrectly move an otherwise-healthy ACTIVE subscription
  // to PAST_DUE. Skipped as a safe no-op, never applied. (A failure for
  // the CURRENT or a newer period always proceeds normally.)
  if (data.created_at && sub.currentPeriodStartedAt) {
    const invoiceCreatedAt = new Date(data.created_at).getTime();
    const currentPeriodStart = new Date(sub.currentPeriodStartedAt).getTime();
    if (Number.isFinite(invoiceCreatedAt) && invoiceCreatedAt < currentPeriodStart) {
      console.warn("[paystack] stale invoice.payment_failed skipped", { businessId: resolvedBusinessId });
      return;
    }
  }

  try {
    await admin.rpc("mark_paystack_subscription_payment_failed", { p_business_id: resolvedBusinessId });
  } catch (cause) {
    // SUBSCRIPTION_NOT_ACTIVE is expected whenever the subscription is
    // already PAST_DUE/otherwise not ACTIVE (e.g. a second failure
    // notification before recovery) — never a crash.
    console.warn("[paystack] mark_paystack_subscription_payment_failed rejected", {
      businessId: resolvedBusinessId,
      message: cause instanceof Error ? cause.message : String(cause),
    });
  }
}

async function handleSubscriptionDisable(
  admin: AdminClient,
  businessId: string | null,
  data: {
    subscription_code: string;
    customer?: { customer_code?: string };
  }
): Promise<void> {
  const paystackEnvironment = getPaystackEnvironment();
  if (!paystackEnvironment) {
    console.error("[paystack][config] PAYSTACK_ENVIRONMENT is not validly configured — subscription.disable ignored");
    return;
  }

  const resolvedBusinessId =
    businessId ??
    (await resolveBusinessIdByCustomerCode(admin, data.customer?.customer_code, paystackEnvironment));
  if (!resolvedBusinessId) {
    console.warn("[paystack] subscription.disable could not be mapped to any business — ingested only");
    return;
  }

  // APP-1L-02-R1: the SAME shared identity guard invoice.payment_failed
  // uses — only ever act on a disable event for the CURRENTLY bound
  // provider subscription, never an old/historical one, never an
  // unbound one, and never on customer-code-only attribution — see
  // resolveVerifiedRecurringSubscription's own header comment.
  const match = await resolveVerifiedRecurringSubscription(
    admin,
    resolvedBusinessId,
    paystackEnvironment,
    data.customer?.customer_code,
    data.subscription_code
  );
  if (!match.ok) {
    console.warn("[paystack][reconciliation] subscription.disable did not pass identity verification — no mutation", {
      businessId: resolvedBusinessId,
      reason: match.reason,
    });
    return;
  }

  try {
    // Schedules ONLY (cancel_at_period_end = true) — NEVER ends a valid
    // paid period early. Idempotent against an already-scheduled
    // cancellation (schedule_subscription_cancel itself may be called
    // repeatedly on the same still-cancelable subscription; see the
    // frozen foundation's own test coverage for that exact contract) —
    // whether the owner clicked "cancel" first or Paystack reports the
    // external disable first, the resulting local state converges to
    // the identical `cancel_at_period_end = true`.
    await admin.rpc("schedule_paystack_subscription_cancellation", { p_business_id: resolvedBusinessId });
  } catch (cause) {
    // SUBSCRIPTION_NOT_CANCELABLE is expected once the subscription has
    // already reached a terminal state (CANCELED/EXPIRED) — never a
    // crash.
    console.warn("[paystack] schedule_paystack_subscription_cancellation rejected", {
      businessId: resolvedBusinessId,
      message: cause instanceof Error ? cause.message : String(cause),
    });
  }
}

export async function dispatchPaystackEvent(
  admin: AdminClient,
  eventType: string,
  data: Record<string, unknown>,
  businessId: string | null
): Promise<void> {
  switch (eventType) {
    case PAYSTACK_EVENT.CHARGE_SUCCESS:
      await handleChargeSuccess(admin, businessId, data as never);
      return;
    case PAYSTACK_EVENT.SUBSCRIPTION_CREATE:
      await handleSubscriptionCreate(admin, businessId, data as never);
      return;
    case PAYSTACK_EVENT.INVOICE_PAYMENT_FAILED:
      await handleInvoicePaymentFailed(admin, businessId, data as never);
      return;
    case PAYSTACK_EVENT.SUBSCRIPTION_DISABLE:
      await handleSubscriptionDisable(admin, businessId, data as never);
      return;
    default:
      return;
  }
}

export { resolveBusinessIdByCustomerCode, isUuid };
