import { describe, expect, it, vi, beforeEach } from "vitest";
import {
  withLookupCache,
  getCached,
  LOOKUP_CACHE_MAX_ENTRIES,
  __lookupCacheSizeForTests,
  __resetLookupCacheForTests,
} from "./cache";
import type { ExternalProductCandidate } from "./types";

const candidate: ExternalProductCandidate = {
  identifier: "5000112637922",
  identifierType: "EAN_13",
  name: "Test Product",
  brand: "Test Brand",
  description: null,
  imageUrl: null,
  categoryLabel: null,
  quantity: null,
  manufacturer: null,
  sourceProvider: "open_food_facts",
  sourceReference: "5000112637922",
};

beforeEach(() => {
  __resetLookupCacheForTests();
});

describe("withLookupCache", () => {
  it("caches a hit and does not call the fetcher again", async () => {
    const fetcher = vi.fn().mockResolvedValue(candidate);
    await withLookupCache("open_food_facts", "5000112637922", fetcher);
    const second = await withLookupCache("open_food_facts", "5000112637922", fetcher);
    expect(fetcher).toHaveBeenCalledTimes(1);
    expect(second).toEqual(candidate);
  });

  it("caches a miss (null) separately from a hit", async () => {
    const fetcher = vi.fn().mockResolvedValue(null);
    const result = await withLookupCache("open_food_facts", "0000000000000", fetcher);
    expect(result).toBeNull();
    const cached = getCached("open_food_facts", "0000000000000");
    expect(cached).toBeNull();
    await withLookupCache("open_food_facts", "0000000000000", fetcher);
    expect(fetcher).toHaveBeenCalledTimes(1);
  });

  it("scopes the cache by provider + identifier, not by any tenant/business dimension", async () => {
    const fetcher = vi.fn().mockResolvedValue(candidate);
    await withLookupCache("open_food_facts", "5000112637922", fetcher);
    const other = vi.fn().mockResolvedValue(candidate);
    const result = await withLookupCache("open_food_facts", "5000112637922", other);
    expect(other).not.toHaveBeenCalled();
    expect(result).toEqual(candidate);
  });

  it("does not cache a thrown provider error", async () => {
    const fetcher = vi.fn().mockRejectedValueOnce(new Error("boom")).mockResolvedValueOnce(candidate);
    await expect(withLookupCache("open_food_facts", "5000112637922", fetcher)).rejects.toThrow("boom");
    const result = await withLookupCache("open_food_facts", "5000112637922", fetcher);
    expect(result).toEqual(candidate);
    expect(fetcher).toHaveBeenCalledTimes(2);
  });

  it("dedupes identical in-flight requests", async () => {
    let resolve!: (v: ExternalProductCandidate | null) => void;
    const fetcher = vi.fn(
      () =>
        new Promise<ExternalProductCandidate | null>((r) => {
          resolve = r;
        })
    );
    const p1 = withLookupCache("open_food_facts", "5000112637922", fetcher);
    const p2 = withLookupCache("open_food_facts", "5000112637922", fetcher);
    resolve(candidate);
    const [r1, r2] = await Promise.all([p1, p2]);
    expect(fetcher).toHaveBeenCalledTimes(1);
    expect(r1).toEqual(candidate);
    expect(r2).toEqual(candidate);
  });
});

describe("cache max-entries bound (LRU eviction)", () => {
  const ok = () => vi.fn().mockResolvedValue(candidate);

  it("never exceeds LOOKUP_CACHE_MAX_ENTRIES and evicts the oldest entries", async () => {
    for (let i = 0; i < LOOKUP_CACHE_MAX_ENTRIES + 25; i++) {
      await withLookupCache("open_food_facts", `id-${i}`, ok());
      expect(__lookupCacheSizeForTests()).toBeLessThanOrEqual(LOOKUP_CACHE_MAX_ENTRIES);
    }
    expect(__lookupCacheSizeForTests()).toBe(LOOKUP_CACHE_MAX_ENTRIES);
    expect(getCached("open_food_facts", "id-0")).toBeUndefined();
    expect(getCached("open_food_facts", "id-24")).toBeUndefined();
    expect(getCached("open_food_facts", "id-25")).toEqual(candidate);
  });

  it("keeps the newest entry working after eviction pressure", async () => {
    for (let i = 0; i < LOOKUP_CACHE_MAX_ENTRIES + 5; i++) {
      await withLookupCache("open_food_facts", `id-${i}`, ok());
    }
    const fetcher = ok();
    await withLookupCache("open_food_facts", `id-${LOOKUP_CACHE_MAX_ENTRIES + 4}`, fetcher);
    expect(fetcher).not.toHaveBeenCalled();
  });

  it("a recent read protects an entry from eviction (LRU, not FIFO)", async () => {
    await withLookupCache("open_food_facts", "keep-me", ok());
    for (let i = 0; i < LOOKUP_CACHE_MAX_ENTRIES - 1; i++) {
      await withLookupCache("open_food_facts", `id-${i}`, ok());
    }
    expect(getCached("open_food_facts", "keep-me")).toEqual(candidate); // refreshes recency
    await withLookupCache("open_food_facts", "overflow", ok()); // evicts id-0, not keep-me
    expect(getCached("open_food_facts", "keep-me")).toEqual(candidate);
    expect(getCached("open_food_facts", "id-0")).toBeUndefined();
  });

  it("keeps provider+identifier keying distinct under the bound", async () => {
    await withLookupCache("provider_a", "123", vi.fn().mockResolvedValue(candidate));
    await withLookupCache("provider_b", "123", vi.fn().mockResolvedValue(null));
    expect(getCached("provider_a", "123")).toEqual(candidate);
    expect(getCached("provider_b", "123")).toBeNull();
    expect(__lookupCacheSizeForTests()).toBe(2);
  });
});
