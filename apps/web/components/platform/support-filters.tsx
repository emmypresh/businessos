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

export function SupportFilters() {
  const router = useRouter();
  const pathname = usePathname();
  const searchParams = useSearchParams();
  const [search, setSearch] = useState(searchParams.get("q") ?? "");
  const [, startTransition] = useTransition();

  const hasFilters = searchParams.get("q") || searchParams.get("severity");

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
      <label htmlFor="support-search" className="sr-only">
        Search by business name
      </label>
      <Input
        id="support-search"
        placeholder="Search by business name"
        value={search}
        maxLength={200}
        onChange={(e) => {
          setSearch(e.target.value);
          pushParams({ q: e.target.value || null });
        }}
        className="sm:max-w-xs"
      />

      <label htmlFor="support-severity-filter" className="sr-only">
        Filter by severity
      </label>
      <Select
        value={searchParams.get("severity") ?? "all"}
        onValueChange={(value) => pushParams({ severity: value === "all" ? null : value })}
      >
        <SelectTrigger id="support-severity-filter" className="sm:w-40">
          <SelectValue placeholder="Severity" />
        </SelectTrigger>
        <SelectContent>
          <SelectItem value="all">All severities</SelectItem>
          <SelectItem value="WARNING">Warning</SelectItem>
          <SelectItem value="INFO">Info</SelectItem>
        </SelectContent>
      </Select>

      {hasFilters ? (
        <Button type="button" variant="ghost" size="sm" onClick={clearAll}>
          Clear filters
        </Button>
      ) : null}
    </div>
  );
}
