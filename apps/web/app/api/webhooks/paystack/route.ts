import { NextResponse, type NextRequest } from "next/server";
import { createBillingAdminClient } from "@/lib/billing/admin-client";
import { verifyPaystackSignature } from "@/lib/billing/webhook-signature";
import { WebhookEnvelopeSchema, derivePaystackEventKey, sha256Hex } from "@/lib/billing/webhook-events";
import { isAllowedPaystackEvent } from "@/lib/billing/constants";
import { getPaystackEnvironment } from "@/lib/billing/paystack-environment";
import { dispatchPaystackEvent, resolveBusinessIdByCustomerCode, isUuid } from "@/lib/billing/webhook-handlers";

// Node runtime required: node:crypto (HMAC-SHA512, timingSafeEqual) is
// not available in the Edge runtime.
export const runtime = "nodejs";

// No browser/session auth requirement — a Paystack webhook carries no
// BusinessOS session at all; the signature itself IS the authentication.
// No CORS handling exists here (no OPTIONS/other method export) — this
// endpoint is never called from a browser, so no cross-origin exposure
// is needed or provided. POST only: any other method (including GET) is
// a 405 by Next.js's own App Router default, since no other handler is
// exported from this file.
export async function POST(request: NextRequest): Promise<NextResponse> {
  // RAW body, read as text, BEFORE any JSON interpretation — the
  // signature is computed over these exact bytes. See
  // lib/billing/webhook-signature.ts's own header comment for why
  // parsing first (even into an object that round-trips identically)
  // would make the entire signature check meaningless.
  const rawBody = await request.text();
  const signatureHeader = request.headers.get("x-paystack-signature");
  const secretKey = process.env.PAYSTACK_SECRET_KEY;

  if (!secretKey || !verifyPaystackSignature(rawBody, signatureHeader, secretKey)) {
    // Invalid/missing signature -> reject BEFORE any database mutation,
    // and before the body is ever parsed as JSON. No detail about WHY
    // (missing header vs. mismatch vs. tampered body) is distinguishable
    // in the response — all three look identical to the caller.
    console.warn("[paystack webhook] signature verification failed");
    return NextResponse.json({ error: "invalid signature" }, { status: 401 });
  }

  let parsedJson: unknown;
  try {
    parsedJson = JSON.parse(rawBody);
  } catch {
    return NextResponse.json({ error: "malformed body" }, { status: 400 });
  }

  const envelope = WebhookEnvelopeSchema.safeParse(parsedJson);
  if (!envelope.success) {
    return NextResponse.json({ error: "malformed event" }, { status: 400 });
  }

  const { event: eventType, data } = envelope.data;

  // PAYSTACK_ENVIRONMENT FAIL CLOSED: an unset/invalid configured
  // environment must never silently default to TEST (or anything else)
  // — every provider lookup and every state mutation below requires this
  // value explicitly, so processing stops here, loudly, as a genuine
  // server configuration error, before ANY ingestion or mutation is
  // attempted. This is deliberately checked AFTER signature verification
  // (an attacker with no valid signature learns nothing new from this
  // response) but BEFORE the allowlist/ingest/dispatch pipeline.
  const paystackEnvironment = getPaystackEnvironment();
  if (!paystackEnvironment) {
    console.error("[paystack webhook] PAYSTACK_ENVIRONMENT is not validly configured (TEST/LIVE) — refusing to process");
    return NextResponse.json({ error: "server configuration error" }, { status: 500 });
  }

  // Explicit allowlist (lib/billing/constants.ts) — every OTHER event
  // type Paystack might ever send is acknowledged here, safely, with NO
  // mutation and NO provider-event record at all (this application has
  // no derivation rule for it, and inventing one for an event it does
  // not act on would add surface for no benefit).
  if (!isAllowedPaystackEvent(eventType)) {
    return NextResponse.json({ received: true }, { status: 200 });
  }

  const payloadHash = sha256Hex(rawBody);
  const eventKey = derivePaystackEventKey(eventType, data);

  if (!eventKey) {
    // Allowlisted event type, but its OWN payload failed the minimal
    // shape this application requires to safely derive a key at all
    // (see lib/billing/webhook-events.ts's own per-event schemas) —
    // "rejected safely": acknowledged (so Paystack does not retry
    // forever against a payload shape that will never change), but
    // never ingested and never mutates any subscription state.
    console.warn("[paystack webhook] event failed shape validation, acknowledged without processing", { eventType });
    return NextResponse.json({ received: true }, { status: 200 });
  }

  const admin = createBillingAdminClient();

  const metadata = (data as { metadata?: Record<string, unknown> }).metadata;
  const customerCode = (data as { customer?: { customer_code?: string } }).customer?.customer_code;
  const metaBusinessId = isUuid(metadata?.business_id) ? (metadata!.business_id as string) : null;
  const businessId = metaBusinessId ?? (await resolveBusinessIdByCustomerCode(admin, customerCode, paystackEnvironment));

  let subscriptionId: string | null = null;
  if (businessId) {
    const { data: sub } = await admin
      .from("business_subscriptions")
      .select("id")
      .eq("business_id", businessId)
      .maybeSingle();
    subscriptionId = sub?.id ?? null;
  }

  const { data: ingestResult, error: ingestError } = await admin.rpc("ingest_paystack_provider_event", {
    p_provider_event_key: eventKey,
    p_event_type: eventType,
    p_payload_hash: payloadHash,
    p_business_id: businessId ?? undefined,
    p_subscription_id: subscriptionId ?? undefined,
  });

  if (ingestError) {
    if (ingestError.message.includes("PROVIDER_EVENT_CONFLICT")) {
      // High-signal: the SAME (provider, event key) was seen before with
      // a DIFFERENT payload/association — evidence of a key collision,
      // a provider inconsistency, an incorrect derivation, or tampering.
      // Never silently absorbed. A controlled, non-2xx, retry-safe
      // response (Paystack's own retry policy will re-attempt; each
      // retry re-runs the identical, deterministic conflict check —
      // this can never resolve itself by being retried, but it also
      // never mutates anything on any retry).
      console.error("[paystack webhook] PROVIDER_EVENT_CONFLICT", { eventType, eventKey });
      return NextResponse.json({ error: "event conflict" }, { status: 409 });
    }
    console.error("[paystack webhook] ingest_paystack_provider_event failed", { message: ingestError.message });
    return NextResponse.json({ error: "processing error" }, { status: 500 });
  }

  const row = ingestResult?.[0];
  if (!row?.is_new) {
    // Exact replay — already fully processed by an earlier delivery.
    // Safe success, no further work.
    return NextResponse.json({ received: true }, { status: 200 });
  }

  await dispatchPaystackEvent(admin, eventType, data, businessId);

  return NextResponse.json({ received: true }, { status: 200 });
}
