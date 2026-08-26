import { describe, expect, it, beforeEach, afterEach } from "vitest";
import {
  assertLocalSupabaseUrl,
  assertLocalDatabaseUrl,
  UnsafeTestUrlError,
} from "./helpers/url-safety";

const ENV_KEYS = ["ALLOW_REMOTE_TEST_SUPABASE", "CI", "ALLOWED_CI_TEST_URLS"] as const;
let savedEnv: Record<string, string | undefined>;

beforeEach(() => {
  savedEnv = Object.fromEntries(ENV_KEYS.map((k) => [k, process.env[k]]));
  for (const k of ENV_KEYS) delete process.env[k];
});

afterEach(() => {
  for (const k of ENV_KEYS) {
    if (savedEnv[k] === undefined) delete process.env[k];
    else process.env[k] = savedEnv[k];
  }
});

describe("assertLocalSupabaseUrl", () => {
  it("accepts the real local Supabase API URL", () => {
    expect(() => assertLocalSupabaseUrl("http://127.0.0.1:54321")).not.toThrow();
  });

  it("accepts localhost with the right port", () => {
    expect(() => assertLocalSupabaseUrl("http://localhost:54321")).not.toThrow();
  });

  // The exact deceptive hostnames named in the security review: each one
  // would pass a naive `url.includes("localhost")` /
  // `url.includes("127.0.0.1")` substring check (the original,
  // vulnerable design) but must fail exact-hostname matching.
  it.each([
    ["http://localhost.attacker.example:54321", "starts with 'localhost.'"],
    ["http://127.0.0.1.attacker.example:54321", "starts with '127.0.0.1.'"],
    ["http://evil-localhost.example:54321", "ends with '-localhost.example', contains 'localhost'"],
    ["https://127.0.0.1.example.com", "contains '127.0.0.1', wrong protocol, wrong port"],
  ])("rejects deceptive lookalike URL: %s (%s)", (deceptiveUrl) => {
    expect(() => assertLocalSupabaseUrl(deceptiveUrl)).toThrow(UnsafeTestUrlError);
  });

  it("rejects a malformed URL", () => {
    expect(() => assertLocalSupabaseUrl("not a url at all")).toThrow(UnsafeTestUrlError);
    expect(() => assertLocalSupabaseUrl("")).toThrow(UnsafeTestUrlError);
  });

  it("rejects https even against an otherwise-local hostname", () => {
    expect(() => assertLocalSupabaseUrl("https://127.0.0.1:54321")).toThrow(UnsafeTestUrlError);
  });

  it("rejects the right hostname on the wrong port", () => {
    expect(() => assertLocalSupabaseUrl("http://127.0.0.1:9999")).toThrow(UnsafeTestUrlError);
  });

  it("rejects a genuine remote host even when it happens to contain 'localhost'", () => {
    expect(() =>
      assertLocalSupabaseUrl("http://evil-host-localhost.example.com:54321")
    ).toThrow(UnsafeTestUrlError);
  });

  it("rejects a remote target with no CI allowlist configured at all", () => {
    expect(() => assertLocalSupabaseUrl("https://my-project.supabase.co")).toThrow(
      UnsafeTestUrlError
    );
  });

  it("rejects a remote target when only one of the two required flags is set", () => {
    process.env.ALLOW_REMOTE_TEST_SUPABASE = "true";
    // CI unset
    expect(() => assertLocalSupabaseUrl("https://ci-disposable.supabase.co")).toThrow(
      UnsafeTestUrlError
    );

    delete process.env.ALLOW_REMOTE_TEST_SUPABASE;
    process.env.CI = "true";
    // ALLOW_REMOTE_TEST_SUPABASE unset
    expect(() => assertLocalSupabaseUrl("https://ci-disposable.supabase.co")).toThrow(
      UnsafeTestUrlError
    );
  });

  it("rejects a remote target when both flags are set but it isn't in the explicit allowlist", () => {
    process.env.ALLOW_REMOTE_TEST_SUPABASE = "true";
    process.env.CI = "true";
    process.env.ALLOWED_CI_TEST_URLS = "https://some-other-disposable.supabase.co";
    expect(() => assertLocalSupabaseUrl("https://ci-disposable.supabase.co")).toThrow(
      UnsafeTestUrlError
    );
  });

  it("accepts a remote target only when both flags are set AND it exactly matches the allowlist", () => {
    process.env.ALLOW_REMOTE_TEST_SUPABASE = "true";
    process.env.CI = "true";
    process.env.ALLOWED_CI_TEST_URLS = "https://ci-disposable.supabase.co,https://other.example";
    expect(() => assertLocalSupabaseUrl("https://ci-disposable.supabase.co")).not.toThrow();
  });
});

describe("assertLocalDatabaseUrl", () => {
  it("accepts the real local Postgres connection string", () => {
    expect(() =>
      assertLocalDatabaseUrl("postgresql://postgres:postgres@127.0.0.1:54322/postgres")
    ).not.toThrow();
  });

  it.each([
    ["postgresql://postgres:postgres@localhost.attacker.example:54322/postgres", "starts with 'localhost.'"],
    ["postgresql://postgres:postgres@127.0.0.1.attacker.example:54322/postgres", "starts with '127.0.0.1.'"],
    ["postgresql://postgres:postgres@evil-localhost.example:54322/postgres", "contains 'localhost'"],
    ["https://127.0.0.1.example.com:54322/postgres", "wrong protocol entirely, and a lookalike host"],
  ])("rejects deceptive lookalike database URL: %s (%s)", (deceptiveUrl) => {
    expect(() => assertLocalDatabaseUrl(deceptiveUrl)).toThrow(UnsafeTestUrlError);
  });

  it("rejects the right host/port but the wrong database name", () => {
    expect(() =>
      assertLocalDatabaseUrl("postgresql://postgres:postgres@127.0.0.1:54322/production")
    ).toThrow(UnsafeTestUrlError);
  });

  it("rejects the right host but the wrong port", () => {
    expect(() =>
      assertLocalDatabaseUrl("postgresql://postgres:postgres@127.0.0.1:5432/postgres")
    ).toThrow(UnsafeTestUrlError);
  });

  it("rejects a malformed connection string", () => {
    expect(() => assertLocalDatabaseUrl("definitely-not-a-connection-string")).toThrow(
      UnsafeTestUrlError
    );
  });

  it("rejects a remote database with no CI allowlist configured", () => {
    expect(() =>
      assertLocalDatabaseUrl("postgresql://user:pass@db.some-host.com:5432/postgres")
    ).toThrow(UnsafeTestUrlError);
  });
});
