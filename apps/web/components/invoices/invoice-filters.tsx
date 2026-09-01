"use client";

import { useRouter, usePathname, useSearchParams } from "next/navigation";
import { useState, useTransition } from "react";
import { Input } from "@/components/ui/input";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { resolveBranchSelectLabel } from "@/lib/branches/select-label";
import { BRANCH_STATUS } from "@/lib/branches/constants";
import { INVOICE_STATUS_LABEL } from "@/lib/invoices/constants";

// Codex adversarial review round 4 (Phase 1H): invoices.view is
// business-wide, so this filter's branch options are EVERY branch of the
// business (including inactive, for historical filtering) — never just
// the caller's own operational assignment. Mirrors sale-filters.tsx's
// own identical "All branches" (never "All my branches") reasoning.
export function InvoiceFilters({
  branches = [],
}: {
  branches?: { id: string; name: string; status: string }[];
}) {
  const router = useRouter();
  const pathname = usePathname();
  const searchParams = useSearchParams();
  const [search, setSearch] = useState(searchParams.get("search") ?? "");
  const [, startTransition] = useTransition();

  function pushParams(next: Record<string, string | null>) {
    const params = new URLSearchParams(searchParams.toString());
    for (const [key, value] of Object.entries(next)) {
      if (value) params.set(key, value);
      else params.delete(key);
    }
    params.delete("cursor");
    startTransition(() => {
      router.push(`${pathname}?${params.toString()}`);
    });
  }

  return (
    <div className="flex flex-col gap-3 sm:flex-row sm:flex-wrap sm:items-center">
      <Input
        placeholder="Search by invoice # or customer"
        value={search}
        onChange={(e) => {
          setSearch(e.target.value);
          pushParams({ search: e.target.value || null });
        }}
        className="sm:max-w-xs"
      />
      <Select
        value={searchParams.get("status") ?? "all"}
        onValueChange={(value) => pushParams({ status: value === "all" ? null : value })}
      >
        <SelectTrigger className="w-full min-w-0 sm:w-44">
          <SelectValue placeholder="Status">
            {(value: string) =>
              value === "all" || !value ? "All statuses" : INVOICE_STATUS_LABEL[value as keyof typeof INVOICE_STATUS_LABEL] ?? value
            }
          </SelectValue>
        </SelectTrigger>
        <SelectContent>
          <SelectItem value="all">All statuses</SelectItem>
          {Object.entries(INVOICE_STATUS_LABEL).map(([value, label]) => (
            <SelectItem key={value} value={value}>
              {label}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
      {branches.length > 0 ? (
        <Select
          value={searchParams.get("branch") ?? "all"}
          onValueChange={(value) => pushParams({ branch: value === "all" ? null : value })}
        >
          {/* w-full sm:w-48: never w-fit's unbounded intrinsic sizing —
              a 100-character branch name must not force this control (or
              the page) wider than the viewport. */}
          <SelectTrigger className="w-full min-w-0 sm:w-48" aria-label="Branch">
            <SelectValue placeholder="Branch">
              {(value: string) =>
                resolveBranchSelectLabel(value, branches, { sentinels: { all: "All branches" }, placeholder: "Branch" })
              }
            </SelectValue>
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="all">All branches</SelectItem>
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
    </div>
  );
}
