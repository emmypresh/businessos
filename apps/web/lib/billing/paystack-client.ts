import "server-only";

/**
 * Narrow, server-only Paystack HTTP client. Deliberately NOT a general
 * Paystack SDK — this round's own explicit "keep surface minimal"
 * instruction: exactly one call is implemented (Initialize Transaction),
 * because checkout-init (lib/billing/actions.ts) is the only place this
 * application ever calls out to Paystack. Every other piece of provider
 * evidence (charge success, subscription lifecycle, renewal, failure)
 * arrives via the WEBHOOK (app/api/webhooks/paystack/route.ts), verified
 * independently of anything this client returns.
 *
 * PAYSTACK_SECRET_KEY is read ONLY here — never imported into any file
 * reachable from a Client Component (`import "server-only"` makes that a
 * build-time error), and never logged, returned, or embedded in any
 * response this module produces.
 */

const PAYSTACK_API_BASE = "https://api.paystack.co";

// A checkout-init request is interactive (a browser waiting on a Server
// Action) — bounded so a slow/hanging Paystack response can never hang
// the request indefinitely.
const REQUEST_TIMEOUT_MS = 10_000;

export class PaystackClientError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PaystackClientError";
  }
}

function getSecretKey(): string {
  const key = process.env.PAYSTACK_SECRET_KEY;
  if (!key) {
    throw new PaystackClientError("Paystack is not configured.");
  }
  return key;
}

export type InitializeTransactionInput = {
  email: string;
  amountMinor: string;
  currency: string;
  reference: string;
  // Paystack's own plan code (subscription_plan_prices.provider_plan_code)
  // — when present, a successful charge against this transaction creates
  // a Paystack Subscription tied to that plan, which is what later
  // produces the subscription.create/charge.success/invoice.payment_failed
  // webhook events this application processes. Never invented locally —
  // always read from an authoritative, already-configured price row (see
  // lib/billing/actions.ts).
  planCode?: string;
  callbackUrl?: string;
  metadata?: Record<string, unknown>;
};

export type InitializeTransactionResult = {
  authorizationUrl: string;
  accessCode: string;
  reference: string;
};

type PaystackInitializeResponse = {
  status: boolean;
  message: string;
  data?: {
    authorization_url: string;
    access_code: string;
    reference: string;
  };
};

/**
 * Calls Paystack's POST /transaction/initialize. Never trusts anything
 * back from this call as payment evidence — its ONLY legitimate use is
 * to hand the caller's browser a URL to redirect to. Actual payment
 * confirmation is the webhook's job, exclusively.
 */
export async function initializeTransaction(
  input: InitializeTransactionInput
): Promise<InitializeTransactionResult> {
  const secretKey = getSecretKey();

  let response: Response;
  try {
    response = await fetch(`${PAYSTACK_API_BASE}/transaction/initialize`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${secretKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        email: input.email,
        amount: input.amountMinor,
        currency: input.currency,
        reference: input.reference,
        plan: input.planCode,
        callback_url: input.callbackUrl,
        metadata: input.metadata,
      }),
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
  } catch (cause) {
    // Sanitized server-side log only — the caller (a Server Action) gets
    // a generic, safe message, never this raw network error text.
    console.error("[paystack] initializeTransaction network error", {
      reference: input.reference,
      cause: cause instanceof Error ? cause.message : String(cause),
    });
    throw new PaystackClientError("Could not reach the payment provider. Please try again.");
  }

  let body: PaystackInitializeResponse | null = null;
  try {
    body = (await response.json()) as PaystackInitializeResponse;
  } catch {
    body = null;
  }

  if (!response.ok || !body?.status || !body.data) {
    // Never logs the full response body (Paystack error messages can
    // echo back request fields) — only the fields needed to diagnose a
    // failure without risking sensitive echoal.
    console.error("[paystack] initializeTransaction failed", {
      reference: input.reference,
      httpStatus: response.status,
      providerMessage: body?.message,
    });
    throw new PaystackClientError("Could not start checkout. Please try again.");
  }

  return {
    authorizationUrl: body.data.authorization_url,
    accessCode: body.data.access_code,
    reference: body.data.reference,
  };
}

export type DisableSubscriptionInput = {
  code: string;
  token: string;
};

type PaystackDisableResponse = {
  status: boolean;
  message: string;
};

/**
 * Calls Paystack's POST /subscription/disable — the ONLY provider call
 * this application makes to actually stop future recurring charges
 * (APP-1L-03). `code`/`token` must be loaded server-side from
 * authoritative business_subscriptions state
 * (lib/billing/actions.ts#cancelSubscriptionAction, via the service-role
 * boundary — see public.get_paystack_subscription_disable_context) —
 * this function itself never reads or knows anything about WHERE its
 * two inputs came from, and never accepts them from a browser.
 *
 * Never logs `token` — not in a success log, not in an error log, not
 * in a thrown message. The generic UI error this throws carries no
 * detail an attacker (or a bug report copy/paste) could use to recover
 * either input.
 */
export async function disableSubscription(input: DisableSubscriptionInput): Promise<void> {
  const secretKey = getSecretKey();

  let response: Response;
  try {
    response = await fetch(`${PAYSTACK_API_BASE}/subscription/disable`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${secretKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ code: input.code, token: input.token }),
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
  } catch (cause) {
    console.error("[paystack] disableSubscription network error", {
      cause: cause instanceof Error ? cause.message : String(cause),
    });
    throw new PaystackClientError("Could not reach the payment provider. Please try again.");
  }

  let body: PaystackDisableResponse | null = null;
  try {
    body = (await response.json()) as PaystackDisableResponse;
  } catch {
    body = null;
  }

  if (!response.ok || !body?.status) {
    // Never logs `input.code`/`input.token`, and never the raw response
    // body (which could echo request fields) — only the minimal fields
    // needed to diagnose a failure.
    console.error("[paystack] disableSubscription failed", {
      httpStatus: response.status,
      providerMessage: body?.message,
    });
    throw new PaystackClientError("Could not cancel the subscription with the payment provider. Please try again.");
  }
}
