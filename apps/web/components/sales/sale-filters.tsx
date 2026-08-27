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

export function SaleFilters() {
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
    </div>
  );
}
