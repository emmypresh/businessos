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
import { MEMBER_ROLE_VALUES, MEMBER_STATUS_VALUES } from "@/lib/validation/platform-business-operations";

const SORT_OPTIONS = [
  { value: "created_at", label: "Newest" },
  { value: "email", label: "Email" },
  { value: "role", label: "Role" },
  { value: "status", label: "Status" },
] as const;

export function MemberFilters() {
  const router = useRouter();
  const pathname = usePathname();
  const searchParams = useSearchParams();
  const [search, setSearch] = useState(searchParams.get("q") ?? "");
  const [, startTransition] = useTransition();

  const hasFilters =
    searchParams.get("q") || searchParams.get("role") || searchParams.get("status");

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
    const params = new URLSearchParams(searchParams.toString());
    const tab = params.get("tab");
    startTransition(() => {
      router.push(tab ? `${pathname}?tab=${tab}` : pathname);
    });
  }

  return (
    <div className="flex flex-col gap-3 sm:flex-row sm:flex-wrap sm:items-center">
      <label htmlFor="member-search" className="sr-only">
        Search members by email
      </label>
      <Input
        id="member-search"
        placeholder="Search by email"
        value={search}
        maxLength={200}
        onChange={(e) => {
          setSearch(e.target.value);
          pushParams({ q: e.target.value || null });
        }}
        className="sm:max-w-xs"
      />

      <label htmlFor="member-role-filter" className="sr-only">
        Filter by role
      </label>
      <Select
        value={searchParams.get("role") ?? "all"}
        onValueChange={(value) => pushParams({ role: value === "all" ? null : value })}
      >
        <SelectTrigger id="member-role-filter" className="sm:w-40">
          <SelectValue placeholder="Role" />
        </SelectTrigger>
        <SelectContent>
          <SelectItem value="all">All roles</SelectItem>
          {MEMBER_ROLE_VALUES.map((role) => (
            <SelectItem key={role} value={role}>
              {role}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>

      <label htmlFor="member-status-filter" className="sr-only">
        Filter by status
      </label>
      <Select
        value={searchParams.get("status") ?? "all"}
        onValueChange={(value) => pushParams({ status: value === "all" ? null : value })}
      >
        <SelectTrigger id="member-status-filter" className="sm:w-40">
          <SelectValue placeholder="Status" />
        </SelectTrigger>
        <SelectContent>
          <SelectItem value="all">All statuses</SelectItem>
          {MEMBER_STATUS_VALUES.map((status) => (
            <SelectItem key={status} value={status}>
              {status}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>

      <label htmlFor="member-sort" className="sr-only">
        Sort members
      </label>
      <Select
        value={searchParams.get("sort") ?? "created_at"}
        onValueChange={(value) => pushParams({ sort: value })}
      >
        <SelectTrigger id="member-sort" className="sm:w-40">
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
  );
}
