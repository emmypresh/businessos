/**
 * Maps a controlled database error (a `raise exception` string this
 * app's own RPCs are documented to produce — cross-checked against the
 * committed migrations, never guessed) into a safe, user-facing message.
 * Raw Postgres detail (constraint names, SQL states beyond the mapped
 * `code`, DETAIL/HINT text) is never interpolated into what's returned.
 *
 * Every Server Action in lib/products/actions.ts and
 * lib/inventory/actions.ts routes its RPC/query errors through this
 * function — it is the ONLY place a Postgres error's raw `message` is
 * ever read.
 */

export type MappedError = {
  message: string;
  field?: string;
};

type DatabaseErrorLike = {
  message?: string | null;
  code?: string | null;
};

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

export function mapDatabaseError(error: DatabaseErrorLike | null | undefined): MappedError {
  if (!error) return GENERIC_ERROR;

  const message = error.message ?? "";

  // Order matters: PRODUCT_IDEMPOTENCY_KEY_REUSED must be checked before
  // the bare IDEMPOTENCY_KEY_REUSED substring, since the former contains
  // the latter as a substring.
  if (message.includes("PRODUCT_IDEMPOTENCY_KEY_REUSED")) {
    return {
      message:
        "This product may already have been created with different details. Check the product list before retrying.",
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
    return { message: "Not enough stock available for this adjustment.", field: "quantity" };
  }
  if (message.includes("PRODUCT_ARCHIVED")) {
    return { message: "This product is archived and can no longer be adjusted." };
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
  if (error.code === "42501" || message.includes("insufficient_privilege")) {
    return PERMISSION_DENIED_ERROR;
  }

  return GENERIC_ERROR;
}
