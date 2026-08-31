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

export function ExpenseFilters({
  categories,
  branches = [],
}: {
  categories: { id: string; name: string }[];
  branches?: { id: string; name: string }[];
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

  // One combined control, three mutually exclusive states — "all", a
  // specific branch id, or "company-wide only" — rather than two
  // independent filters that could otherwise be set in a contradictory
  // combination (mirrors lib/expenses/dal.ts's own mutually-exclusive
  // branchId/companyWideOnly handling).
  const branchFilterValue = searchParams.get("companyWide") === "1" ? "company-wide" : searchParams.get("branch") ?? "all";
  function onBranchFilterChange(value: string) {
    if (value === "all") {
      pushParams({ branch: null, companyWide: null });
    } else if (value === "company-wide") {
      pushParams({ branch: null, companyWide: "1" });
    } else {
      pushParams({ branch: value, companyWide: null });
    }
  }

  return (
    <div className="flex flex-col gap-3 sm:flex-row sm:flex-wrap sm:items-center">
      <Input
        placeholder="Search by expense #, payee, or reference"
        value={search}
        onChange={(e) => {
          setSearch(e.target.value);
          pushParams({ search: e.target.value || null });
        }}
        className="sm:max-w-xs"
      />
      <Select
        value={searchParams.get("categoryId") ?? "all"}
        onValueChange={(value) => pushParams({ categoryId: value === "all" ? null : value })}
      >
        <SelectTrigger className="sm:w-44">
          <SelectValue placeholder="Category" />
        </SelectTrigger>
        <SelectContent>
          <SelectItem value="all">All categories</SelectItem>
          {categories.map((category) => (
            <SelectItem key={category.id} value={category.id}>
              {category.name}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
      <Select
        value={searchParams.get("paymentMethod") ?? "all"}
        onValueChange={(value) => pushParams({ paymentMethod: value === "all" ? null : value })}
      >
        <SelectTrigger className="sm:w-44">
          <SelectValue placeholder="Payment method" />
        </SelectTrigger>
        <SelectContent>
          <SelectItem value="all">All payment methods</SelectItem>
          <SelectItem value="CASH">Cash</SelectItem>
          <SelectItem value="BANK_TRANSFER">Bank transfer</SelectItem>
          <SelectItem value="CARD">Card</SelectItem>
          <SelectItem value="OTHER">Other</SelectItem>
        </SelectContent>
      </Select>
      <Select
        value={searchParams.get("status") ?? "all"}
        onValueChange={(value) => pushParams({ status: value === "all" ? null : value })}
      >
        <SelectTrigger className="sm:w-36">
          <SelectValue placeholder="Status" />
        </SelectTrigger>
        <SelectContent>
          <SelectItem value="all">All statuses</SelectItem>
          <SelectItem value="POSTED">Posted</SelectItem>
          <SelectItem value="VOIDED">Voided</SelectItem>
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
        <Select value={branchFilterValue} onValueChange={(value) => onBranchFilterChange(value ?? "all")}>
          {/* w-full sm:w-44: never w-fit's unbounded intrinsic sizing —
              see components/products/product-form.tsx's identical
              comment. Codex adversarial review, application-layer round
              2, Blocker 6. */}
          <SelectTrigger className="w-full min-w-0 sm:w-44" aria-label="Branch">
            <SelectValue placeholder="Branch">
              {(value: string) =>
                resolveBranchSelectLabel(value, branches, {
                  sentinels: { all: "All branches", "company-wide": "Company-wide only" },
                  placeholder: "Branch",
                })
              }
            </SelectValue>
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="all">All branches</SelectItem>
            <SelectItem value="company-wide">Company-wide only</SelectItem>
            {branches.map((branch) => (
              <SelectItem key={branch.id} value={branch.id} className="max-w-full">
                <span className="truncate">{branch.name}</span>
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      ) : null}
    </div>
  );
}
