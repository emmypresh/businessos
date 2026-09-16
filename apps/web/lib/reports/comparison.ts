export type ComparisonState = "increase" | "decrease" | "unchanged" | "no-prior-data" | "no-activity" | "unavailable";

export type Comparison = {
  state: ComparisonState;
  percentage: number | null;
  label: string;
};

/**
 * Formats a current-vs-previous comparison without treating a zero prior
 * value as a mathematical percentage. Percentages use abs(previous) as the
 * denominator so negative, authoritative financial values remain finite and
 * direction describes the numeric change rather than a colour convention.
 */
export function formatComparison(current: number | null | undefined, previous: number | null | undefined): Comparison {
  if (current == null || previous == null || !Number.isFinite(current) || !Number.isFinite(previous)) {
    return { state: "unavailable", percentage: null, label: "No comparison data" };
  }
  if (current === 0 && previous === 0) {
    return { state: "no-activity", percentage: null, label: "No activity in either period" };
  }
  if (previous === 0) {
    return { state: "no-prior-data", percentage: null, label: "No prior data" };
  }

  const percentage = ((current - previous) / Math.abs(previous)) * 100;
  if (!Number.isFinite(percentage)) {
    return { state: "unavailable", percentage: null, label: "No comparison data" };
  }
  if (percentage === 0) {
    return { state: "unchanged", percentage: 0, label: "No change vs previous period" };
  }

  const direction = percentage > 0 ? "Up" : "Down";
  return {
    state: percentage > 0 ? "increase" : "decrease",
    percentage,
    label: `${direction} ${new Intl.NumberFormat("en", { maximumFractionDigits: 1 }).format(Math.abs(percentage))}% vs previous period`,
  };
}
