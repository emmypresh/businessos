"use client";

import { useRouter, usePathname, useSearchParams } from "next/navigation";
import { useState, useTransition } from "react";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { AUDIT_CATEGORY_LABEL } from "@/lib/audit/constants";
import { BRANCH_STATUS } from "@/lib/branches/constants";
import { resolveBranchSelectLabel } from "@/lib/branches/select-label";
import type { ActivityActorOption } from "@/lib/audit/dal";

// audit.view is business-wide and does NOT depend on branches.view or
// staff.view — branch/actor options here are resolved by the page from
// audit.view-gated sources alone (see lib/audit/dal.ts's own header
// comments on getActivityBranchOptions/getActivityActorOptions); this
// component never independently re-checks either permission.
export function ActivityFilters({
  branches = [],
  actors = [],
}: {
  branches?: { id: string; name: string; status: string }[];
  actors?: ActivityActorOption[];
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
    <div className="flex flex-col gap-3">
      <div className="relative">
        <Label htmlFor="activity-search" className="sr-only">
          Search activity
        </Label>
        <Input
          id="activity-search"
          placeholder="Search by action, resource, or person"
          value={search}
          onChange={(e) => {
            setSearch(e.target.value);
            pushParams({ search: e.target.value || null });
          }}
          className="sm:max-w-sm"
        />
      </div>

      <div className="flex flex-col gap-3 sm:flex-row sm:flex-wrap sm:items-center">
        <Select
          value={searchParams.get("category") ?? "all"}
          onValueChange={(value) => pushParams({ category: value === "all" ? null : value })}
        >
          <SelectTrigger className="w-full min-w-0 sm:w-44" aria-label="Category">
            <SelectValue placeholder="Category">
              {(value: string) =>
                value === "all" || !value ? "All categories" : AUDIT_CATEGORY_LABEL[value as keyof typeof AUDIT_CATEGORY_LABEL] ?? value
              }
            </SelectValue>
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="all">All categories</SelectItem>
            {Object.entries(AUDIT_CATEGORY_LABEL).map(([value, label]) => (
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

        {actors.length > 0 ? (
          <Select
            value={searchParams.get("actor") ?? "all"}
            onValueChange={(value) => pushParams({ actor: value === "all" ? null : value })}
          >
            <SelectTrigger className="w-full min-w-0 sm:w-48" aria-label="Actor">
              <SelectValue placeholder="Person">
                {(value: string) => {
                  if (value === "all" || !value) return "All people";
                  const actor = actors.find((a) => a.userId === value);
                  return actor?.name ?? actor?.email ?? "Person";
                }}
              </SelectValue>
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="all">All people</SelectItem>
              {actors.map((actor) => (
                <SelectItem key={actor.userId} value={actor.userId} className="max-w-full">
                  <span className="truncate">{actor.name ?? actor.email ?? actor.userId}</span>
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        ) : null}

        <div className="flex items-center gap-2">
          <Label htmlFor="activity-date-from" className="text-sm text-muted-foreground">
            From
          </Label>
          <Input
            id="activity-date-from"
            type="date"
            className="w-auto"
            value={searchParams.get("from") ?? ""}
            onChange={(e) => pushParams({ from: e.target.value || null })}
          />
          <Label htmlFor="activity-date-to" className="text-sm text-muted-foreground">
            To
          </Label>
          <Input
            id="activity-date-to"
            type="date"
            className="w-auto"
            value={searchParams.get("to") ?? ""}
            onChange={(e) => pushParams({ to: e.target.value || null })}
          />
        </div>
      </div>
    </div>
  );
}
