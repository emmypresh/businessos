"use client";

import Link from "next/link";
import { useActionState, useEffect, useRef, useState, useMemo } from "react";
import type { KeyboardEvent } from "react";
import { useRouter } from "next/navigation";
import { ArrowLeft, Check, CheckCheck, MessageCircle, Search, Send, ShieldAlert } from "lucide-react";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { sendWhatsAppMessageAction } from "@/lib/whatsapp/actions";
import type { WhatsAppSendActionState } from "@/lib/whatsapp/actions";
import type { WhatsappInboxConversationRow, WhatsappInboxMessageRow, WhatsappSendableTemplateRow } from "@/lib/whatsapp/dal";

export function whatsappMessageStatusLabel(status: string) {
  return ({ PENDING: "Pending", ACCEPTED: "Accepted", SENT: "Sent", DELIVERED: "Delivered", READ: "Read", FAILED: "Failed" } as Record<string, string>)[status] ?? status;
}

// Display-only countdown helper (e.g. "closes in 3h"). NEVER used to
// decide TEXT vs TEMPLATE mode — that decision uses only the
// server-derived conversation.serviceWindowOpen field (WAI-004), which
// is computed from the Node server's own clock, not the browser's.
export function serviceWindowState(endsAt: string | null, now = Date.now()) {
  return endsAt && new Date(endsAt).getTime() > now ? "OPEN" : "CLOSED";
}

// WAI-006: chat timestamps are meant to read in the viewing staff
// member's own local time (the same convention WhatsApp itself uses),
// never a fixed business timezone — there is no per-viewer timezone
// column to pass server-side anyway. But `Intl.DateTimeFormat(undefined,
// ...)` resolves its "default locale" independently on each side: the
// Node server's own ICU/OS locale during SSR vs. the browser's locale
// during hydration. Those two frequently disagree (e.g. server on
// en-US, browser on en-NG/en-GB), producing two different date strings
// for the identical instant and a full React hydration-mismatch error
// on first paint. A fixed, explicit locale keeps the server-rendered
// HTML and React's first client render byte-for-byte identical (no
// mismatch is possible), and <ClientLocalTime> below then swaps to the
// real browser-local rendering after hydration, once React is no
// longer comparing against server output.
const TIME_FORMAT_LOCALE = "en-US";
function formatTimeWithLocale(value: string | null, locale: string | undefined) {
  return value
    ? new Intl.DateTimeFormat(locale, { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" }).format(new Date(value))
    : "No messages";
}
function formatTime(value: string | null) { return formatTimeWithLocale(value, TIME_FORMAT_LOCALE); }

// Renders formatTime's fixed-locale text on both the server and React's
// first client pass (so hydration never mismatches), then swaps to the
// viewer's real browser-local formatting by writing directly to the DOM
// node in an effect — which by definition only ever runs client-side,
// after hydration has already completed. A ref-based DOM write (not
// setState) is used deliberately: this is a one-way sync FROM the
// browser's own Intl default INTO this already-hydrated node, not a
// value React needs to track or re-render from, so there is nothing to
// hold in React state and no cascading re-render to trigger.
function ClientLocalTime({ value, className }: { value: string | null; className?: string }) {
  const ref = useRef<HTMLTimeElement>(null);
  useEffect(() => {
    if (ref.current) ref.current.textContent = formatTimeWithLocale(value, undefined);
  }, [value]);
  return <time ref={ref} className={className}>{formatTime(value)}</time>;
}

// WAI-003: the frozen backend's raw failure_reason (provider/webhook/SQL
// diagnostic text) is never part of this browser-safe read model at all
// (see lib/whatsapp/dal.ts). Every FAILED message renders this one
// fixed, safe label instead.
export const SAFE_FAILED_MESSAGE_LABEL = "Message could not be delivered.";

// The exact literal text the frozen sendWhatsAppMessageAction
// (lib/whatsapp/actions.ts) returns for BOTH of its ambiguous-outcome
// paths: a fresh send that hit a retryable/timeout provider failure, and
// a same-key replay that finds neither a bound provider id nor a
// pending repair. This UI recognizes that existing safe text verbatim —
// it never edits the frozen action to add a new discriminant field.
export const AMBIGUOUS_SEND_ERROR_TEXT =
  "WhatsApp did not confirm this message. Please check its status before resending.";

export function isAmbiguousSendResult(state: WhatsAppSendActionState): boolean {
  if (!state) return false;
  if (state.pendingReconciliation === true) return true;
  return state.error === AMBIGUOUS_SEND_ERROR_TEXT;
}

function MessageStatus({ status }: { status: string }) {
  if (status === "READ") return <span className="inline-flex items-center gap-1 text-xs text-primary"><CheckCheck className="size-3.5" aria-hidden="true" />Read</span>;
  if (status === "DELIVERED" || status === "SENT") return <span className="inline-flex items-center gap-1 text-xs text-muted-foreground"><CheckCheck className="size-3.5" aria-hidden="true" />{whatsappMessageStatusLabel(status)}</span>;
  if (status === "ACCEPTED") return <span className="inline-flex items-center gap-1 text-xs text-muted-foreground"><Check className="size-3.5" aria-hidden="true" />Accepted</span>;
  return <span className={status === "FAILED" ? "text-xs text-destructive" : "text-xs text-muted-foreground"}>{whatsappMessageStatusLabel(status)}</span>;
}

function ConversationRow({ businessId, conversation, active }: { businessId: string; conversation: WhatsappInboxConversationRow; active: boolean }) {
  const preview = conversation.lastMessage?.bodyText || (conversation.lastMessage ? `${conversation.lastMessage.messageType} message` : "No messages yet");
  return <Link href={`/${businessId}/whatsapp?conversation=${encodeURIComponent(conversation.id)}`} aria-current={active ? "page" : undefined} className={`flex min-h-20 items-center gap-3 px-4 py-3 outline-none transition-colors hover:bg-muted/60 focus-visible:bg-muted focus-visible:ring-2 focus-visible:ring-ring ${active ? "bg-muted" : ""}`}><span className="flex size-10 shrink-0 items-center justify-center rounded-full bg-primary/10 text-primary" aria-hidden="true">{conversation.customerName?.slice(0, 1).toUpperCase() ?? "?"}</span><span className="min-w-0 flex-1"><span className="flex items-center justify-between gap-2"><span className="truncate font-medium">{conversation.customerName ?? conversation.customerPhoneE164}</span><ClientLocalTime className="shrink-0 text-xs text-muted-foreground" value={conversation.lastMessageAt} /></span><span className="mt-1 flex items-center gap-2"><span className="truncate text-sm text-muted-foreground">{preview}</span>{!conversation.customerId ? <Badge variant="outline">Unmatched</Badge> : null}</span></span></Link>;
}

function Composer({ businessId, conversation, templates, canSend }: { businessId: string; conversation: WhatsappInboxConversationRow; templates: WhatsappSendableTemplateRow[]; canSend: boolean }) {
  const router = useRouter();
  const [state, formAction, pending] = useActionState(sendWhatsAppMessageAction, undefined);

  // WAI-001: one clientCreationKey per logical send attempt. Composer is
  // remounted with key={conversation.id} by Thread below, so this ref is
  // freshly minted once per conversation and then reused for every
  // resubmission of the SAME logical message — never regenerated merely
  // because the user pressed Send again. It only rotates after this
  // attempt reaches a definitive success (see the effect below), which
  // resets the draft for the NEXT logical message.
  const keyRef = useRef<string>(crypto.randomUUID());
  const formRef = useRef<HTMLFormElement>(null);

  // Synchronous, ref-based double-submit guard. It is read and written
  // inside the native `submit` event handler itself, before React state
  // (e.g. `pending`) has any chance to re-render. Two submit events
  // dispatched back to back (double-click, double Enter) are still
  // handled one at a time by the browser's event loop, so the second
  // always observes the first's synchronous write and is dropped before
  // it can reach formAction — at most one action invocation per attempt.
  const submitLockRef = useRef(false);

  // Sticky once true: an ambiguous provider outcome permanently locks
  // this logical draft against resend for the lifetime of this composer
  // instance. There is no safe automatic unlock signal available from
  // the frozen action — only a definitive success (new key + reset) or
  // switching away from this conversation (remount) starts a new
  // logical attempt.
  //
  // Derived directly during render (React's own "adjusting state when a
  // prop changes" pattern — see react.dev/learn/you-might-not-need-an-effect)
  // rather than in a useEffect: useActionState hands back a new `state`
  // object per dispatch, so comparing it against the last one this
  // render pass has already reacted to lets this branch run exactly once
  // per outcome, without the extra render/lint cascade of calling
  // setState from inside an effect.
  const [ambiguousLocked, setAmbiguousLocked] = useState(false);
  const [lastHandledState, setLastHandledState] = useState(state);
  if (state !== lastHandledState) {
    setLastHandledState(state);
    if (state?.success) setAmbiguousLocked(false);
    else if (isAmbiguousSendResult(state)) setAmbiguousLocked(true);
  }

  // Every genuinely imperative side effect (resetting the DOM form,
  // rotating the idempotency key, asking Next.js to refetch) stays in an
  // effect, since these must never run during React's render phase.
  useEffect(() => {
    if (!state) return;

    if (state.success) {
      formRef.current?.reset();
      keyRef.current = crypto.randomUUID();
      submitLockRef.current = false;
      router.refresh();
      return;
    }

    if (isAmbiguousSendResult(state)) return;

    // Definitive outcome: validation error, permission error, template
    // rejection, or a definitive provider rejection. Not locked — the
    // user may edit and resubmit this SAME logical attempt, so the key
    // is intentionally left unchanged (a new key is only minted after a
    // genuine success, above).
    submitLockRef.current = false;

    if (state.error?.includes("service window is closed")) {
      // The eligibility this page loaded with is now stale. The frozen
      // backend's rejection is authoritative either way — refresh so
      // the next render reflects the server's current trusted window
      // state instead of the one this page happened to load with.
      router.refresh();
    }
  }, [state, router]);

  const windowOpen = conversation.serviceWindowOpen === true;
  const hasConsent = conversation.serviceMessagesAllowed === true;
  const blockedReason = !canSend
    ? "You don’t have permission to send WhatsApp messages."
    : !conversation.customerId
      ? "Match this phone number to a customer before sending."
      : !hasConsent
        ? "This customer has not consented to WhatsApp service messages."
        : null;

  const locked = ambiguousLocked || state?.pendingReconciliation === true;
  const disabled = Boolean(blockedReason) || pending || locked;

  function handleSubmit(event: React.FormEvent<HTMLFormElement>) {
    if (submitLockRef.current || pending || locked) {
      event.preventDefault();
      return;
    }
    submitLockRef.current = true;
    const keyInput = event.currentTarget.elements.namedItem("clientCreationKey");
    if (keyInput instanceof HTMLInputElement) keyInput.value = keyRef.current;
  }

  function handleTextareaKeyDown(event: KeyboardEvent<HTMLTextAreaElement>) {
    if (event.key === "Enter" && !event.shiftKey) {
      event.preventDefault();
      if (!disabled) formRef.current?.requestSubmit();
    }
  }

  return (
    <form
      ref={formRef}
      action={formAction}
      onSubmit={handleSubmit}
      className="border-t bg-background p-4"
      aria-label="Send WhatsApp message"
    >
      <input type="hidden" name="businessId" value={businessId} />
      <input type="hidden" name="conversationId" value={conversation.id} />
      <input type="hidden" name="messageType" value={windowOpen ? "TEXT" : "TEMPLATE"} />
      <input type="hidden" name="clientCreationKey" value="" />
      <div className="mb-3 flex flex-wrap items-center gap-2">
        <Badge variant={hasConsent ? "secondary" : "destructive"}>Service consent: {hasConsent ? "confirmed" : "required"}</Badge>
        <Badge variant={windowOpen ? "secondary" : "outline"}>24-hour window: {windowOpen ? "open" : "closed"}</Badge>
      </div>
      {locked ? (
        <Alert className="mb-3" role="status">
          <ShieldAlert aria-hidden="true" />
          <AlertTitle>Reconciliation pending</AlertTitle>
          <AlertDescription>BusinessOS is confirming this message with WhatsApp. Do not resend yet.</AlertDescription>
        </Alert>
      ) : state?.error ? (
        <Alert variant="destructive" className="mb-3" role="alert">
          <ShieldAlert aria-hidden="true" />
          <AlertTitle>Message not sent</AlertTitle>
          <AlertDescription>{state.error}</AlertDescription>
        </Alert>
      ) : null}
      {blockedReason ? <Alert className="mb-3"><AlertDescription>{blockedReason}</AlertDescription></Alert> : null}
      {windowOpen ? (
        <Textarea
          name="bodyText"
          required
          maxLength={4096}
          placeholder="Write a service reply…"
          aria-label="Message text"
          disabled={disabled}
          onKeyDown={handleTextareaKeyDown}
        />
      ) : (
        <div className="grid gap-2">
          <label htmlFor="whatsapp-template" className="text-sm font-medium">Approved template required</label>
          <select
            id="whatsapp-template"
            name="templateId"
            required
            disabled={disabled || templates.length === 0}
            className="h-10 rounded-md border bg-background px-3 text-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
          >
            <option value="">Select an approved template</option>
            {templates.map((template) => (
              <option key={template.id} value={template.id}>{template.name} · {template.language}</option>
            ))}
          </select>
          {templates.length === 0 ? <p className="text-sm text-muted-foreground">No approved template is available for this business.</p> : null}
        </div>
      )}
      <div className="mt-3 flex items-center justify-between gap-3">
        <p className="text-xs text-muted-foreground">
          {windowOpen ? "Text messages are allowed while the service window is open." : "Templates are checked again on the server before sending."}
        </p>
        <Button type="submit" disabled={disabled || (!windowOpen && templates.length === 0)}>
          <Send aria-hidden="true" />
          {pending ? "Sending…" : windowOpen ? "Send message" : "Send template"}
        </Button>
      </div>
    </form>
  );
}

function Thread({ businessId, conversation, messages, templates, canSend }: { businessId: string; conversation: WhatsappInboxConversationRow; messages: WhatsappInboxMessageRow[]; templates: WhatsappSendableTemplateRow[]; canSend: boolean }) {
  return <section className="flex min-h-[34rem] flex-col rounded-xl border bg-card" aria-label="Conversation"><header className="flex min-h-16 items-center gap-3 border-b px-4"><Link href={`/${businessId}/whatsapp`} className="lg:hidden"><Button variant="ghost" size="icon" aria-label="Back to conversations"><ArrowLeft /></Button></Link><span className="flex size-9 items-center justify-center rounded-full bg-primary/10 text-primary" aria-hidden="true">{conversation.customerName?.slice(0, 1).toUpperCase() ?? "?"}</span><div className="min-w-0"><h2 className="truncate font-semibold">{conversation.customerName ?? conversation.customerPhoneE164}</h2><p className="text-sm text-muted-foreground">{conversation.customerId ? conversation.customerPhoneE164 : "Unmatched phone number"}</p></div></header><div className="flex-1 space-y-3 overflow-y-auto bg-muted/20 p-4">{messages.length === 0 ? <div className="flex h-full min-h-52 flex-col items-center justify-center text-center"><MessageCircle className="mb-3 size-8 text-muted-foreground" aria-hidden="true" /><p className="font-medium">No messages in this conversation</p><p className="text-sm text-muted-foreground">New provider messages will appear here after they are processed.</p></div> : messages.map((message) => <article key={message.id} className={`flex ${message.direction === "OUTBOUND" ? "justify-end" : "justify-start"}`}><div className={`max-w-[85%] rounded-xl px-3 py-2 text-sm ${message.direction === "OUTBOUND" ? "bg-primary text-primary-foreground" : "border bg-background"}`}><p className="whitespace-pre-wrap break-words">{message.bodyText || `${message.messageType} message`}</p><div className={`mt-1 flex items-center justify-end gap-2 ${message.direction === "OUTBOUND" ? "text-primary-foreground/75" : "text-muted-foreground"}`}><ClientLocalTime className="text-xs" value={message.createdAt} />{message.direction === "OUTBOUND" ? <MessageStatus status={message.status} /> : null}</div>{message.status === "FAILED" ? <p className="mt-1 text-xs text-destructive">{SAFE_FAILED_MESSAGE_LABEL}</p> : null}</div></article>)}</div><Composer key={conversation.id} businessId={businessId} conversation={conversation} templates={templates} canSend={canSend} /></section>;
}

export function WhatsappInbox({ businessId, conversations, activeConversation, messages, templates, canSend }: { businessId: string; conversations: WhatsappInboxConversationRow[]; activeConversation: WhatsappInboxConversationRow | null; messages: WhatsappInboxMessageRow[]; templates: WhatsappSendableTemplateRow[]; canSend: boolean }) {
  const [search, setSearch] = useState(""); const [filter, setFilter] = useState<"ALL" | "MATCHED" | "UNMATCHED">("ALL");
  const visible = useMemo(() => conversations.filter((conversation) => (filter === "ALL" || (filter === "MATCHED" ? Boolean(conversation.customerId) : !conversation.customerId)) && `${conversation.customerName ?? ""} ${conversation.customerPhoneE164}`.toLocaleLowerCase().includes(search.toLocaleLowerCase())), [conversations, filter, search]);
  return <div className="flex flex-col gap-6"><div><h1 className="text-2xl font-semibold tracking-tight">WhatsApp inbox</h1><p className="text-sm text-muted-foreground">Customer service conversations for this business.</p></div><div className="grid min-h-[34rem] grid-cols-1 overflow-hidden rounded-xl border bg-card lg:grid-cols-[20rem_minmax(0,1fr)]"><aside className={activeConversation ? "hidden border-r lg:block" : "border-r"} aria-label="Conversations"><div className="border-b p-3"><label className="relative block"><Search className="pointer-events-none absolute top-2.5 left-3 size-4 text-muted-foreground" aria-hidden="true" /><span className="sr-only">Search conversations</span><input value={search} onChange={(event) => setSearch(event.target.value)} placeholder="Search name or phone" className="h-9 w-full rounded-md border bg-background pr-3 pl-9 text-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring" /></label><div className="mt-2 flex gap-1" role="group" aria-label="Conversation filter">{(["ALL", "MATCHED", "UNMATCHED"] as const).map((value) => <Button key={value} type="button" size="sm" variant={filter === value ? "secondary" : "ghost"} aria-pressed={filter === value} onClick={() => setFilter(value)}>{value[0] + value.slice(1).toLowerCase()}</Button>)}</div></div><div className="divide-y overflow-y-auto">{visible.length === 0 ? <p className="p-4 text-sm text-muted-foreground">{conversations.length === 0 ? "No WhatsApp conversations yet." : "No conversations match this filter."}</p> : visible.map((conversation) => <ConversationRow key={conversation.id} businessId={businessId} conversation={conversation} active={conversation.id === activeConversation?.id} />)}</div></aside>{activeConversation ? <Thread businessId={businessId} conversation={activeConversation} messages={messages} templates={templates} canSend={canSend} /> : <section className="hidden min-h-[34rem] flex-col items-center justify-center text-center lg:flex"><MessageCircle className="mb-3 size-9 text-muted-foreground" aria-hidden="true" /><h2 className="font-semibold">Choose a conversation</h2><p className="text-sm text-muted-foreground">Select a customer conversation to view its messages.</p></section>}</div></div>;
}
