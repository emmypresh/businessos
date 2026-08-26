import { describe, expect, it } from "vitest";
import { isSafeRedirectPath } from "./safe-redirect";

describe("isSafeRedirectPath", () => {
  it("accepts a plain internal path", () => {
    expect(isSafeRedirectPath("/onboarding", "/")).toBe("/onboarding");
  });

  it("accepts a nested internal path with a query string", () => {
    expect(isSafeRedirectPath("/abc-123/members?tab=x", "/")).toBe(
      "/abc-123/members?tab=x"
    );
  });

  it("falls back for null/empty", () => {
    expect(isSafeRedirectPath(null, "/")).toBe("/");
    expect(isSafeRedirectPath("", "/")).toBe("/");
  });

  it("falls back for a protocol-relative URL", () => {
    expect(isSafeRedirectPath("//evil.example.com", "/")).toBe("/");
  });

  it("falls back for a backslash trick", () => {
    expect(isSafeRedirectPath("/\\evil.example.com", "/")).toBe("/");
  });

  it("falls back for an absolute URL", () => {
    expect(isSafeRedirectPath("https://evil.example.com/", "/")).toBe("/");
    expect(isSafeRedirectPath("javascript://evil", "/")).toBe("/");
  });

  it("falls back for a path missing the leading slash", () => {
    expect(isSafeRedirectPath("evil.example.com", "/")).toBe("/");
  });
});
