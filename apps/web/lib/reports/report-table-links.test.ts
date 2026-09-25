import { describe, expect, it } from "vitest";
import { buildReportSortHref, buildReportPageHref, type ReportTableLinkState } from "./report-table-links";

const FULL_STATE: ReportTableLinkState = {
  preset: "custom",
  dateFrom: "2026-01-01",
  dateTo: "2026-01-31",
  branch: "11111111-1111-1111-1111-111111111111",
  search: "ada",
  sort: "revenue",
  direction: "desc",
};

describe("buildReportSortHref", () => {
  it("preserves preset/dateFrom/dateTo/branch/search and toggles direction on the same key", () => {
    const href = buildReportSortHref(FULL_STATE, "revenue", "asc");
    const params = new URLSearchParams(href.slice(1));
    expect(params.get("preset")).toBe("custom");
    expect(params.get("dateFrom")).toBe("2026-01-01");
    expect(params.get("dateTo")).toBe("2026-01-31");
    expect(params.get("branch")).toBe(FULL_STATE.branch);
    expect(params.get("q")).toBe("ada");
    expect(params.get("sort")).toBe("revenue");
    expect(params.get("dir")).toBe("asc");
    expect(params.has("page")).toBe(false);
  });

  it("switches sort key and resets direction to desc", () => {
    const href = buildReportSortHref(FULL_STATE, "name", "desc");
    const params = new URLSearchParams(href.slice(1));
    expect(params.get("sort")).toBe("name");
    expect(params.get("dir")).toBe("desc");
  });

  it("omits empty/undefined fields entirely", () => {
    const href = buildReportSortHref({ sort: "revenue", direction: "desc" }, "revenue", "asc");
    const params = new URLSearchParams(href.slice(1));
    expect(params.has("preset")).toBe(false);
    expect(params.has("dateFrom")).toBe(false);
    expect(params.has("dateTo")).toBe(false);
    expect(params.has("branch")).toBe(false);
    expect(params.has("q")).toBe(false);
  });
});

describe("buildReportPageHref", () => {
  it("preserves preset/dateFrom/dateTo/branch/search/sort/direction and sets the target page", () => {
    const href = buildReportPageHref(FULL_STATE, 3);
    const params = new URLSearchParams(href.slice(1));
    expect(params.get("preset")).toBe("custom");
    expect(params.get("dateFrom")).toBe("2026-01-01");
    expect(params.get("dateTo")).toBe("2026-01-31");
    expect(params.get("branch")).toBe(FULL_STATE.branch);
    expect(params.get("q")).toBe("ada");
    expect(params.get("sort")).toBe("revenue");
    expect(params.get("dir")).toBe("desc");
    expect(params.get("page")).toBe("3");
  });
});
