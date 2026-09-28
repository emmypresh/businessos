import { describe, expect, it } from "vitest";
import {
  escapeCsvCell,
  sanitizeSpreadsheetCell,
  serializeCsv,
  safeCsvFilename,
  csvResponse,
  collectAllReportRows,
  ReportExportTooLargeError,
  REPORT_EXPORT_ROW_LIMIT,
  isoDateOnly,
  inclusiveEndDateOnly,
  type CsvColumn,
} from "./csv";

describe("escapeCsvCell", () => {
  it("leaves plain text unquoted", () => {
    expect(escapeCsvCell("Acme Ltd")).toBe("Acme Ltd");
  });

  it("quotes and preserves a value containing a comma", () => {
    expect(escapeCsvCell("Acme, Ltd")).toBe('"Acme, Ltd"');
  });

  it("quotes and doubles embedded double quotes", () => {
    expect(escapeCsvCell('John "Boss" Doe')).toBe('"John ""Boss"" Doe"');
  });

  it("quotes a value containing a newline", () => {
    expect(escapeCsvCell("Line1\nLine2")).toBe('"Line1\nLine2"');
  });

  it("quotes a value containing a carriage return", () => {
    expect(escapeCsvCell("Line1\rLine2")).toBe('"Line1\rLine2"');
  });

  it("passes through an empty string unquoted", () => {
    expect(escapeCsvCell("")).toBe("");
  });
});

describe("sanitizeSpreadsheetCell", () => {
  const dangerous = ["=SUM(1,1)", "+1+1", "-1+1", "@SUM(A1:A2)", "\ttabbed", "\rcr-led"];

  it.each(dangerous)("prefixes a single quote for dangerous value %s", (raw) => {
    expect(sanitizeSpreadsheetCell(raw)).toBe(`'${raw}`);
  });

  it("does not alter ordinary text", () => {
    expect(sanitizeSpreadsheetCell("Jose Customer")).toBe("Jose Customer");
  });

  it("does not alter an empty string", () => {
    expect(sanitizeSpreadsheetCell("")).toBe("");
  });

  it("preserves Unicode text untouched", () => {
    expect(sanitizeSpreadsheetCell("José Chloë Ọlá")).toBe("José Chloë Ọlá");
  });

  const leadingWhitespaceBypasses = [
    " =SUM(A1:A2)",
    "  =SUM(A1:A2)",
    "\t=SUM(A1:A2)",
    "\v=SUM(A1:A2)",
    "\f=SUM(A1:A2)",
    " =SUM(A1:A2)",
    " +1+1",
    " -2+3",
    " @cmd",
  ];

  it.each(leadingWhitespaceBypasses)("neutralizes a leading-whitespace formula bypass %j", (raw) => {
    expect(sanitizeSpreadsheetCell(raw)).toBe(`'${raw}`);
  });

  it("does not neutralize ordinary text with leading spaces", () => {
    expect(sanitizeSpreadsheetCell("  Ada Lovelace")).toBe("  Ada Lovelace");
  });

  it("neutralizes a bare leading carriage return with no formula marker after it", () => {
    expect(sanitizeSpreadsheetCell("\rSomething")).toBe("'\rSomething");
  });
});

type Row = { name: string; amount: number; nullable: string | null };

describe("serializeCsv", () => {
  const columns: CsvColumn<Row>[] = [
    { header: "Name", value: (r) => r.name, userText: true },
    { header: "Amount", value: (r) => r.amount },
    { header: "Nullable", value: (r) => r.nullable, userText: true },
  ];

  it("writes a header row and CRLF-joined data rows", () => {
    const csv = serializeCsv(columns, [{ name: "Ada", amount: 10, nullable: null }]);
    expect(csv).toBe("Name,Amount,Nullable\r\nAda,10,");
  });

  it("escapes a comma-containing user-text field", () => {
    const csv = serializeCsv(columns, [{ name: "Acme, Ltd", amount: 1, nullable: null }]);
    expect(csv.split("\r\n")[1]).toBe('"Acme, Ltd",1,');
  });

  it("escapes a quote-containing user-text field", () => {
    const csv = serializeCsv(columns, [{ name: 'John "Boss" Doe', amount: 1, nullable: null }]);
    expect(csv.split("\r\n")[1]).toBe('"John ""Boss"" Doe",1,');
  });

  it("escapes a newline-containing user-text field", () => {
    const csv = serializeCsv(columns, [{ name: "Line1\nLine2", amount: 1, nullable: null }]);
    expect(csv).toContain('"Line1\nLine2"');
  });

  it("neutralizes a formula-injection attempt in a user-text field", () => {
    const csv = serializeCsv(columns, [{ name: "=SUM(1,1)", amount: 1, nullable: null }]);
    // Quoted because the sanitized value still contains a comma, but the
    // leading character inside the quotes is now a literal quote mark
    // ('), never a bare "=" that a spreadsheet would treat as a formula.
    expect(csv.split("\r\n")[1]).toBe(`"'=SUM(1,1)",1,`);
  });

  it("never sanitizes a genuinely numeric negative value", () => {
    const csv = serializeCsv(columns, [{ name: "ok", amount: -123.45, nullable: null }]);
    expect(csv.split("\r\n")[1]).toBe("ok,-123.45,");
  });

  it("renders Unicode names byte-for-byte", () => {
    const csv = serializeCsv(columns, [{ name: "José Chloë Ọlá", amount: 1, nullable: null }]);
    expect(csv).toContain("José Chloë Ọlá");
  });

  it("renders an empty string field as an empty cell", () => {
    const csv = serializeCsv(columns, [{ name: "", amount: 1, nullable: null }]);
    expect(csv.split("\r\n")[1]).toBe(",1,");
  });
});

describe("safeCsvFilename", () => {
  it("joins parts with hyphens and appends .csv", () => {
    expect(safeCsvFilename(["businessos", "sales", "2026-09-01", "to", "2026-09-30"])).toBe(
      "businessos-sales-2026-09-01-to-2026-09-30.csv"
    );
  });

  it("strips characters outside [A-Za-z0-9-], including path/header-injection attempts", () => {
    expect(safeCsvFilename(["businessos", 'evil";x=1'])).toBe("businessos-evil-x-1.csv");
    expect(safeCsvFilename(["businessos", "a\r\nSet-Cookie: x=1"])).not.toMatch(/[\r\n]/);
  });
});

describe("csvResponse", () => {
  it("sets the expected content type, disposition, cache, and nosniff headers", async () => {
    const response = csvResponse("a,b\r\n1,2", "report.csv");
    expect(response.status).toBe(200);
    expect(response.headers.get("Content-Type")).toBe("text/csv; charset=utf-8");
    expect(response.headers.get("Content-Disposition")).toBe('attachment; filename="report.csv"');
    expect(response.headers.get("Cache-Control")).toBe("private, no-store");
    expect(response.headers.get("X-Content-Type-Options")).toBe("nosniff");
    expect(await response.text()).toBe("a,b\r\n1,2");
  });
});

describe("collectAllReportRows", () => {
  it("returns all rows from a single page", async () => {
    const rows = await collectAllReportRows(async () => ({ rows: [1, 2, 3], totalCount: 3, pageSize: 100 }));
    expect(rows).toEqual([1, 2, 3]);
  });

  it("pages through multiple pages deterministically without duplicates", async () => {
    const pages = [
      { rows: [1, 2], totalCount: 5, pageSize: 2 },
      { rows: [3, 4], totalCount: 5, pageSize: 2 },
      { rows: [5], totalCount: 5, pageSize: 2 },
    ];
    const calls: number[] = [];
    const rows = await collectAllReportRows(async (page) => {
      calls.push(page);
      return pages[page - 1];
    });
    expect(rows).toEqual([1, 2, 3, 4, 5]);
    expect(calls).toEqual([1, 2, 3]);
  });

  it("throws ReportExportTooLargeError without fetching further pages when totalCount exceeds the limit", async () => {
    let fetchCount = 0;
    const fetchPage = async () => {
      fetchCount += 1;
      return { rows: [], totalCount: REPORT_EXPORT_ROW_LIMIT + 1, pageSize: 100 };
    };
    await expect(collectAllReportRows(fetchPage)).rejects.toBeInstanceOf(ReportExportTooLargeError);
    expect(fetchCount).toBe(1);
  });

  it("succeeds exactly at the row limit", async () => {
    const rows = await collectAllReportRows(async () => ({
      rows: new Array(REPORT_EXPORT_ROW_LIMIT).fill(0),
      totalCount: REPORT_EXPORT_ROW_LIMIT,
      pageSize: REPORT_EXPORT_ROW_LIMIT,
    }));
    expect(rows).toHaveLength(REPORT_EXPORT_ROW_LIMIT);
  });

  it("terminates on an exact multiple of the page size without an extra empty page fetch", async () => {
    const pages = [
      { rows: [1, 2], totalCount: 4, pageSize: 2 },
      { rows: [3, 4], totalCount: 4, pageSize: 2 },
    ];
    const calls: number[] = [];
    const rows = await collectAllReportRows(async (page) => {
      calls.push(page);
      return pages[page - 1];
    });
    expect(rows).toEqual([1, 2, 3, 4]);
    expect(calls).toEqual([1, 2]);
  });

  // (A) Exactly 10,000 rows at the standard 100-row page size is the
  // largest export this system supports, and must still succeed — the
  // fail-closed guard below must never reject an honest totalCount/
  // pageSize pair that exactly fills the ceiling.
  it("succeeds for exactly 10,000 rows at the standard page size (100 required pages)", async () => {
    let fetchCount = 0;
    const rows = await collectAllReportRows(async () => {
      fetchCount += 1;
      return { rows: new Array(100).fill(0), totalCount: REPORT_EXPORT_ROW_LIMIT, pageSize: 100 };
    });
    expect(fetchCount).toBe(100);
    expect(rows).toHaveLength(REPORT_EXPORT_ROW_LIMIT);
  });

  // (B) An inconsistent totalCount/pageSize pair that would require more
  // pages than the fixed ceiling allows must throw — never silently
  // truncate to whatever the ceiling could fetch.
  it("throws (never silently truncates) when totalCount at the limit implies more pages than the ceiling allows", async () => {
    let fetchCount = 0;
    const fetchPage = async () => {
      fetchCount += 1;
      // pageSize of 1 with totalCount at the limit implies 10,000 required
      // pages — far past the 100-page ceiling.
      return { rows: [0], totalCount: REPORT_EXPORT_ROW_LIMIT, pageSize: 1 };
    };
    await expect(collectAllReportRows(fetchPage)).rejects.toBeInstanceOf(ReportExportTooLargeError);
    // Rejected on page-1 metadata alone — never pages further while
    // trying to "make progress" toward an unsafe page count.
    expect(fetchCount).toBe(1);
  });

  // (C) Same failure mode, but well under the row limit — proves the
  // guard is about required *pages*, not just totalCount vs. the row
  // ceiling.
  it("throws when a below-row-limit totalCount still implies more than 100 required pages", async () => {
    let fetchCount = 0;
    const fetchPage = async () => {
      fetchCount += 1;
      return { rows: [0], totalCount: 5_000, pageSize: 1 };
    };
    await expect(collectAllReportRows(fetchPage)).rejects.toBeInstanceOf(ReportExportTooLargeError);
    expect(fetchCount).toBe(1);
  });

  // (D) No fetch ever goes beyond the maximum permitted page count, even
  // right at the boundary that is allowed to succeed.
  it("fetches no more than the maximum permitted page count on a valid full export", async () => {
    const pageCalls: number[] = [];
    await collectAllReportRows(async (page) => {
      pageCalls.push(page);
      return { rows: new Array(100).fill(0), totalCount: REPORT_EXPORT_ROW_LIMIT, pageSize: 100 };
    });
    expect(Math.max(...pageCalls)).toBe(100);
    expect(pageCalls).toHaveLength(100);
  });

  // (E) A normal, well-under-ceiling multi-page export still succeeds
  // exactly as before this remediation.
  it("still succeeds for a normal multi-page export", async () => {
    const pages = [
      { rows: [1, 2], totalCount: 5, pageSize: 2 },
      { rows: [3, 4], totalCount: 5, pageSize: 2 },
      { rows: [5], totalCount: 5, pageSize: 2 },
    ];
    const rows = await collectAllReportRows(async (page) => pages[page - 1]);
    expect(rows).toEqual([1, 2, 3, 4, 5]);
  });

  // (F) No silent partial result: even when the required-pages check
  // passes, a backend that stops returning rows before the declared
  // total is reached must still fail closed rather than hand back a
  // short CSV as if it were complete.
  it("throws rather than returning an incomplete row set when paging ends short of the declared totalCount", async () => {
    const pages = [
      { rows: [1, 2], totalCount: 6, pageSize: 2 },
      { rows: [3, 4], totalCount: 6, pageSize: 2 },
      { rows: [], totalCount: 6, pageSize: 2 }, // page 3 comes back empty instead of [5, 6]
    ];
    const fetchPage = async (page: number) => pages[page - 1];
    await expect(collectAllReportRows(fetchPage)).rejects.toBeInstanceOf(ReportExportTooLargeError);
  });

  it("falls back to the standard page size (never divides by zero/NaN/negative) when the upstream pageSize is unusable", async () => {
    const unusablePageSizes = [0, -1, Number.NaN, -Infinity];
    for (const badPageSize of unusablePageSizes) {
      const rows = await collectAllReportRows(async () => ({ rows: [1, 2, 3], totalCount: 3, pageSize: badPageSize }));
      expect(rows).toEqual([1, 2, 3]);
    }
  });
});

describe("date helpers", () => {
  it("isoDateOnly slices the calendar day", () => {
    expect(isoDateOnly("2026-09-15T00:00:00Z")).toBe("2026-09-15");
  });

  it("inclusiveEndDateOnly shows the day before a half-open upper bound", () => {
    expect(inclusiveEndDateOnly("2026-09-17T00:00:00Z")).toBe("2026-09-16");
  });
});
