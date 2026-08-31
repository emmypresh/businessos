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
import { BRANCH_STATUS } from "@/lib/branches/constants";
import { resolveBranchSelectLabel } from "@/lib/branches/select-label";

// Codex adversarial review, application-layer round 2, Blocker 4:
// sales.view is business-wide, so this filter's options are EVERY branch
// of the business (including inactive, for historical filtering) — never
// just the caller's own operational assignment. "All branches" is the
// accurate label for the unfiltered default; "All my branches" would be
// false when the underlying data already spans branches the caller
// doesn't personally operate at.
export function SaleFilters({
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
    params.delete("cursor"); // any filter change resets pagination
    startTransition(() => {
      router.push(`${pathname}?${params.toString()}`);
    });
  }

  return (
    <div className="flex flex-col gap-3 sm:flex-row sm:items-center">
      <Input
        placeholder="Search by sale number"
        value={search}
        onChange={(e) => {
          setSearch(e.target.value);
          pushParams({ search: e.target.value || null });
        }}
        className="sm:max-w-xs"
      />
      <Select
        value={searchParams.get("paymentStatus") ?? "all"}
        onValueChange={(value) => pushParams({ paymentStatus: value === "all" ? null : value })}
      >
        <SelectTrigger className="sm:w-44">
          <SelectValue placeholder="Payment status" />
        </SelectTrigger>
        <SelectContent>
          <SelectItem value="all">All payment statuses</SelectItem>
          <SelectItem value="UNPAID">Unpaid</SelectItem>
          <SelectItem value="PARTIALLY_PAID">Partially paid</SelectItem>
          <SelectItem value="PAID">Paid</SelectItem>
        </SelectContent>
      </Select>
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
      {branches.length > 0 ? (
        <Select
          value={searchParams.get("branch") ?? "all"}
          onValueChange={(value) => pushParams({ branch: value === "all" ? null : value })}
        >
          {/* w-full sm:w-48: never w-fit's unbounded intrinsic sizing —
              see components/products/product-form.tsx's identical
              comment. Codex adversarial review, application-layer round
              2, Blocker 6. */}
          <SelectTrigger className="w-full min-w-0 sm:w-48" aria-label="Branch">
            <SelectValue placeholder="Branch">
              {(value: string) =>
                resolveBranchSelectLabel(value, branches, {
                  sentinels: { all: "All branches" },
                  placeholder: "Branch",
                })
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
