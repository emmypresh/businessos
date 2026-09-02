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
import { RETURN_REASON_LABEL } from "@/lib/returns/constants";

// returns.view is business-wide, so this filter's branch options are
// EVERY branch of the business (including inactive, for historical
// filtering) — never just the caller's own operational assignment.
// Mirrors components/invoices/invoice-filters.tsx's own identical
// reasoning.
export function ReturnFilters({
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
        placeholder="Search by return # or sale #"
        value={search}
        onChange={(e) => {
          setSearch(e.target.value);
          pushParams({ search: e.target.value || null });
        }}
        className="sm:max-w-xs"
      />
      <Select
        value={searchParams.get("reason") ?? "all"}
        onValueChange={(value) => pushParams({ reason: value === "all" ? null : value })}
      >
        <SelectTrigger className="w-full min-w-0 sm:w-44">
          <SelectValue placeholder="Reason">
            {(value: string) =>
              value === "all" || !value ? "All reasons" : RETURN_REASON_LABEL[value as keyof typeof RETURN_REASON_LABEL] ?? value
            }
          </SelectValue>
        </SelectTrigger>
        <SelectContent>
          <SelectItem value="all">All reasons</SelectItem>
          {Object.entries(RETURN_REASON_LABEL).map(([value, label]) => (
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
