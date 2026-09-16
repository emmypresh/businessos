import Link from "next/link";
import { ArrowUpRight } from "lucide-react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { formatComparison } from "@/lib/reports/comparison";
import type { ManagementReportingAggregate } from "@/lib/reports/dal";

type CustomerSummary = ManagementReportingAggregate["customerSummary"];

type Props = {
  businessId: string;
  canViewCustomers: boolean;
  current: CustomerSummary;
  previous: CustomerSummary;
};

/**
 * Text only reflects the three frozen customer-aggregate definitions
 * (get_management_reporting_aggregate, 20260916090000_management_reporting_aggregates.sql).
 * No retention/churn/LTV/loyalty/health-score language is introduced —
 * those metrics do not exist in the aggregate.
 */
function CustomerMetricRow({ label, definition, zeroText, current, previous }: { label: string; definition: string; zeroText: string; current: number; previous: number }) {
  const comparison = formatComparison(current, previous);
  return (
    <div className="border-t py-3 first:border-t-0 first:pt-0">
      <div className="flex items-baseline justify-between gap-4">
        <p className="text-sm font-medium">{label}</p>
        <p className="text-lg font-semibold tabular-nums" aria-label={`${label}: ${current}`}>{current}</p>
      </div>
      <p className="mt-1 text-xs text-muted-foreground">{definition}</p>
      <p className="mt-1 text-xs text-muted-foreground">{current === 0 ? zeroText : comparison.label}</p>
    </div>
  );
}

export function CustomerInsights({ businessId, canViewCustomers, current, previous }: Props) {
  return (
    <Card role="region" aria-labelledby="customer-insights-heading">
      <CardHeader>
        <CardTitle id="customer-insights-heading">Customer insights</CardTitle>
        <p className="text-sm text-muted-foreground">Last 30 days (UTC) compared with the immediately preceding 30 days.</p>
      </CardHeader>
      <CardContent>
        <CustomerMetricRow
          label="New customers"
          definition="Customer records created in this period."
          zeroText="No new customer records in this period."
          current={current.newCustomers}
          previous={previous.newCustomers}
        />
        <CustomerMetricRow
          label="Returning customers"
          definition="Customers with a completed sale in this period who also had a completed sale before it."
          zeroText="No returning customers recorded in this period."
          current={current.returningCustomers}
          previous={previous.returningCustomers}
        />
        <CustomerMetricRow
          label="Repeat customers"
          definition="Customers who completed two or more sales in this period."
          zeroText="No customers completed two or more sales in this period."
          current={current.repeatCustomers}
          previous={previous.repeatCustomers}
        />
        {canViewCustomers ? (
          <Link
            href={`/${businessId}/customers`}
            className="mt-3 inline-flex min-h-11 items-center gap-1 text-sm font-medium text-primary hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2"
          >
            View customers <ArrowUpRight className="size-3.5" aria-hidden="true" />
          </Link>
        ) : null}
      </CardContent>
    </Card>
  );
}
