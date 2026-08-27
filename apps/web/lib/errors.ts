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
  if (error.code === "42501" || message.includes("insufficient_privilege")) {
    return PERMISSION_DENIED_ERROR;
  }

  return GENERIC_ERROR;
}
