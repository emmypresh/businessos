"use client";

import { useRouter, usePathname, useSearchParams } from "next/navigation";
import { useTransition } from "react";
import { Input } from "@/components/ui/input";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  REPORT_RANGE_PRESET,
  REPORT_RANGE_PRESET_LABEL,
  REPORT_RANGE_UTC_HELPER_TEXT,
} from "@/lib/reports/constants";
import { BRANCH_STATUS } from "@/lib/branches/constants";
import { resolveBranchSelectLabel } from "@/lib/branches/select-label";

export function DateRangePicker({
  branches = [],
}: {
  branches?: { id: string; name: string; status: string }[];
}) {
  const router = useRouter();
  const pathname = usePathname();
  const searchParams = useSearchParams();
  const [, startTransition] = useTransition();

  const preset = searchParams.get("preset") ?? REPORT_RANGE_PRESET.LAST_30_DAYS;

  function pushParams(next: Record<string, string | null>) {
    const params = new URLSearchParams(searchParams.toString());
    for (const [key, value] of Object.entries(next)) {
      if (value) params.set(key, value);
      else params.delete(key);
    }
    startTransition(() => {
      router.push(`${pathname}?${params.toString()}`);
    });
  }

  return (
    // ArchitectUI-style filter toolbar surface (UI3): a bordered/shadowed
    // card wrapping the same controls, same param names, same validation —
    // purely a presentational grouping so this reads as one toolbar
    // instead of loose inline controls next to the page copy.
    <div className="flex flex-col gap-3 rounded-xl border border-border bg-card p-3 shadow-xs sm:p-4">
      <div className="flex flex-col gap-3 sm:flex-row sm:flex-wrap sm:items-end">
        {branches.length > 0 ? (
          <div className="flex flex-col gap-1">
            <span className="text-xs font-medium text-muted-foreground">Branch</span>
            <Select
              value={searchParams.get("branch") ?? "company-wide"}
              onValueChange={(value) => pushParams({ branch: value === "company-wide" ? null : value })}
            >
              {/* w-full sm:w-56: never w-fit's unbounded intrinsic sizing —
                  see components/products/product-form.tsx's identical
                  comment. Codex adversarial review, application-layer
                  round 2, Blocker 6. */}
              <SelectTrigger className="w-full min-w-0 sm:w-56" aria-label="Branch">
                <SelectValue placeholder="Branch">
                  {(value: string) =>
                    resolveBranchSelectLabel(value, branches, {
                      sentinels: { "company-wide": "Company-wide" },
                      placeholder: "Branch",
                    })
                  }
                </SelectValue>
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="company-wide">Company-wide</SelectItem>
                {branches.map((branch) => (
                  <SelectItem key={branch.id} value={branch.id} className="max-w-full">
                    <span className="truncate">
                      {branch.name}
                      {branch.status === BRANCH_STATUS.INACTIVE ? " (inactive)" : ""}
                    </span>
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
        ) : null}
        <div className="flex flex-col gap-1">
          <span className="text-xs font-medium text-muted-foreground">Date range</span>
          <Select value={preset} onValueChange={(value) => pushParams({ preset: value })}>
            {/* UI4: this project's Select primitive (@base-ui/react/select)
                does NOT derive a closed trigger's displayed text from its
                matching <SelectItem>'s own rendered children — it falls
                back to stringifying the raw controlled value with no
                `children` render-function on <SelectValue> (see
                lib/branches/select-label.ts's own header comment, written
                when this exact bug was first found and fixed for every
                branch Select). This sibling Select was never given the
                same fix: its trigger showed the raw preset id (e.g.
                "last_30_days") instead of "Last 30 days (UTC)" once
                closed — a real, live, visible defect confirmed by manual
                QA, not just an accessible-name gap. `aria-label` here
                fixes the *accessible* name (matching the Branch trigger's
                own aria-label above); the `children` render-function on
                SelectValue below fixes the *visible* text using the exact
                same REPORT_RANGE_PRESET_LABEL map every <SelectItem>
                already renders from. */}
            <SelectTrigger className="sm:w-48" aria-label="Date range">
              <SelectValue placeholder="Date range">
                {(value: string) => REPORT_RANGE_PRESET_LABEL[value as keyof typeof REPORT_RANGE_PRESET_LABEL] ?? "Date range"}
              </SelectValue>
            </SelectTrigger>
            <SelectContent>
              {Object.values(REPORT_RANGE_PRESET).map((value) => (
                <SelectItem key={value} value={value}>
                  {REPORT_RANGE_PRESET_LABEL[value]}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
        {preset === REPORT_RANGE_PRESET.CUSTOM ? (
          <>
            <div className="flex flex-col gap-1">
              <span className="text-xs font-medium text-muted-foreground">From</span>
              <Input
                type="date"
                aria-label="From date"
                value={searchParams.get("dateFrom") ?? ""}
                onChange={(e) => pushParams({ dateFrom: e.target.value || null })}
                className="sm:w-40"
              />
            </div>
            <div className="flex flex-col gap-1">
              <span className="text-xs font-medium text-muted-foreground">To</span>
              <Input
                type="date"
                aria-label="To date"
                value={searchParams.get("dateTo") ?? ""}
                onChange={(e) => pushParams({ dateTo: e.target.value || null })}
                className="sm:w-40"
              />
            </div>
          </>
        ) : null}
      </div>
      {/* Shown regardless of preset — every range on this page (relative
          or custom) is a UTC period; see REPORT_RANGE_UTC_HELPER_TEXT's
          own comment for why this needs to be explicit at all. */}
      <p className="text-xs text-muted-foreground">{REPORT_RANGE_UTC_HELPER_TEXT}</p>
    </div>
  );
}
