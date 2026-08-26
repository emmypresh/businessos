import { describe, expect, it } from "vitest";
import { previewSlug } from "./slug";

describe("previewSlug", () => {
  it("lowercases and hyphenates", () => {
    expect(previewSlug("Acme Hardware Co.")).toBe("acme-hardware-co");
  });

  it("collapses repeated separators", () => {
    expect(previewSlug("A -- B__C")).toBe("a-b-c");
  });

  it("trims leading/trailing hyphens", () => {
    expect(previewSlug("--Acme--")).toBe("acme");
  });

  it("returns an empty string for punctuation-only input", () => {
    expect(previewSlug("***")).toBe("");
  });
});
