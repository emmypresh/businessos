// Display-only helper mirroring private.normalize_slug's shape for instant
// UI feedback while typing; create_business (the RPC) is still the sole
// source of truth and re-derives the slug itself server-side.
export function previewSlug(name: string): string {
  return name
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}
