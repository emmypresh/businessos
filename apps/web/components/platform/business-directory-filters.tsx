"use client";

import { useRouter, usePathname, useSearchParams } from "next/navigation";
import { useState, useTransition } from "react";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  SUBSCRIPTION_PLAN_CODE_VALUES,
  SUBSCRIPTION_STATUS_VALUES,
} from "@/lib/validation/platform-businesses";

const SORT_OPTIONS = [
  { value: "created_at", label: "Newest" },
  { value: "name", label: "Business name" },
  { value: "member_count", label: "Member count" },
  { value: "branch_count", label: "Branch count" },
] as const;

export function BusinessDirectoryFilters() {
  const router = useRouter();
  const pathname = usePathname();
  const searchParams = useSearchParams();
  const [search, setSearch] = useState(searchParams.get("q") ?? "");
  const [, startTransition] = useTransition();

  const hasFilters =
    searchParams.get("q") ||
    searchParams.get("country") ||
    searchParams.get("currency") ||
    searchParams.get("plan") ||
    searchParams.get("status");

  function pushParams(next: Record<string, string | null>) {
    const params = new URLSearchParams(searchParams.toString());
    for (const [key, value] of Object.entries(next)) {
      if (value) params.set(key, value);
      else params.delete(key);
    }
    params.delete("page"); // any filter/sort change resets pagination
    startTransition(() => {
      router.push(`${pathname}?${params.toString()}`);
    });
  }

  function clearAll() {
    setSearch("");
    startTransition(() => {
      router.push(pathname);
    });
  }

  return (
    <div className="flex flex-col gap-3">
      <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:flex-wrap">
        <label htmlFor="business-search" className="sr-only">
          Search businesses by name or slug
        </label>
        <Input
          id="business-search"
          placeholder="Search by business name or slug"
          value={search}
          maxLength={200}
          onChange={(e) => {
            setSearch(e.target.value);
            pushParams({ q: e.target.value || null });
          }}
          className="sm:max-w-xs"
        />

        <label htmlFor="business-plan-filter" className="sr-only">
          Filter by subscription plan
        </label>
        <Select
          value={searchParams.get("plan") ?? "all"}
          onValueChange={(value) => pushParams({ plan: value === "all" ? null : value })}
        >
          <SelectTrigger id="business-plan-filter" className="sm:w-40">
            <SelectValue placeholder="Plan" />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="all">All plans</SelectItem>
            {SUBSCRIPTION_PLAN_CODE_VALUES.map((plan) => (
              <SelectItem key={plan} value={plan}>
                {plan}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>

        <label htmlFor="business-status-filter" className="sr-only">
          Filter by subscription status
        </label>
        <Select
          value={searchParams.get("status") ?? "all"}
          onValueChange={(value) => pushParams({ status: value === "all" ? null : value })}
        >
          <SelectTrigger id="business-status-filter" className="sm:w-44">
            <SelectValue placeholder="Subscription status" />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="all">All subscription statuses</SelectItem>
            {SUBSCRIPTION_STATUS_VALUES.map((status) => (
              <SelectItem key={status} value={status}>
                {status.replace("_", " ")}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>

        <label htmlFor="business-sort" className="sr-only">
          Sort businesses
        </label>
        <Select
          value={searchParams.get("sort") ?? "created_at"}
          onValueChange={(value) => pushParams({ sort: value })}
        >
          <SelectTrigger id="business-sort" className="sm:w-40">
            <SelectValue placeholder="Sort" />
          </SelectTrigger>
          <SelectContent>
            {SORT_OPTIONS.map((option) => (
              <SelectItem key={option.value} value={option.value}>
                {option.label}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>

        <Button
          type="button"
          variant="outline"
          size="sm"
          onClick={() =>
            pushParams({ dir: (searchParams.get("dir") ?? "desc") === "desc" ? "asc" : "desc" })
          }
        >
          {(searchParams.get("dir") ?? "desc") === "desc" ? "Descending" : "Ascending"}
        </Button>

        {hasFilters ? (
          <Button type="button" variant="ghost" size="sm" onClick={clearAll}>
            Clear filters
          </Button>
        ) : null}
      </div>
    </div>
  );
}
