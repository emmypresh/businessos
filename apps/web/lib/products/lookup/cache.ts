import "server-only";
import type { ExternalProductCandidate } from "./types";

// Phase 1Q-C — lightweight, in-process cache (phase instruction §18/§59:
// "an in-process/server cache may be enough initially," "do not add
// database schema unless actually needed"). Deliberately NOT persisted:
// it resets on redeploy/restart/new serverless instance, which only ever
// costs an extra provider round-trip, never correctness — cached external
// data is never treated as authoritative (phase instruction §20), so a
// cold cache is indistinguishable from a cold start.
//
// Keyed by `${providerName}:${normalizedIdentifier}` — scoped to provider
// + identifier only, never to business/tenant, matching phase instruction
// §49 ("no tenant data cross-contamination"): the underlying data is
// public, provider-sourced product information, identical for every
// business that looks up the same barcode, so sharing this cache across
// businesses leaks nothing tenant-specific.
const POSITIVE_TTL_MS = 6 * 60 * 60 * 1000; // 6 hours
const NEGATIVE_TTL_MS = 5 * 60 * 1000; // short — §19: never permanently cache "not found"

// Resource bound: at most this many entries are ever retained. `store` is a
// Map, which iterates in insertion order, so it doubles as an LRU list —
// a read re-inserts the entry (most-recent last) and, when a write pushes
// the size over the cap, the first key (least recently used) is evicted.
// Entries are tiny and TTL-expired lazily on read, so without this cap a
// stream of distinct barcodes would grow the map without limit.
export const LOOKUP_CACHE_MAX_ENTRIES = 500;

type CacheEntry =
  | { kind: "hit"; value: ExternalProductCandidate; expiresAt: number }
  | { kind: "miss"; expiresAt: number };

const store = new Map<string, CacheEntry>();
// Deduplicates identical concurrent lookups in-flight (phase instruction
// §17) — a second caller for the same key while one is already pending
// awaits the SAME provider promise instead of issuing a second request.
const inFlight = new Map<string, Promise<ExternalProductCandidate | null>>();

function cacheKey(providerName: string, normalizedIdentifier: string): string {
  return `${providerName}:${normalizedIdentifier}`;
}

export function getCached(providerName: string, normalizedIdentifier: string): ExternalProductCandidate | null | undefined {
  const key = cacheKey(providerName, normalizedIdentifier);
  const entry = store.get(key);
  if (!entry) return undefined;
  if (entry.expiresAt <= Date.now()) {
    store.delete(key);
    return undefined;
  }
  // Refresh recency (LRU): move to the end of the insertion order.
  store.delete(key);
  store.set(key, entry);
  return entry.kind === "hit" ? entry.value : null;
}

function setCached(providerName: string, normalizedIdentifier: string, value: ExternalProductCandidate | null): void {
  const key = cacheKey(providerName, normalizedIdentifier);
  store.delete(key);
  store.set(
    key,
    value === null
      ? { kind: "miss", expiresAt: Date.now() + NEGATIVE_TTL_MS }
      : { kind: "hit", value, expiresAt: Date.now() + POSITIVE_TTL_MS }
  );
  while (store.size > LOOKUP_CACHE_MAX_ENTRIES) {
    const oldest = store.keys().next().value;
    if (oldest === undefined) break;
    store.delete(oldest);
  }
}

// Runs `fetcher` only if there is no live cache entry and no identical
// request already in flight; callers that hit either case never touch
// the network. Provider errors (thrown by `fetcher`) are NEVER cached —
// only a genuine result (hit or confirmed miss) is stored, so a transient
// timeout/rate-limit never poisons the cache for the next caller.
export async function withLookupCache(
  providerName: string,
  normalizedIdentifier: string,
  fetcher: () => Promise<ExternalProductCandidate | null>
): Promise<ExternalProductCandidate | null> {
  const cached = getCached(providerName, normalizedIdentifier);
  if (cached !== undefined) return cached;

  const key = cacheKey(providerName, normalizedIdentifier);
  const pending = inFlight.get(key);
  if (pending) return pending;

  const promise = fetcher()
    .then((result) => {
      setCached(providerName, normalizedIdentifier, result);
      return result;
    })
    .finally(() => {
      inFlight.delete(key);
    });

  inFlight.set(key, promise);
  return promise;
}

// Test-only reset — without this, cache.test.ts's own assertions would
// leak state into every other test file sharing this module singleton.
export function __lookupCacheSizeForTests(): number {
  return store.size;
}

export function __resetLookupCacheForTests(): void {
  store.clear();
  inFlight.clear();
}
