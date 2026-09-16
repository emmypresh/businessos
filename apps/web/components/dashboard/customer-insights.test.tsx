// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { CustomerInsights } from "./customer-insights";

describe("CustomerInsights", () => {
  afterEach(cleanup);

  const current = { newCustomers: 3, returningCustomers: 2, repeatCustomers: 1 };
  const previous = { newCustomers: 1, returningCustomers: 1, repeatCustomers: 0 };

  it("renders real aggregate values with truthful new/returning/repeat definitions", () => {
    render(<CustomerInsights businessId="business-a" canViewCustomers current={current} previous={previous} />);
    expect(screen.getByText("Customer insights")).toBeInTheDocument();
    expect(screen.getByRole("region", { name: "Customer insights" })).toBeInTheDocument();
    expect(screen.getByLabelText("New customers: 3")).toBeInTheDocument();
    expect(screen.getByText("Customer records created in this period.")).toBeInTheDocument();
    expect(screen.getByLabelText("Returning customers: 2")).toBeInTheDocument();
    expect(screen.getByText("Customers with a completed sale in this period who also had a completed sale before it.")).toBeInTheDocument();
    expect(screen.getByLabelText("Repeat customers: 1")).toBeInTheDocument();
    expect(screen.getByText("Customers who completed two or more sales in this period.")).toBeInTheDocument();
  });

  it("uses the frozen comparison helper's percentage semantics for a non-zero current value", () => {
    render(<CustomerInsights businessId="business-a" canViewCustomers current={current} previous={previous} />);
    expect(screen.getByText("Up 200% vs previous period")).toBeInTheDocument();
  });

  it("shows the truthful zero-new-customer state instead of a comparison", () => {
    render(<CustomerInsights businessId="business-a" canViewCustomers current={{ ...current, newCustomers: 0 }} previous={previous} />);
    expect(screen.getByText("No new customer records in this period.")).toBeInTheDocument();
  });

  it("shows the truthful zero-returning-customer state instead of a comparison", () => {
    render(<CustomerInsights businessId="business-a" canViewCustomers current={{ ...current, returningCustomers: 0 }} previous={previous} />);
    expect(screen.getByText("No returning customers recorded in this period.")).toBeInTheDocument();
  });

  it("shows the truthful zero-repeat-customer state instead of a comparison", () => {
    render(<CustomerInsights businessId="business-a" canViewCustomers current={{ ...current, repeatCustomers: 0 }} previous={previous} />);
    expect(screen.getByText("No customers completed two or more sales in this period.")).toBeInTheDocument();
  });

  it("never fabricates loyalty, LTV, retention rate, churn, or health-score language", () => {
    render(<CustomerInsights businessId="business-a" canViewCustomers current={current} previous={previous} />);
    expect(screen.queryByText(/loyalty|lifetime value|\bltv\b|retention rate|churn|health score|engagement score|vip/i)).not.toBeInTheDocument();
  });

  it("links to the real business-scoped customers route when the caller can view customers", () => {
    render(<CustomerInsights businessId="business-a" canViewCustomers current={current} previous={previous} />);
    expect(screen.getByRole("link", { name: /view customers/i })).toHaveAttribute("href", "/business-a/customers");
  });

  it("omits the customer drilldown link when the caller lacks customers.view", () => {
    render(<CustomerInsights businessId="business-a" canViewCustomers={false} current={current} previous={previous} />);
    expect(screen.queryByRole("link", { name: /view customers/i })).not.toBeInTheDocument();
  });
});
