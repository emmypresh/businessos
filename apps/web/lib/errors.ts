/**
 * Maps a controlled database error (a `raise exception` string this
 * app's own RPCs are documented to produce — cross-checked against the
 * committed migrations, never guessed) into a safe, user-facing message.
 * Raw Postgres detail (constraint names, SQL states beyond the mapped
 * `code`, DETAIL/HINT text) is never interpolated into what's returned.
 *
 * Every Server Action in lib/products/actions.ts, lib/inventory/actions.ts,
 * lib/customers/actions.ts, and lib/sales/actions.ts routes its RPC/query
 * errors through this function — it is the ONLY place a Postgres error's
 * raw `message` is ever read.
 */

export type MappedError = {
  message: string;
  field?: string;
};

type DatabaseErrorLike = {
  message?: string | null;
  code?: string | null;
};

// Some error codes are shared between an inventory-adjustment context and
// a sale context but need different wording ("this adjustment" vs. "this
// sale"). An optional context narrows the message without duplicating
// the whole function — every existing call site (products/inventory
// actions) omits it and gets byte-identical behavior to before.
type ErrorContext = "sale";

const GENERIC_ERROR: MappedError = {
  message: "Something went wrong. Please try again.",
};

const PERMISSION_DENIED_ERROR: MappedError = {
  message: "You don't have permission to do this.",
};

/**
 * Converts a MappedError into the shape every Server Action in this app
 * already returns (`lib/auth/actions.ts`'s `ActionState`) — a single
 * `error` string plus, when the mapping named a specific field, a
 * matching `fieldErrors` entry so the form can highlight it exactly like
 * a Zod validation failure does.
 */
export function toActionState(mapped: MappedError): {
  error?: string;
  fieldErrors?: Record<string, string[]>;
} {
  // When the mapping named a specific field, the message renders once,
  // inline next to that field — exactly like a Zod validation failure
  // already does elsewhere in this app. It does NOT also populate the
  // top-level `error` (which every form additionally renders as a
  // page-level Alert): showing the identical sentence in both places at
  // once reads as a UI bug, not two independent pieces of information.
  if (mapped.field) {
    return { fieldErrors: { [mapped.field]: [mapped.message] } };
  }
  return { error: mapped.message };
}

export function mapDatabaseError(
  error: DatabaseErrorLike | null | undefined,
  context?: ErrorContext
): MappedError {
  if (!error) return GENERIC_ERROR;

  const message = error.message ?? "";

  // Order matters throughout: any error code that is itself a SUBSTRING
  // of another (e.g. every "*_IDEMPOTENCY_KEY_REUSED" variant contains
  // the bare "IDEMPOTENCY_KEY_REUSED") must be checked before the
  // shorter/generic one it contains.
  if (message.includes("PRODUCT_IDEMPOTENCY_KEY_REUSED")) {
    return {
      message:
        "This product may already have been created with different details. Check the product list before retrying.",
    };
  }
  if (message.includes("CUSTOMER_IDEMPOTENCY_KEY_REUSED")) {
    return {
      message:
        "This customer may already have been created with different details. Check the customer list before retrying.",
    };
  }
  if (message.includes("SALE_IDEMPOTENCY_KEY_REUSED")) {
    return {
      message: "This sale may already have been recorded with different details. Check the sales list before retrying.",
    };
  }
  // Codex adversarial review catch: this MUST be checked before the bare
  // "IDEMPOTENCY_KEY_REUSED" fallback immediately below — that generic
  // check would otherwise match first (its substring is contained in
  // this code too) and silently swallow every EXPENSE_IDEMPOTENCY_KEY_REUSED
  // error into the wrong ("adjustment") message. This was previously
  // dead code, ordered after that fallback; a unit test now pins the
  // ordering (lib/errors.test.ts).
  if (message.includes("EXPENSE_IDEMPOTENCY_KEY_REUSED")) {
    return {
      message:
        "This expense may already have been recorded with different details. Check the expense list before retrying.",
    };
  }
  // Phase 1F — same "superstring before the generic fallback" rule as
  // EXPENSE_IDEMPOTENCY_KEY_REUSED immediately above (this file's own
  // unit test caught this being placed AFTER the fallback the first time
  // it was written, reproducing the exact dead-code bug that comment
  // documents — moved here to fix it).
  if (message.includes("BRANCH_IDEMPOTENCY_KEY_REUSED")) {
    return {
      message:
        "This branch may already have been created with different details. Check the branch list before retrying.",
    };
  }
  if (message.includes("INVITATION_IDEMPOTENCY_KEY_REUSED")) {
    return {
      message:
        "This invitation may already have been sent with different details. Check the invitation list before retrying.",
    };
  }
  if (message.includes("IDEMPOTENCY_KEY_REUSED")) {
    return {
      message:
        "This adjustment may already have been recorded with different details. Check the inventory history before retrying.",
    };
  }
  if (message.includes("SKU_UNAVAILABLE")) {
    return { message: "This SKU is already in use.", field: "sku" };
  }
  if (message.includes("BARCODE_UNAVAILABLE")) {
    return { message: "This barcode is already in use.", field: "barcode" };
  }
  if (message.includes("CANNOT_ARCHIVE_WITH_STOCK")) {
    return {
      message: "This product still has stock recorded. Adjust stock to zero before archiving.",
    };
  }
  if (message.includes("INSUFFICIENT_STOCK")) {
    if (context === "sale") {
      // Multi-line sales don't map cleanly to one form field — which
      // line failed is surfaced in the message, not a fieldErrors slot.
      return { message: "Not enough stock available for one or more items in this sale." };
    }
    return { message: "Not enough stock available for this adjustment.", field: "quantity" };
  }
  if (message.includes("PRODUCT_ARCHIVED")) {
    return {
      message:
        context === "sale"
          ? "This product is archived and can no longer be sold."
          : "This product is archived and can no longer be adjusted.",
    };
  }
  if (message.includes("PRODUCT_NOT_TRACKED")) {
    return { message: "This product does not track inventory." };
  }
  if (message.includes("LOCATION_ARCHIVED") || message.includes("LOCATION_NOT_FOUND")) {
    // Deliberately the same generic message for "archived" and "not
    // found" — a foreign/nonexistent location must not be
    // distinguishable from one that exists but is inactive, matching the
    // database layer's own non-disclosure posture for foreign/nonexistent
    // resources.
    return { message: "This inventory location is not available." };
  }
  if (message.includes("PRODUCT_NOT_FOUND")) {
    // Same non-disclosure reasoning: a forged/foreign product_id and a
    // genuinely nonexistent one both surface identically.
    return { message: "This product is not available." };
  }
  if (message.includes("NO_DEFAULT_LOCATION")) {
    return { message: "No inventory location is configured for this business yet." };
  }
  if (message.includes("CUSTOMER_NOT_FOUND")) {
    // Same non-disclosure reasoning as PRODUCT_NOT_FOUND: a forged/
    // foreign customer_id and a genuinely nonexistent one are
    // indistinguishable to the caller.
    return { message: "This customer is not available.", field: "customerId" };
  }
  if (message.includes("CUSTOMER_ARCHIVED")) {
    return { message: "This customer is archived.", field: "customerId" };
  }
  if (message.includes("INVALID_CUSTOMER_NAME")) {
    return { message: "Enter a valid name (2–200 characters).", field: "name" };
  }
  if (message.includes("INVALID_CUSTOMER_PHONE")) {
    return { message: "Enter a valid phone number.", field: "phone" };
  }
  if (message.includes("INVALID_CUSTOMER_EMAIL")) {
    return { message: "Enter a valid email address.", field: "email" };
  }
  if (message.includes("INVALID_CUSTOMER_ADDRESS")) {
    return { message: "Address is too long.", field: "address" };
  }
  if (message.includes("INVALID_CUSTOMER_NOTES")) {
    return { message: "Notes are too long.", field: "notes" };
  }
  if (message.includes("DUPLICATE_PRODUCT_LINE")) {
    return {
      message: "Each product can only appear once — combine the quantity into one line instead.",
      field: "items",
    };
  }
  if (message.includes("TOO_MANY_SALE_ITEMS")) {
    return { message: "This sale has too many product lines.", field: "items" };
  }
  if (message.includes("MALFORMED_SALE_ITEMS")) {
    return {
      message: "One or more items in this sale are invalid. Check quantities (up to 3 decimal places) and try again.",
      field: "items",
    };
  }
  if (message.includes("SALE_AMOUNT_OUT_OF_RANGE")) {
    return { message: "One of the amounts in this sale is too large." };
  }
  if (message.includes("INVALID_DISCOUNT")) {
    return { message: "Discount cannot exceed the subtotal.", field: "discount" };
  }
  if (message.includes("INVALID_PAYMENT_AMOUNT")) {
    return {
      message: "The amount paid doesn't match the payment status you selected.",
      field: "amountPaid",
    };
  }

  // Phase 1E — expenses + financial reporting. Codes verified against the
  // exact `raise exception` strings in
  // supabase/migrations/20260827080300_create_expense_creation_requests_and_rpc.sql,
  // supabase/migrations/20260827080400_void_expense_rpc.sql, and
  // supabase/migrations/20260827080600_get_financial_summary_rpc.sql — not
  // guessed. void_expense's reason error is INVALID_VOID_REASON (no
  // "EXPENSE_" prefix), exactly as committed; nothing here invents a
  // differently-named code for it. EXPENSE_IDEMPOTENCY_KEY_REUSED is
  // handled earlier, alongside the other *_IDEMPOTENCY_KEY_REUSED checks
  // (ordering matters — see that block's own comment).
  if (message.includes("INVALID_EXPENSE_AMOUNT")) {
    return { message: "Enter an amount with up to 2 decimal places, greater than zero.", field: "amount" };
  }
  if (message.includes("EXPENSE_AMOUNT_OUT_OF_RANGE")) {
    return { message: "This amount is too large.", field: "amount" };
  }
  if (message.includes("INVALID_EXPENSE_PAYMENT_METHOD")) {
    return { message: "Choose a valid payment method.", field: "paymentMethod" };
  }
  if (message.includes("INVALID_EXPENSE_DATE")) {
    return { message: "Enter a valid date — it cannot be in the future.", field: "incurredAt" };
  }
  if (message.includes("INVALID_EXPENSE_PAYEE")) {
    return { message: "Payee is too long.", field: "payee" };
  }
  if (message.includes("INVALID_EXPENSE_REFERENCE")) {
    return { message: "Reference is too long.", field: "reference" };
  }
  if (message.includes("INVALID_EXPENSE_NOTES")) {
    return { message: "Notes are too long.", field: "notes" };
  }
  if (message.includes("EXPENSE_CATEGORY_ARCHIVED")) {
    return {
      message: "This category is archived and can no longer be used for new expenses.",
      field: "categoryId",
    };
  }
  if (message.includes("EXPENSE_CATEGORY_NOT_FOUND")) {
    // Same non-disclosure reasoning as PRODUCT_NOT_FOUND: a forged/
    // foreign category_id and a genuinely nonexistent one are
    // indistinguishable to the caller.
    return { message: "This category is not available.", field: "categoryId" };
  }
  if (message.includes("EXPENSE_ALREADY_VOIDED")) {
    return { message: "This expense has already been voided." };
  }
  if (message.includes("EXPENSE_NOT_FOUND")) {
    // Same non-disclosure reasoning: nonexistent and foreign-tenant
    // expense ids surface identically.
    return { message: "This expense is not available." };
  }
  if (message.includes("INVALID_VOID_REASON")) {
    return { message: "Enter a reason for voiding this expense.", field: "reason" };
  }
  if (message.includes("expense_categories_name_unique_idx")) {
    // Business-scoped, case/whitespace-normalized unique index — spans
    // both ACTIVE and ARCHIVED (archiving never frees a name for reuse),
    // matching that index's own comment in create_expense_categories.sql.
    return { message: "A category with this name already exists.", field: "name" };
  }
  if (message.includes("INVALID_REPORT_RANGE")) {
    return { message: "The selected date range is invalid.", field: "dateTo" };
  }
  if (message.includes("REPORT_AMOUNT_OUT_OF_RANGE")) {
    return { message: "One of the amounts in this report is too large." };
  }

  // Phase 1F — branches + staff. Codes verified against the exact `raise
  // exception` strings in
  // supabase/migrations/20260828080000_create_business_branches.sql,
  // supabase/migrations/20260828080300_business_branch_rpcs.sql,
  // supabase/migrations/20260828080500_member_management_rpcs.sql, and
  // supabase/migrations/20260828080700_business_invitation_rpcs.sql — not
  // guessed. BRANCH_IDEMPOTENCY_KEY_REUSED/INVITATION_IDEMPOTENCY_KEY_REUSED
  // are handled earlier, alongside the other *_IDEMPOTENCY_KEY_REUSED
  // checks (ordering matters there — see that block's own comment).
  // DEFAULT_BRANCH_CANNOT_BE_DEACTIVATED is checked before the bare
  // BRANCH_NOT_ACTIVE/BRANCH_NOT_FOUND fallbacks it never actually
  // overlaps with, purely to keep the branch-error block together.
  if (message.includes("INVALID_BRANCH_NAME")) {
    return { message: "Enter a branch name (2–100 characters).", field: "name" };
  }
  if (message.includes("INVALID_BRANCH_CODE")) {
    return { message: "Enter a valid code (up to 20 characters, no spaces).", field: "code" };
  }
  if (message.includes("INVALID_BRANCH_ADDRESS")) {
    return { message: "Address is too long.", field: "addressLine1" };
  }
  if (message.includes("INVALID_BRANCH_COUNTRY_CODE")) {
    return { message: "Enter a valid 2-letter country code.", field: "countryCode" };
  }
  if (message.includes("INVALID_BRANCH_PHONE")) {
    return { message: "Enter a valid phone number.", field: "phone" };
  }
  if (message.includes("BRANCH_NAME_ALREADY_EXISTS")) {
    return { message: "A branch with this name already exists.", field: "name" };
  }
  if (message.includes("BRANCH_CODE_ALREADY_EXISTS")) {
    return { message: "A branch with this code already exists.", field: "code" };
  }
  if (message.includes("DEFAULT_BRANCH_CANNOT_BE_DEACTIVATED")) {
    return { message: "This is the default branch. Set another active branch as default first." };
  }
  if (message.includes("BRANCH_NOT_ACTIVE")) {
    return { message: "That branch is not currently active." };
  }
  if (message.includes("BRANCH_NOT_FOUND")) {
    // Same non-disclosure reasoning as PRODUCT_NOT_FOUND: a forged/
    // foreign branch id and a genuinely nonexistent one are
    // indistinguishable to the caller.
    return { message: "This branch is not available." };
  }
  if (message.includes("INVALID_BRANCH_ASSIGNMENT")) {
    return { message: "Select at least one branch and choose exactly one as primary." };
  }
  if (message.includes("CANNOT_MANAGE_SELF")) {
    return { message: "You can't perform this action on your own account." };
  }
  if (message.includes("CANNOT_MANAGE_OWNER")) {
    return { message: "You don't have permission to manage an owner's account." };
  }
  if (message.includes("CANNOT_ASSIGN_OWNER_ROLE")) {
    return { message: "Only an owner can assign the owner role.", field: "role" };
  }
  if (message.includes("LAST_OWNER_REQUIRED")) {
    return { message: "A business must always have at least one active owner." };
  }
  if (message.includes("MEMBER_NOT_FOUND")) {
    return { message: "This staff member is not available." };
  }
  // Codex adversarial review, application-layer round 2, Low 5: verified
  // against the exact `raise exception` strings in
  // supabase/migrations/20260828080500_member_management_rpcs.sql
  // (suspend_member's own MEMBER_ALREADY_SUSPENDED,
  // reactivate_member's own MEMBER_NOT_SUSPENDED) — previously unmapped,
  // so both fell through to the generic fallback message instead of a
  // specific, accurate one.
  if (message.includes("MEMBER_ALREADY_SUSPENDED")) {
    return { message: "This staff member is already suspended." };
  }
  if (message.includes("MEMBER_NOT_SUSPENDED")) {
    return { message: "This staff member is already active." };
  }
  if (message.includes("INVALID_ROLE")) {
    return { message: "Choose a valid role.", field: "role" };
  }
  if (message.includes("INVALID_INVITATION_EMAIL")) {
    return { message: "Enter a valid email address.", field: "email" };
  }
  if (message.includes("INVITATION_ALREADY_PENDING")) {
    return { message: "There's already a pending invitation for this email.", field: "email" };
  }
  if (message.includes("INVITATION_ALREADY_ACCEPTED")) {
    return { message: "This invitation has already been accepted." };
  }
  if (message.includes("INVITATION_REVOKED")) {
    return { message: "This invitation has been revoked." };
  }
  if (message.includes("INVITATION_EXPIRED")) {
    return { message: "This invitation has expired." };
  }
  if (message.includes("ALREADY_BUSINESS_MEMBER")) {
    return { message: "You're already a member of this business." };
  }
  if (message.includes("INVITATION_NOT_FOUND")) {
    // Deliberately the SAME generic message for "nonexistent" and "not
    // addressed to you" — matching accept_business_invitation's own
    // non-disclosure contract exactly (see that RPC's own header
    // comment): the wrong-email/nonexistent cases must remain
    // indistinguishable at every layer, including this one.
    return { message: "This invitation link isn't valid. It may have expired or already been used." };
  }

  if (error.code === "42501" || message.includes("insufficient_privilege")) {
    return PERMISSION_DENIED_ERROR;
  }

  return GENERIC_ERROR;
}
