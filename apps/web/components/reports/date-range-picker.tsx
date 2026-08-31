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
    <div className="flex flex-col gap-2">
      <div className="flex flex-col gap-3 sm:flex-row sm:items-center">
        {branches.length > 0 ? (
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
        ) : null}
        <Select value={preset} onValueChange={(value) => pushParams({ preset: value })}>
          <SelectTrigger className="sm:w-48">
            <SelectValue placeholder="Date range" />
          </SelectTrigger>
          <SelectContent>
            {Object.values(REPORT_RANGE_PRESET).map((value) => (
              <SelectItem key={value} value={value}>
                {REPORT_RANGE_PRESET_LABEL[value]}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        {preset === REPORT_RANGE_PRESET.CUSTOM ? (
          <>
            <Input
              type="date"
              aria-label="From date"
              value={searchParams.get("dateFrom") ?? ""}
              onChange={(e) => pushParams({ dateFrom: e.target.value || null })}
              className="sm:w-40"
            />
            <Input
              type="date"
              aria-label="To date"
              value={searchParams.get("dateTo") ?? ""}
              onChange={(e) => pushParams({ dateTo: e.target.value || null })}
              className="sm:w-40"
            />
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
