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
import { SUBSCRIPTION_STATUS_VALUES } from "@/lib/validation/platform-businesses";

export function SubscriptionFilters() {
  const router = useRouter();
  const pathname = usePathname();
  const searchParams = useSearchParams();
  const [search, setSearch] = useState(searchParams.get("q") ?? "");
  const [, startTransition] = useTransition();

  const hasFilters = searchParams.get("q") || searchParams.get("status");

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
      <label htmlFor="subscription-search" className="sr-only">
        Search by business name
      </label>
      <Input
        id="subscription-search"
        placeholder="Search by business name"
        value={search}
        maxLength={200}
        onChange={(e) => {
          setSearch(e.target.value);
          pushParams({ q: e.target.value || null });
        }}
        className="sm:max-w-xs"
      />

      <label htmlFor="subscription-status-filter" className="sr-only">
        Filter by subscription status
      </label>
      <Select
        value={searchParams.get("status") ?? "all"}
        onValueChange={(value) => pushParams({ status: value === "all" ? null : value })}
      >
        <SelectTrigger id="subscription-status-filter" className="sm:w-44">
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

      {hasFilters ? (
        <Button type="button" variant="ghost" size="sm" onClick={clearAll}>
          Clear filters
        </Button>
      ) : null}
    </div>
  );
}
