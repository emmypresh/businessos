import "server-only";
import { cache } from "react";
import { createClient } from "@/lib/supabase/server";
import { requireUser } from "@/lib/auth/dal";
import type { PlanCode } from "@/lib/billing/constants";
import { getPaystackEnvironment } from "@/lib/billing/paystack-environment";

// Every function here is a PLAIN, RLS-gated PostgREST query (or the one
// SECURITY DEFINER read helper the frozen DB foundation already exposes,
// public.get_business_entitlement) — never a new privileged read RPC.
// business_subscriptions/billing_transactions are billing.view-gated by
// their own frozen RLS policy; subscription_plans/plan_entitlements/
// subscription_plan_prices are open to any authenticated caller (the
// product CATALOG, not a specific business's own billing detail) — see
// each table's own RLS section in the frozen migrations for the exact
// contract this mirrors.

export type SubscriptionRow = {
  id: string;
  businessId: string;
  planId: string;
  priceId: string | null;
  provider: string;
  providerEnvironment: string | null;
  status: string;
  billingInterval: string | null;
  currency: string;
  amountMinor: string | null;
  trialStartedAt: string | null;
  trialEndsAt: string | null;
  currentPeriodStartedAt: string | null;
  currentPeriodEndsAt: string | null;
  cancelAtPeriodEnd: boolean;
  canceledAt: string | null;
  endedAt: string | null;
  graceEndsAt: string | null;
  createdAt: string;
  updatedAt: string;
  // Presence-only signal for gating the provider-cancellation UI
  // (APP-1L-03: "paid/provider cancellation UI only appears when
  // provider identity required for cancellation exists") — the actual
  // provider_subscription_code value is READ here (already
  // billing.view-grant-readable at the RLS layer, same as before) ONLY
  // to compute this boolean; it is never included in the object this
  // function returns, and provider_email_token is never selected by this
  // DAL at all, anywhere, under any circumstance (no grant exists for
  // `authenticated` on that column — see the new migration's own header
  // comment).
  hasProviderSubscriptionIdentity: boolean;
};

// Deliberately NEVER selects provider_customer_code, and never returns
// provider_subscription_code's own VALUE — this round's own explicit "do
// not expose provider identifiers to the UI" instruction.
// provider_subscription_code is read only to derive
// hasProviderSubscriptionIdentity above; provider_email_token is never
// selected here under any circumstance (see
// public.get_paystack_subscription_disable_context's own header comment
// in the new migration for the ONE place that column is ever read, and
// only by the service-role boundary).
const SUBSCRIPTION_COLUMNS =
  "id, business_id, plan_id, price_id, provider, provider_environment, status, " +
  "billing_interval, currency, amount_minor, trial_started_at, trial_ends_at, " +
  "current_period_started_at, current_period_ends_at, cancel_at_period_end, " +
  "canceled_at, ended_at, grace_ends_at, created_at, updated_at, provider_subscription_code";

function toSubscriptionRow(row: Record<string, unknown>): SubscriptionRow {
  return {
    id: row.id as string,
    businessId: row.business_id as string,
    planId: row.plan_id as string,
    priceId: (row.price_id as string | null) ?? null,
    provider: row.provider as string,
    providerEnvironment: (row.provider_environment as string | null) ?? null,
    status: row.status as string,
    billingInterval: (row.billing_interval as string | null) ?? null,
    currency: row.currency as string,
    amountMinor: row.amount_minor == null ? null : String(row.amount_minor),
    trialStartedAt: (row.trial_started_at as string | null) ?? null,
    trialEndsAt: (row.trial_ends_at as string | null) ?? null,
    currentPeriodStartedAt: (row.current_period_started_at as string | null) ?? null,
    currentPeriodEndsAt: (row.current_period_ends_at as string | null) ?? null,
    cancelAtPeriodEnd: Boolean(row.cancel_at_period_end),
    canceledAt: (row.canceled_at as string | null) ?? null,
    endedAt: (row.ended_at as string | null) ?? null,
    graceEndsAt: (row.grace_ends_at as string | null) ?? null,
    createdAt: row.created_at as string,
    updatedAt: row.updated_at as string,
    hasProviderSubscriptionIdentity: Boolean(row.provider_subscription_code),
  };
}

// null means either "no row" (structurally impossible for any business
// created after this round — create_business now always issues a trial
// transactionally) or "caller lacks billing.view" — RLS makes these two
// cases indistinguishable at this layer on purpose, matching every other
// DAL's own non-disclosure convention.
export const getBusinessSubscription = cache(
  async (businessId: string): Promise<SubscriptionRow | null> => {
    await requireUser();
    const supabase = await createClient();
    const { data, error } = await supabase
      .from("business_subscriptions")
      .select(SUBSCRIPTION_COLUMNS)
      .eq("business_id", businessId)
      .maybeSingle();

    if (error) {
      throw new Error("Unable to load subscription.");
    }
    // Mirrors lib/notifications/dal.ts's own identical pattern: a
    // dynamic (non-literal) column-list string defeats Supabase's own
    // select-string type inference, so the raw row is cast once, here,
    // to the plain shape toSubscriptionRow expects.
    return data ? toSubscriptionRow(data as unknown as Record<string, unknown>) : null;
  }
);

export type EntitlementRow = {
  isEntitled: boolean;
  planCode: string | null;
  status: string | null;
  effectiveUntil: string | null;
};

// Wraps the frozen public.get_business_entitlement — the SERVER-
// AUTHORITATIVE fact this round's own "server-authoritative entitlement
// helpers" instruction asks for. Gated on active membership ALONE (never
// billing.view — see that function's own header comment for the full
// rationale), so this is safe to call from any server-side feature-gate
// check anywhere in the app, not only the billing page.
export const getBusinessEntitlement = cache(
  async (businessId: string): Promise<EntitlementRow | null> => {
    await requireUser();
    const supabase = await createClient();
    const { data, error } = await supabase.rpc("get_business_entitlement", {
      p_business_id: businessId,
    });
    if (error) {
      throw new Error("Unable to load entitlement.");
    }
    const row = data?.[0];
    if (!row) return null;
    return {
      isEntitled: Boolean(row.is_entitled),
      planCode: row.plan_code ?? null,
      status: row.status ?? null,
      effectiveUntil: row.effective_until ?? null,
    };
  }
);

export type PlanRow = {
  id: string;
  code: PlanCode;
  name: string;
  description: string | null;
  sortOrder: number;
};

export const listPublicPlans = cache(async (): Promise<PlanRow[]> => {
  await requireUser();
  const supabase = await createClient();
  const { data, error } = await supabase
    .from("subscription_plans")
    .select("id, code, name, description, sort_order")
    .eq("is_active", true)
    .eq("is_public", true)
    .order("sort_order");

  if (error) {
    throw new Error("Unable to load plans.");
  }
  return (data ?? []).map((row) => ({
    id: row.id,
    code: row.code as PlanCode,
    name: row.name,
    description: row.description,
    sortOrder: row.sort_order,
  }));
});

export type PriceRow = {
  id: string;
  planId: string;
  billingInterval: string;
  currency: string;
  amountMinor: string;
};

// Scoped to THIS application's own configured PAYSTACK_ENVIRONMENT and
// provider PAYSTACK only — never surfaces a TEST price while running
// LIVE, or vice versa (mirrors activate_paystack_subscription's own
// server-side PRICE_ENVIRONMENT_MISMATCH guard; this is the UI-side half
// of that same invariant, not a substitute for it). Empty when no
// approved price has been configured for a plan yet — the billing page
// renders that as "checkout unavailable", never a crash, per this
// round's own "do not invent final commercial pricing silently" /
// "keep checkout disabled until approved rows exist" instruction.
export const listActivePricesForPlan = cache(
  async (planId: string): Promise<PriceRow[]> => {
    await requireUser();

    // PAYSTACK_ENVIRONMENT FAIL CLOSED: an unset/invalid configured
    // environment must never fall back to guessing TEST or LIVE — no
    // price is ever surfaced, which is exactly what "checkout disabled"
    // looks like to the billing page, never a crash.
    const paystackEnvironment = getPaystackEnvironment();
    if (!paystackEnvironment) {
      return [];
    }

    const supabase = await createClient();
    const { data, error } = await supabase
      .from("subscription_plan_prices")
      .select("id, plan_id, billing_interval, currency, amount_minor")
      .eq("plan_id", planId)
      .eq("provider", "PAYSTACK")
      .eq("provider_environment", paystackEnvironment)
      .eq("is_active", true)
      .order("billing_interval");

    if (error) {
      throw new Error("Unable to load pricing.");
    }
    return (data ?? []).map((row) => ({
      id: row.id,
      planId: row.plan_id,
      billingInterval: row.billing_interval as string,
      currency: row.currency,
      amountMinor: String(row.amount_minor),
    }));
  }
);
