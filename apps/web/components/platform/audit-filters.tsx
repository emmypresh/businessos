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
import { PLATFORM_ACTION_TYPE_VALUES } from "@/lib/validation/platform-audit";

const ACTION_TYPE_LABEL: Record<string, string> = {
  SUSPEND_BUSINESS: "Suspended business",
  REACTIVATE_BUSINESS: "Reactivated business",
  EXTEND_TRIAL: "Extended trial",
};

export function AuditFilters() {
  const router = useRouter();
  const pathname = usePathname();
  const searchParams = useSearchParams();
  const [search, setSearch] = useState(searchParams.get("q") ?? "");
  const [, startTransition] = useTransition();

  const hasFilters =
    searchParams.get("q") || searchParams.get("actionType") || searchParams.get("dateFrom") || searchParams.get("dateTo");

  function pushParams(next: Record<string, string | null>) {
    const params = new URLSearchParams(searchParams.toString());
    for (const [key, value] of Object.entries(next)) {
      if (value) params.set(key, value);
      else params.delete(key);
    }
    params.delete("page");
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
    <div className="flex flex-col gap-3 sm:flex-row sm:flex-wrap sm:items-center">
      <label htmlFor="audit-search" className="sr-only">
        Search by target business name
      </label>
      <Input
        id="audit-search"
        placeholder="Search by business name"
        value={search}
        maxLength={200}
        onChange={(e) => {
          setSearch(e.target.value);
          pushParams({ q: e.target.value || null });
        }}
        className="sm:max-w-xs"
      />

      <label htmlFor="audit-action-type" className="sr-only">
        Filter by action type
      </label>
      <Select
        value={searchParams.get("actionType") ?? "all"}
        onValueChange={(value) => pushParams({ actionType: value === "all" ? null : value })}
      >
        <SelectTrigger id="audit-action-type" className="sm:w-52">
          <SelectValue placeholder="Action type" />
        </SelectTrigger>
        <SelectContent>
          <SelectItem value="all">All action types</SelectItem>
          {PLATFORM_ACTION_TYPE_VALUES.map((type) => (
            <SelectItem key={type} value={type}>
              {ACTION_TYPE_LABEL[type]}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>

      <label htmlFor="audit-date-from" className="sr-only">
        From date
      </label>
      <Input
        id="audit-date-from"
        type="date"
        value={searchParams.get("dateFrom") ?? ""}
        onChange={(e) => pushParams({ dateFrom: e.target.value || null })}
        className="sm:w-40"
      />

      <label htmlFor="audit-date-to" className="sr-only">
        To date
      </label>
      <Input
        id="audit-date-to"
        type="date"
        value={searchParams.get("dateTo") ?? ""}
        onChange={(e) => pushParams({ dateTo: e.target.value || null })}
        className="sm:w-40"
      />

      {hasFilters ? (
        <Button type="button" variant="ghost" size="sm" onClick={clearAll}>
          Clear filters
        </Button>
      ) : null}
    </div>
  );
}
