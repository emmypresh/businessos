/**
 * Returns `value` if it is safe to pass to Next's `redirect()` — an
 * internal, single-leading-slash, same-origin path — otherwise returns
 * `fallback`. Rejects:
 *  - anything not starting with exactly one "/" (so a bare domain, or a
 *    scheme like "javascript:", is never accepted)
 *  - "//host/path" and "/\host/path" (protocol-relative / backslash
 *    tricks some browsers still normalize into a host change)
 *  - any value containing "://" (an absolute URL smuggled into a path
 *    string)
 */
export function isSafeRedirectPath(
  value: string | null | undefined,
  fallback: string
): string {
  if (!value) return fallback;
  if (!value.startsWith("/")) return fallback;
  if (value.startsWith("//")) return fallback;
  if (value.startsWith("/\\")) return fallback;
  if (value.includes("://")) return fallback;
  return value;
}
