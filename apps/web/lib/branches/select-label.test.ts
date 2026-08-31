import { describe, expect, it } from "vitest";
import { resolveBranchSelectLabel } from "./select-label";

const branches = [
  { id: "branch-a", name: "Benin Main" },
  { id: "branch-b", name: "B".repeat(100) },
];

describe("resolveBranchSelectLabel", () => {
  it("resolves a real branch id to its own name", () => {
    expect(resolveBranchSelectLabel("branch-a", branches)).toBe("Benin Main");
  });

  it("resolves a long (100-character) branch name unmodified — never truncated by this helper", () => {
    expect(resolveBranchSelectLabel("branch-b", branches)).toBe("B".repeat(100));
  });

  it("resolves a sentinel value to its mapped label, never the sentinel string itself", () => {
    expect(
      resolveBranchSelectLabel("company-wide", branches, { sentinels: { "company-wide": "Company-wide" } })
    ).toBe("Company-wide");
  });

  it("falls back to the placeholder for an empty/falsy value", () => {
    expect(resolveBranchSelectLabel("", branches, { placeholder: "Choose a branch" })).toBe("Choose a branch");
    expect(resolveBranchSelectLabel(null, branches, { placeholder: "Choose a branch" })).toBe("Choose a branch");
    expect(resolveBranchSelectLabel(undefined, branches, { placeholder: "Choose a branch" })).toBe(
      "Choose a branch"
    );
  });

  it("falls back to an empty string, NEVER the raw id, for a value outside both branches and sentinels", () => {
    expect(resolveBranchSelectLabel("some-unknown-uuid", branches)).toBe("");
    expect(resolveBranchSelectLabel("some-unknown-uuid", branches, { sentinels: { all: "All branches" } })).toBe(
      ""
    );
  });

  it("a sentinel takes precedence over a same-valued branch id (defensive; the two spaces never actually overlap)", () => {
    expect(
      resolveBranchSelectLabel("branch-a", branches, { sentinels: { "branch-a": "Sentinel Wins" } })
    ).toBe("Sentinel Wins");
  });
});
