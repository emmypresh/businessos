// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { cleanup, render, screen, within } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { BranchPerformance } from "./branch-performance";

describe("BranchPerformance", () => {
  afterEach(cleanup);

  const branches = [
    { branchId: "branch-a", branchName: "Main Branch", revenue: 125000.5, orderCount: 8 },
    { branchId: "branch-b", branchName: "Annex", revenue: 0, orderCount: 0 },
  ];

  it("renders a labeled region with authorized aggregate rows and branch names", () => {
    render(<BranchPerformance branches={branches} currencyCode="NGN" />);
    expect(screen.getByRole("region", { name: "Branch performance" })).toBeInTheDocument();
    expect(screen.getByText("Main Branch")).toBeInTheDocument();
    expect(screen.getByText("Annex")).toBeInTheDocument();
  });

  it("formats completed-sales revenue as currency and completed sales as an integer", () => {
    render(<BranchPerformance branches={branches} currencyCode="NGN" />);
    expect(screen.getByText("NGN 125,000.50")).toBeInTheDocument();
    const row = screen.getByText("Main Branch").closest("tr");
    expect(row).not.toBeNull();
    expect(within(row as HTMLElement).getByText("8")).toBeInTheDocument();
  });

  it("preserves a zero-activity branch row rather than dropping it", () => {
    render(<BranchPerformance branches={branches} currencyCode="NGN" />);
    const row = screen.getByText("Annex").closest("tr");
    expect(row).not.toBeNull();
    expect(within(row as HTMLElement).getByText("NGN 0.00")).toBeInTheDocument();
    expect(within(row as HTMLElement).getByText("0")).toBeInTheDocument();
  });

  it("renders a truthful empty state when no branches are authorized, not a false 'no branches exist' claim", () => {
    render(<BranchPerformance branches={[]} currencyCode="NGN" />);
    expect(screen.getByText("No branch performance data is available for your assigned branches in this period.")).toBeInTheDocument();
    expect(screen.queryByText(/no branches exist/i)).not.toBeInTheDocument();
    expect(screen.queryByRole("table")).not.toBeInTheDocument();
  });

  it("never renders fabricated ranking or judgment language", () => {
    render(<BranchPerformance branches={branches} currencyCode="NGN" />);
    expect(screen.queryByText(/top branch|best branch|worst branch|underperform|needs attention|branch health|strong growth/i)).not.toBeInTheDocument();
  });

  it("never renders unsupported metrics such as profit, margin, or productivity", () => {
    render(<BranchPerformance branches={branches} currencyCode="NGN" />);
    expect(screen.queryByText(/profit|margin|productivity|branch score|target attainment/i)).not.toBeInTheDocument();
  });

  it("only displays the frozen fields: branch name, revenue, and completed sales — no branch IDs or internal metadata", () => {
    render(<BranchPerformance branches={branches} currencyCode="NGN" />);
    expect(screen.queryByText("branch-a")).not.toBeInTheDocument();
    expect(screen.queryByText("branch-b")).not.toBeInTheDocument();
  });

  it("renders semantic table markup with column headers for accessibility", () => {
    render(<BranchPerformance branches={branches} currencyCode="NGN" />);
    expect(screen.getByRole("table")).toBeInTheDocument();
    expect(screen.getByRole("columnheader", { name: "Branch" })).toBeInTheDocument();
    expect(screen.getByRole("columnheader", { name: "Completed-sales revenue" })).toBeInTheDocument();
    expect(screen.getByRole("columnheader", { name: "Completed sales" })).toBeInTheDocument();
  });

  it("renders rows in the order the aggregate provides them, implying no business-wide ranking", () => {
    render(<BranchPerformance branches={branches} currencyCode="NGN" />);
    const cells = screen.getAllByRole("row").slice(1).map((row) => within(row).getAllByRole("cell")[0].textContent);
    expect(cells).toEqual(["Main Branch", "Annex"]);
  });

  it("shows a truthful visible-branch count reflecting only authorized branches", () => {
    render(<BranchPerformance branches={branches} currencyCode="NGN" />);
    expect(screen.getByText(/for the 2 branches you are assigned to/i)).toBeInTheDocument();
  });

  it("handles an empty array safely with no NaN or Infinity", () => {
    render(<BranchPerformance branches={[]} currencyCode="NGN" />);
    expect(screen.queryByText(/NaN|Infinity/)).not.toBeInTheDocument();
  });
});
