/**
 * Opaque keyset-pagination cursor: `(created_at, id)`, both DESC —
 * deterministic even under concurrent inserts (unlike offset pagination,
 * which can skip or duplicate rows when new rows land between page
 * requests). Used by every paginated list in the products/inventory
 * domain (products, inventory overview, inventory history) so all three
 * share one cursor encoding.
 */

export type Cursor = { createdAt: string; id: string };

export function encodeCursor(cursor: Cursor): string {
  return Buffer.from(JSON.stringify(cursor)).toString("base64url");
}

export function decodeCursor(value: string | undefined | null): Cursor | null {
  if (!value) return null;
  try {
    const parsed = JSON.parse(Buffer.from(value, "base64url").toString("utf8"));
    if (
      parsed &&
      typeof parsed === "object" &&
      typeof parsed.createdAt === "string" &&
      typeof parsed.id === "string"
    ) {
      return { createdAt: parsed.createdAt, id: parsed.id };
    }
    return null;
  } catch {
    // A malformed/tampered cursor is never fatal — treat it as "no
    // cursor" (first page) rather than throwing, since it only ever
    // affects which page of the CALLER's own tenant-scoped, RLS-filtered
    // data they see; it cannot be used to reach another tenant's rows.
    return null;
  }
}

export const DEFAULT_PAGE_SIZE = 25;
