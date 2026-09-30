import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import { ProductLookupConfigError, resolveOffBaseUrl, OFF_DEFAULT_BASE_URL } from "./off-base-url";

// The complete, explicit test-only signal set. NODE_ENV is "test" (never
// "production") — this mirrors how the e2e server is started.
const loopbackEnv = (url: string) => ({
  PRODUCT_LOOKUP_OFF_BASE_URL: url,
  PRODUCT_LOOKUP_ALLOW_LOOPBACK: "1",
  BUSINESSOS_E2E: "1",
  NODE_ENV: "test",
});
const LOOPBACK_URLS = ["http://localhost:3199", "http://127.0.0.1:3199", "http://[::1]:3199"];
const prodEnv = (url: string) => ({ PRODUCT_LOOKUP_OFF_BASE_URL: url });

describe("resolveOffBaseUrl — accepted", () => {
  it("defaults to the official host when unset or blank", () => {
    expect(resolveOffBaseUrl({})).toBe(OFF_DEFAULT_BASE_URL);
    expect(resolveOffBaseUrl(prodEnv("  "))).toBe(OFF_DEFAULT_BASE_URL);
  });

  it("accepts the official Open Food Facts URL (with or without trailing slash)", () => {
    expect(resolveOffBaseUrl(prodEnv("https://world.openfoodfacts.org"))).toBe("https://world.openfoodfacts.org");
    expect(resolveOffBaseUrl(prodEnv("https://world.openfoodfacts.org/"))).toBe("https://world.openfoodfacts.org");
    expect(resolveOffBaseUrl(prodEnv("https://WORLD.OpenFoodFacts.org"))).toBe("https://world.openfoodfacts.org");
  });

  it("accepts the official host under NODE_ENV=production and under VERCEL_ENV=production", () => {
    for (const extra of [{ NODE_ENV: "production" }, { VERCEL_ENV: "production" }, { NODE_ENV: "production", VERCEL_ENV: "production" }]) {
      expect(resolveOffBaseUrl({ ...prodEnv("https://world.openfoodfacts.org"), ...extra })).toBe(
        "https://world.openfoodfacts.org"
      );
      expect(resolveOffBaseUrl({ ...extra })).toBe(OFF_DEFAULT_BASE_URL);
    }
  });

  it("accepts localhost / 127.0.0.1 / ::1 with a custom port only when loopback is explicitly enabled", () => {
    expect(resolveOffBaseUrl(loopbackEnv("http://localhost:3199"))).toBe("http://localhost:3199");
    expect(resolveOffBaseUrl(loopbackEnv("http://127.0.0.1:3199"))).toBe("http://127.0.0.1:3199");
    expect(resolveOffBaseUrl(loopbackEnv("http://[::1]:3199"))).toBe("http://[::1]:3199");
  });
});

describe("resolveOffBaseUrl — rejected (fails closed)", () => {
  const rejected: [string, string][] = [
    ["arbitrary host", "https://evil.example.com"],
    ["look-alike subdomain suffix", "https://openfoodfacts.org.evil.example.com"],
    ["look-alike prefix", "https://world.openfoodfacts.org.evil.example.com"],
    ["other openfoodfacts subdomain", "https://us.openfoodfacts.org"],
    ["bare apex", "https://openfoodfacts.org"],
    ["cloud metadata IP", "http://169.254.169.254"],
    ["private 10/8", "http://10.0.0.1"],
    ["private 192.168/16", "http://192.168.1.1"],
    ["private 172.16/12", "http://172.16.0.1"],
    ["file scheme", "file:///etc/passwd"],
    ["ftp scheme", "ftp://world.openfoodfacts.org"],
    ["data scheme", "data:text/plain,hi"],
    ["javascript scheme", "javascript:alert(1)"],
    ["embedded credentials", "https://user:pass@world.openfoodfacts.org"],
    ["username only", "https://user@world.openfoodfacts.org"],
    ["credentials to evil host", "https://world.openfoodfacts.org@evil.example.com"],
    ["official host over http", "http://world.openfoodfacts.org"],
    ["official host on unusual port", "https://world.openfoodfacts.org:8443"],
    ["path component", "https://world.openfoodfacts.org/evil"],
    ["query component", "https://world.openfoodfacts.org/?x=1"],
    ["unparseable", "not a url"],
  ];

  it.each(rejected)("rejects %s", (_label, url) => {
    // Rejected both with and without the loopback opt-in.
    expect(() => resolveOffBaseUrl(prodEnv(url))).toThrow(ProductLookupConfigError);
    expect(() => resolveOffBaseUrl(loopbackEnv(url))).toThrow(ProductLookupConfigError);
  });

  it("rejects a decimal-encoded loopback IP unless loopback is enabled", () => {
    // WHATWG URL normalizes http://2130706433 to 127.0.0.1.
    expect(() => resolveOffBaseUrl(prodEnv("http://2130706433"))).toThrow(ProductLookupConfigError);
  });

  it("rejects loopback under NODE_ENV=production, even with both test flags", () => {
    for (const url of LOOPBACK_URLS) {
      expect(() => resolveOffBaseUrl({ ...loopbackEnv(url), NODE_ENV: "production" })).toThrow(ProductLookupConfigError);
      expect(() =>
        resolveOffBaseUrl({ PRODUCT_LOOKUP_OFF_BASE_URL: url, NODE_ENV: "production" })
      ).toThrow(ProductLookupConfigError);
    }
  });

  it("rejects loopback under VERCEL_ENV=production, even with both test flags and a non-production NODE_ENV", () => {
    for (const url of LOOPBACK_URLS) {
      expect(() => resolveOffBaseUrl({ ...loopbackEnv(url), VERCEL_ENV: "production" })).toThrow(ProductLookupConfigError);
      expect(() =>
        resolveOffBaseUrl({ ...loopbackEnv(url), NODE_ENV: "development", VERCEL_ENV: "production" })
      ).toThrow(ProductLookupConfigError);
    }
  });

  it("rejects loopback with both flags when both production signals are active", () => {
    for (const url of LOOPBACK_URLS) {
      expect(() =>
        resolveOffBaseUrl({ ...loopbackEnv(url), NODE_ENV: "production", VERCEL_ENV: "production" })
      ).toThrow(ProductLookupConfigError);
    }
  });

  it("rejects loopback with only the old PRODUCT_LOOKUP_ALLOW_LOOPBACK=1 opt-in (no NODE_ENV, non-production NODE_ENV, or production)", () => {
    for (const url of LOOPBACK_URLS) {
      const base = { PRODUCT_LOOKUP_OFF_BASE_URL: url, PRODUCT_LOOKUP_ALLOW_LOOPBACK: "1" };
      expect(() => resolveOffBaseUrl(base)).toThrow(ProductLookupConfigError);
      expect(() => resolveOffBaseUrl({ ...base, NODE_ENV: "development" })).toThrow(ProductLookupConfigError);
      expect(() => resolveOffBaseUrl({ ...base, NODE_ENV: "production" })).toThrow(ProductLookupConfigError);
    }
  });

  it("rejects loopback with only BUSINESSOS_E2E=1 (no loopback opt-in)", () => {
    for (const url of LOOPBACK_URLS) {
      const base = { PRODUCT_LOOKUP_OFF_BASE_URL: url, BUSINESSOS_E2E: "1", NODE_ENV: "test" };
      expect(() => resolveOffBaseUrl(base)).toThrow(ProductLookupConfigError);
    }
  });

  it("requires the exact string \"1\" for both flags", () => {
    for (const url of LOOPBACK_URLS) {
      for (const bad of ["true", "0", "", "yes", " 1"]) {
        expect(() => resolveOffBaseUrl({ ...loopbackEnv(url), BUSINESSOS_E2E: bad })).toThrow(ProductLookupConfigError);
        expect(() => resolveOffBaseUrl({ ...loopbackEnv(url), PRODUCT_LOOKUP_ALLOW_LOOPBACK: bad })).toThrow(
          ProductLookupConfigError
        );
      }
    }
  });

  it("does not widen the loopback list: only exact localhost / 127.0.0.1 / [::1] are ever accepted", () => {
    for (const url of [
      "http://127.0.0.2:3199",
      "http://0.0.0.0:3199",
      "http://[::ffff:127.0.0.1]:3199",
      "http://localhost.evil.example.com",
      "http://foo.localhost:3199",
    ]) {
      expect(() => resolveOffBaseUrl(loopbackEnv(url))).toThrow(ProductLookupConfigError);
    }
  });

  it("rejects private and metadata IPs even with every test flag set", () => {
    for (const url of ["http://10.0.0.1", "http://192.168.1.1", "http://172.16.0.1", "http://169.254.169.254", "http://[fd00::1]"]) {
      expect(() => resolveOffBaseUrl(loopbackEnv(url))).toThrow(ProductLookupConfigError);
    }
  });

  it("never echoes the configured value (which may hold credentials) in the error", () => {
    let message = "";
    try {
      resolveOffBaseUrl(prodEnv("https://user:s3cret@world.openfoodfacts.org"));
    } catch (err) {
      message = (err as Error).message;
    }
    expect(message).not.toBe("");
    expect(message).not.toContain("s3cret");
  });
});

describe("adapter integration: config error fails closed before any network call", () => {
  const fetchMock = vi.fn();

  beforeEach(() => {
    vi.stubGlobal("fetch", fetchMock);
    fetchMock.mockReset();
    vi.spyOn(console, "error").mockImplementation(() => {});
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.unstubAllEnvs();
    vi.restoreAllMocks();
  });

  it("throws PRODUCT_LOOKUP_NOT_CONFIGURED and never calls fetch for a disallowed host", async () => {
    vi.stubEnv("PRODUCT_LOOKUP_OFF_BASE_URL", "https://evil.example.com");
    const { openFoodFactsProvider } = await import("./open-food-facts");
    await expect(
      openFoodFactsProvider.lookupByIdentifier("5000112637922", new AbortController().signal)
    ).rejects.toMatchObject({ code: "PRODUCT_LOOKUP_NOT_CONFIGURED" });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("only ever requests the allowlisted host; the identifier cannot change it", async () => {
    vi.stubEnv("PRODUCT_LOOKUP_OFF_BASE_URL", "");
    fetchMock.mockResolvedValue(new Response(JSON.stringify({ status: 0 }), { status: 200 }));
    const { openFoodFactsProvider } = await import("./open-food-facts");
    await openFoodFactsProvider.lookupByIdentifier("5000112637922", new AbortController().signal);
    const [url, init] = fetchMock.mock.calls[0];
    expect(new URL(url as string).origin).toBe("https://world.openfoodfacts.org");
    expect((init as RequestInit).redirect).toBe("error");

    // Identifiers that could smuggle a host/path never reach fetch.
    fetchMock.mockClear();
    await expect(
      openFoodFactsProvider.lookupByIdentifier("@evil.example.com", new AbortController().signal)
    ).rejects.toBeInstanceOf(Error);
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
