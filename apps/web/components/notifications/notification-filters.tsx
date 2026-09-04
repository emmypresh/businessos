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
import { NOTIFICATION_CATEGORY_LABEL, NOTIFICATION_SEVERITY_LABEL } from "@/lib/notifications/constants";

// This feed is a permissionless personal inbox (recipient targeting +
// active membership alone — see lib/notifications/dal.ts's own header
// comment) — these filters never depend on any operational permission,
// mirroring ActivityFilters' own identical independence.
export function NotificationFilters() {
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
        <Label htmlFor="notification-search" className="sr-only">
          Search notifications
        </Label>
        <Input
          id="notification-search"
          placeholder="Search by title or details"
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
          value={searchParams.get("read") ?? "all"}
          onValueChange={(value) => pushParams({ read: value === "all" ? null : value })}
        >
          <SelectTrigger className="w-full min-w-0 sm:w-40" aria-label="Read state">
            <SelectValue placeholder="All">
              {(value: string) =>
                value === "unread" ? "Unread" : value === "read" ? "Read" : "All"
              }
            </SelectValue>
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="all">All</SelectItem>
            <SelectItem value="unread">Unread</SelectItem>
            <SelectItem value="read">Read</SelectItem>
          </SelectContent>
        </Select>

        <Select
          value={searchParams.get("category") ?? "all"}
          onValueChange={(value) => pushParams({ category: value === "all" ? null : value })}
        >
          <SelectTrigger className="w-full min-w-0 sm:w-44" aria-label="Category">
            <SelectValue placeholder="Category">
              {(value: string) =>
                value === "all" || !value
                  ? "All categories"
                  : NOTIFICATION_CATEGORY_LABEL[value as keyof typeof NOTIFICATION_CATEGORY_LABEL] ?? value
              }
            </SelectValue>
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="all">All categories</SelectItem>
            {Object.entries(NOTIFICATION_CATEGORY_LABEL).map(([value, label]) => (
              <SelectItem key={value} value={value}>
                {label}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>

        <Select
          value={searchParams.get("severity") ?? "all"}
          onValueChange={(value) => pushParams({ severity: value === "all" ? null : value })}
        >
          <SelectTrigger className="w-full min-w-0 sm:w-40" aria-label="Severity">
            <SelectValue placeholder="Severity">
              {(value: string) =>
                value === "all" || !value
                  ? "All severities"
                  : NOTIFICATION_SEVERITY_LABEL[value as keyof typeof NOTIFICATION_SEVERITY_LABEL] ?? value
              }
            </SelectValue>
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="all">All severities</SelectItem>
            {Object.entries(NOTIFICATION_SEVERITY_LABEL).map(([value, label]) => (
              <SelectItem key={value} value={value}>
                {label}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </div>
    </div>
  );
}
