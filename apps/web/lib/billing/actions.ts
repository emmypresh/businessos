"use server";

import { randomUUID } from "node:crypto";
import { redirect } from "next/navigation";
import { revalidatePath } from "next/cache";
import { createClient } from "@/lib/supabase/server";
import { createBillingAdminClient } from "@/lib/billing/admin-client";
import { requireUser } from "@/lib/auth/dal";
import { hasPermission } from "@/lib/business/dal";
import { PERMISSION } from "@/lib/business/constants";
import { CheckoutInitSchema } from "@/lib/validation/billing";
import { initializeTransaction, disableSubscription, PaystackClientError } from "@/lib/billing/paystack-client";
import { getPaystackEnvironment } from "@/lib/billing/paystack-environment";
import { mapDatabaseError, toActionState } from "@/lib/errors";
import type { ActionState } from "@/lib/auth/actions";

const PERMISSION_DENIED: ActionState = { error: "You don't have permission to do this." };
const GENERIC_ERROR: ActionState = { error: "Something went wrong. Please try again." };
const CONFIG_ERROR: ActionState = { error: "Billing is not available right now. Please try again later." };

// Every action here independently re-authenticates and re-checks
// billing.manage itself, on every call, regardless of what the billing
// page already rendered or hid — mirrors lib/expenses/actions.ts's own
// established convention exactly.

/**
 * Server-side checkout-init. Never activates a subscription itself —
 * activation happens ONLY once the webhook route has independently
 * verified provider evidence (app/api/webhooks/paystack/route.ts). On
 * success this redirects the browser straight to Paystack's own hosted
 * checkout page — mirrors lib/business/actions.ts's own createBusiness
 * precedent of redirecting on success rather than returning a URL for
 * client-side navigation, so no intermediate state ever holds a
 * checkout URL in the browser's own React state.
 */
export async function initCheckoutAction(
  _prevState: ActionState,
  formData: FormData
): Promise<ActionState> {
  const user = await requireUser();

  const businessIdRaw = formData.get("businessId");
  if (typeof businessIdRaw !== "string" || businessIdRaw.length === 0) {
    return GENERIC_ERROR;
  }
  const businessId = businessIdRaw;

  // 1) AUTHENTICATE — requireUser() above. 2) AUTHORIZE.
  const canManage = await hasPermission(businessId, PERMISSION.BILLING_MANAGE);
  if (!canManage) {
    return PERMISSION_DENIED;
  }

  // PAYSTACK_ENVIRONMENT FAIL CLOSED: an unset/invalid configured
  // environment disables checkout entirely — never a silent TEST/LIVE
  // guess.
  const paystackEnvironment = getPaystackEnvironment();
  if (!paystackEnvironment) {
    return CONFIG_ERROR;
  }

  const parsed = CheckoutInitSchema.safeParse({ priceId: formData.get("priceId") });
  if (!parsed.success) {
    return GENERIC_ERROR;
  }

  const supabase = await createClient();

  // 3) Load current subscription — a business created after this round
  // always has exactly one row (create_business now issues it
  // transactionally); a pre-existing business with none yet is treated
  // identically to "not found" (never disclosed which).
  const { data: subscription, error: subError } = await supabase
    .from("business_subscriptions")
    .select("id, plan_id")
    .eq("business_id", businessId)
    .maybeSingle();
  if (subError || !subscription) {
    return GENERIC_ERROR;
  }

  // 4) Load the SELECTED price — never trusted from the form beyond its
  // id. Every other field (amount, currency, interval, provider,
  // environment, plan) is re-read from the authoritative row here, and
  // the frozen activation RPC re-validates all of it AGAIN independently
  // once the webhook eventually calls it — this is defense in depth, not
  // the only check.
  const { data: price, error: priceError } = await supabase
    .from("subscription_plan_prices")
    .select("id, plan_id, provider, provider_environment, currency, amount_minor, is_active, provider_plan_code")
    .eq("id", parsed.data.priceId)
    .maybeSingle();

  if (priceError || !price || !price.is_active) {
    return { error: "This plan is not currently available for checkout." };
  }
  // 5) Confirm provider = PAYSTACK.
  if (price.provider !== "PAYSTACK") {
    return { error: "This plan is not currently available for checkout." };
  }
  // 6) Confirm environment matches configured application environment.
  if (price.provider_environment !== paystackEnvironment) {
    return { error: "This plan is not currently available for checkout." };
  }
  // No approved provider-side plan object exists for this price yet —
  // per this round's own explicit "keep checkout disabled/clearly
  // unavailable until approved rows are configured" instruction. This is
  // the CURRENT, honest state of the seeded catalog (no price rows exist
  // at all yet), not a hypothetical.
  if (!price.provider_plan_code) {
    return { error: "Checkout is not yet available for this plan. Please check back soon." };
  }

  // 7) Resolve billing email from the SESSION, never from the form.
  const email = user.email;
  if (!email) {
    return { error: "Your account has no verified email on file." };
  }

  // 8) Unique provider reference, generated server-side — never
  // accepted from any caller.
  const reference = `bos_${businessId.replace(/-/g, "").slice(0, 12)}_${randomUUID().replace(/-/g, "")}`;

  // CHECKOUT IDEMPOTENCY / DOUBLE-SUBMIT HARDENING (Codex-identified):
  // claims a short-lived, server-side checkout intent BEFORE ever
  // calling Paystack. A second, concurrent/rapid submission for the SAME
  // business collapses onto this SAME structural guard
  // (private.checkout_intents' own partial unique index — at most one
  // PENDING intent per business) and is rejected here, before a second
  // payable Paystack session could ever be created — never a client-only
  // disabled-button boundary. A stale (>15 minute) abandoned intent is
  // reaped automatically by the function itself, so a genuinely failed/
  // abandoned attempt can always be retried; this is never an indefinite
  // lockout.
  const { error: intentError } = await supabase.rpc("begin_paystack_checkout_intent", {
    p_business_id: businessId,
    p_price_id: price.id,
    p_provider_reference: reference,
  });
  if (intentError) {
    if (intentError.message.includes("CHECKOUT_ALREADY_IN_PROGRESS")) {
      return { error: "A checkout is already in progress for this business. Please wait a moment and try again." };
    }
    return GENERIC_ERROR;
  }

  let checkoutUrl: string;
  try {
    const result = await initializeTransaction({
      email,
      amountMinor: String(price.amount_minor),
      currency: price.currency,
      reference,
      planCode: price.provider_plan_code,
      // 11) NEVER accept amount from the browser — amountMinor above
      // came exclusively from the authoritative price row re-read at
      // step 4. metadata.business_id/price_id let the webhook resolve
      // the FIRST charge.success back to this exact business/price
      // without trusting anything else in that payload.
      metadata: { business_id: businessId, price_id: price.id },
    });
    checkoutUrl = result.authorizationUrl;
  } catch (cause) {
    // CHK-1L-01: provider initialization failed — the PENDING intent
    // claimed above must NOT survive until the 15-minute stale reaper;
    // it is marked FAILED/EXPIRED immediately, by exact
    // (business_id, reference), so the owner can retry right away, and
    // so this cleanup can never touch a DIFFERENT, newer intent for the
    // same business (e.g. one this same retry is about to create).
    // Best-effort: a failure here never masks the real provider error
    // below, and the stale reaper remains a correct fallback regardless.
    try {
      await supabase.rpc("fail_paystack_checkout_intent", { p_business_id: businessId, p_provider_reference: reference });
    } catch {
      // Non-fatal.
    }
    if (cause instanceof PaystackClientError) {
      return { error: cause.message };
    }
    return GENERIC_ERROR;
  }

  // Audit only — recorded ONLY once a real, usable checkout URL exists
  // (never before: a provider initialization failure above returns
  // without ever reaching here, so no "checkout started" audit event is
  // ever recorded for an attempt that never actually produced a
  // checkout the owner could use). Never blocks checkout if it somehow
  // fails; logged, not surfaced.
  try {
    await supabase.rpc("record_subscription_checkout_started", { p_business_id: businessId });
  } catch {
    // Non-fatal.
  }

  // 12) Hands the browser ONLY a safe checkout URL to redirect to — no
  // secret, no internal identifiers beyond what it already had.
  // redirect() throws internally; it must be called OUTSIDE the try/catch
  // above, or its own control-flow signal would be caught by the generic
  // `catch` and turned into a false GENERIC_ERROR.
  redirect(checkoutUrl);
}

/**
 * Owner-facing cancellation — APP-1L-03. Real provider-side
 * cancellation, never a local-only flag: Paystack's own recurring charge
 * must actually be disabled BEFORE this application ever records a
 * cancellation as scheduled, or a browser could be shown "canceled"
 * while Paystack keeps charging.
 *
 * ORDER (per this round's own explicit sequence):
 *  1. authenticate (requireUser)
 *  2. require active membership + billing.manage (hasPermission, via the
 *     caller's OWN session — never the service-role client)
 *  3. load authoritative subscription (provider/environment/subscription
 *     code/email token) — via the SERVICE-ROLE boundary exclusively
 *     (public.get_paystack_subscription_disable_context), never via the
 *     general billing DAL, which never even selects these columns
 *  4. verify provider = PAYSTACK
 *  5. verify environment matches configured PAYSTACK_ENVIRONMENT
 *  6. verify provider_subscription_code exists
 *  7. verify provider_email_token exists
 *  8. call Paystack Disable Subscription
 *  9. ONLY if it succeeds, call the frozen-adjacent
 *     request_subscription_cancellation (via the caller's OWN session
 *     again — that RPC re-derives auth.uid()/billing.manage itself)
 * If provider disable fails (or any precondition above is unmet), local
 * cancellation is NEVER scheduled — a safe, retryable error is returned,
 * never a false success.
 */
export async function cancelSubscriptionAction(
  _prevState: ActionState,
  formData: FormData
): Promise<ActionState> {
  await requireUser();
  const businessId = formData.get("businessId");
  if (typeof businessId !== "string" || businessId.length === 0) {
    return GENERIC_ERROR;
  }

  const supabase = await createClient();

  // 2) AUTHORIZE — using the CALLER's own session/RLS, never the
  // service-role client below.
  const canManage = await hasPermission(businessId, PERMISSION.BILLING_MANAGE);
  if (!canManage) {
    return PERMISSION_DENIED;
  }

  // 3) Load authoritative provider identity — service-role boundary
  // ONLY. provider_email_token is never selectable by `authenticated`
  // anywhere in this schema (no grant exists for that role on this
  // column at all) — this admin client is the ONLY way this Server
  // Action (itself trusted, server-only code the browser never runs)
  // can read it, mirroring the webhook route's own established
  // "authorize with the ordinary boundary, then switch to service-role
  // for the sensitive part" pattern.
  const admin = createBillingAdminClient();
  const { data: context, error: contextError } = await admin
    .rpc("get_paystack_subscription_disable_context", { p_business_id: businessId })
    .maybeSingle();

  if (contextError || !context) {
    return GENERIC_ERROR;
  }

  // MANUAL (a trial, or a negotiated/enterprise subscription) has no
  // real Paystack recurrence to disable at all — the ORIGINAL, simple
  // local-only cancellation remains fully correct and sufficient for it
  // (never ends a valid paid period early either way). The real
  // provider-disable flow below applies ONLY once provider = PAYSTACK —
  // "not acceptable once paid checkout is available" (APP-1L-03) never
  // meant every subscription of every provider needs it.
  if (context.provider === "PAYSTACK") {
    // 5) PAYSTACK_ENVIRONMENT FAIL CLOSED — rejected before any provider
    // call.
    const paystackEnvironment = getPaystackEnvironment();
    if (!paystackEnvironment) {
      return CONFIG_ERROR;
    }
    // 5) environment match — rejected BEFORE any provider call.
    if (context.provider_environment !== paystackEnvironment) {
      return { error: "This subscription cannot be canceled from this environment." };
    }
    // 6/7) subscription code + email token must both be present — a
    // subscription that never received a verified subscription.create
    // event (e.g. checkout not yet completed, or a reconciliation gap)
    // has no safe way to reach Paystack's own Disable Subscription
    // endpoint yet.
    if (!context.provider_subscription_code || !context.provider_email_token) {
      return {
        error: "Cancellation isn't available for this subscription yet. Please try again shortly, or contact support.",
      };
    }

    // 8) Call Paystack Disable Subscription. Never logs/returns
    // provider_email_token — see paystack-client.ts's own
    // disableSubscription header comment.
    try {
      await disableSubscription({
        code: context.provider_subscription_code,
        token: context.provider_email_token,
      });
    } catch (cause) {
      // Provider disable failed — local cancellation is NEVER scheduled.
      // Safe, retryable message; no false success UI.
      if (cause instanceof PaystackClientError) {
        return { error: cause.message };
      }
      return GENERIC_ERROR;
    }
  }

  // 9) ONLY now — either provider recurrence is confirmed disabled, or
  // there was never any to disable (MANUAL) — record the LOCAL
  // cancellation, via the caller's OWN session (this RPC re-
  // authenticates/re-authorizes itself; it has no way to run under
  // service_role's identity, by design). This never ends a valid paid
  // period early — see that function's own header comment.
  const { error } = await supabase.rpc("request_subscription_cancellation", {
    p_business_id: businessId,
  });

  if (error) {
    // Paystack's own recurrence IS already disabled at this point even
    // though the local record failed — a retry of this same action is
    // safe (disableSubscription against an already-disabled subscription
    // is itself an idempotent no-op on Paystack's side), so this still
    // returns a plain retryable error rather than a false success.
    return toActionState(mapDatabaseError(error));
  }

  revalidatePath(`/${businessId}/settings/billing`);
  return { success: true };
}
