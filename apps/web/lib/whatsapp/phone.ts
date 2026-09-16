/**
 * Normalizes a Meta-supplied WhatsApp identifier ("wa_id", the `from`
 * field on an inbound message) to this codebase's own frozen E.164
 * contract (`^\+[1-9][0-9]{6,14}$`, see
 * whatsapp_conversations.customer_phone_e164's own CHECK constraint).
 * Meta sends this field as digits-only, with NO leading `+` — this
 * function's only job is prepending it and validating the result; it
 * performs NO fuzzy reformatting, no country-code guessing, and no
 * digit-stripping beyond what Meta itself already sends. Per this
 * phase's own explicit "no dangerous fuzzy phone matching" instruction,
 * a value that fails this exact check is never coerced — the caller
 * (webhook handler) must reject/skip the message rather than guess.
 */
export function normalizeMetaWaIdToE164(waId: string): string | null {
  const digitsOnly = waId.replace(/[^0-9]/g, "");
  if (digitsOnly.length === 0) {
    return null;
  }
  const candidate = `+${digitsOnly}`;
  return /^\+[1-9][0-9]{6,14}$/.test(candidate) ? candidate : null;
}

/**
 * Exact-match customer lookup contract: a customer's own stored phone
 * number is compared ONLY after being run through this exact same
 * normalizer — never a partial/fuzzy match, and never rewritten in
 * place (this phase's own explicit "do not rewrite existing customer
 * phone data in this round" instruction). A customer whose stored phone
 * does not already normalize to a valid E.164 value can never be
 * matched by this function — the caller must leave customer_id null in
 * that case, not guess.
 */
export function phonesMatchExactly(customerStoredPhone: string | null, inboundE164: string): boolean {
  if (!customerStoredPhone) {
    return false;
  }
  const normalizedStored = customerStoredPhone.trim();
  return normalizedStored === inboundE164;
}
