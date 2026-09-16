import { NextResponse, type NextRequest } from "next/server";
import { createWhatsappAdminClient } from "@/lib/whatsapp/admin-client";
import { getWhatsappConfig } from "@/lib/whatsapp/config";
import { verifyMetaWebhookSignature, verifyMetaWebhookVerifyToken } from "@/lib/whatsapp/webhook-signature";
import { WebhookEnvelopeSchema, sha256Hex } from "@/lib/whatsapp/webhook-events";
import { processMetaWebhookEnvelope } from "@/lib/whatsapp/webhook-handlers";

// Node runtime required: node:crypto (HMAC-SHA256, timingSafeEqual) is
// not available in the Edge runtime — mirrors
// app/api/webhooks/paystack/route.ts's own identical requirement.
export const runtime = "nodejs";

// No browser/session auth requirement — a Meta webhook carries no
// BusinessOS session at all. GET is Meta's own one-time verification
// handshake; POST is event delivery. Any other method is a 405 by
// Next.js's own App Router default, since no other handler is exported.

// Application-layer body-size bound, enforced BEFORE any JSON parsing —
// this phase's own explicit "do not allow unbounded body ingestion"
// instruction. 1 MiB is generously above any legitimate Meta webhook
// payload this application processes (even a batched delivery of many
// text messages/statuses is a few KB) while still bounding worst-case
// memory/CPU cost of a hostile oversized request.
const MAX_BODY_BYTES = 1_000_000;

export async function GET(request: NextRequest): Promise<NextResponse> {
  const config = getWhatsappConfig();
  if (!config) {
    // Fail closed: never a silent default token/pass-through.
    return NextResponse.json({ error: "not configured" }, { status: 500 });
  }

  const { searchParams } = request.nextUrl;
  const mode = searchParams.get("hub.mode");
  const verifyToken = searchParams.get("hub.verify_token");
  const challenge = searchParams.get("hub.challenge");

  if (mode !== "subscribe" || !challenge) {
    return NextResponse.json({ error: "invalid request" }, { status: 403 });
  }

  // Timing-safe comparison — never a leaking `===` on the raw strings.
  // Never logs the provided or configured token, on success or failure.
  if (!verifyMetaWebhookVerifyToken(verifyToken, config.verifyToken)) {
    console.warn("[whatsapp webhook] GET verification failed: token mismatch or missing");
    return NextResponse.json({ error: "verification failed" }, { status: 403 });
  }

  // No DB mutation of any kind on this path — plain-text challenge
  // echo only, exactly as Meta's own documented handshake requires.
  return new NextResponse(challenge, { status: 200, headers: { "Content-Type": "text/plain" } });
}

export async function POST(request: NextRequest): Promise<NextResponse> {
  const contentLengthHeader = request.headers.get("content-length");
  if (contentLengthHeader) {
    const declaredLength = Number(contentLengthHeader);
    if (Number.isFinite(declaredLength) && declaredLength > MAX_BODY_BYTES) {
      return NextResponse.json({ error: "payload too large" }, { status: 413 });
    }
  }

  // RAW body, read as text, exactly ONCE, BEFORE any JSON parsing — the
  // signature is computed over these exact bytes. See
  // lib/whatsapp/webhook-signature.ts for why parsing first would make
  // the signature check meaningless. request.json() is NEVER called on
  // this request.
  const rawBody = await request.text();

  if (Buffer.byteLength(rawBody, "utf8") > MAX_BODY_BYTES) {
    // Defensive re-check in case Content-Length was absent or understated.
    return NextResponse.json({ error: "payload too large" }, { status: 413 });
  }

  const config = getWhatsappConfig();
  if (!config) {
    console.error("[whatsapp webhook] WHATSAPP is not configured — refusing to process");
    return NextResponse.json({ error: "server configuration error" }, { status: 500 });
  }

  const signatureHeader = request.headers.get("x-hub-signature-256");
  if (!verifyMetaWebhookSignature(rawBody, signatureHeader, config.appSecret)) {
    // Invalid/missing signature -> reject BEFORE any JSON parsing and
    // BEFORE any database mutation. No detail distinguishing "missing"
    // vs. "mismatch" vs. "tampered body" is ever disclosed.
    console.warn("[whatsapp webhook] signature verification failed");
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

  // Only AFTER signature verification AND envelope validation does this
  // route ever create a service-role client or attempt any mutation.
  const admin = createWhatsappAdminClient();
  const payloadSha256 = sha256Hex(rawBody);

  // WA-APP-01: a transient downstream-mutation failure is durably
  // recorded as FAILED_RETRYABLE by the atomic orchestrator RPCs
  // (lib/whatsapp/webhook-handlers.ts) — this route must NOT mask that
  // with a 200. Meta's own retry is this round's only recovery source
  // (background workers/reconciliation are explicitly deferred), so a
  // retry-triggering non-2xx is returned instead, and an exact replay
  // will re-enter the same ledger row and safely retry the mutation.
  // An UNEXPECTED (non-per-item) exception reaching the outer catch
  // below means this route cannot even be sure what state was reached
  // — treated identically: never acknowledged as if the work completed.
  try {
    const { hadRetryableFailure } = await processMetaWebhookEnvelope(admin, envelope.data, payloadSha256);
    if (hadRetryableFailure) {
      console.error("[whatsapp webhook] one or more events failed transiently, requesting a Meta retry");
      return NextResponse.json({ error: "processing error" }, { status: 500 });
    }
  } catch (cause) {
    // Never leaks internal DB/provider error detail to the caller.
    console.error("[whatsapp webhook] unexpected processing error", {
      cause: cause instanceof Error ? cause.message : String(cause),
    });
    return NextResponse.json({ error: "processing error" }, { status: 500 });
  }

  return NextResponse.json({ received: true }, { status: 200 });
}
