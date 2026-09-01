"use client";

import { useRouter, usePathname, useSearchParams } from "next/navigation";
import { useState, useTransition } from "react";
import { Input } from "@/components/ui/input";

/** A minimal search-only filter — mirrors components/invoices/invoice-filters.tsx's
 * own search-input pattern, trimmed to just this one field (the payment
 * history surface has no status/branch filter of its own). */
export function PaymentHistorySearch() {
  const router = useRouter();
  const pathname = usePathname();
  const searchParams = useSearchParams();
  const [search, setSearch] = useState(searchParams.get("search") ?? "");
  const [, startTransition] = useTransition();

  return (
    <Input
      placeholder="Search by invoice # or customer"
      value={search}
      onChange={(e) => {
        const value = e.target.value;
        setSearch(value);
        const params = new URLSearchParams(searchParams.toString());
        if (value) params.set("search", value);
        else params.delete("search");
        startTransition(() => {
          router.push(`${pathname}?${params.toString()}`);
        });
      }}
      className="sm:max-w-xs"
    />
  );
}
