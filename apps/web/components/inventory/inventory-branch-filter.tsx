"use client";

import { useRouter, usePathname, useSearchParams } from "next/navigation";
import { useTransition } from "react";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { resolveBranchSelectLabel } from "@/lib/branches/select-label";

/**
 * Phase 1G — the inventory overview's branch filter. URL-driven (never
 * client-only state), so a refresh, a shared link, or the back button all
 * land on the exact same filtered view — mirrors
 * components/sales/sale-filters.tsx's own pushParams pattern exactly.
 *
 * Codex adversarial review, application-layer round 2, Blocker 3/4:
 * options are the BUSINESS-WIDE active branch list (inventory.view is a
 * business-wide read permission, never gated on the caller's own
 * operational assignment) — "All branches" is the accurate, honest label
 * for the unfiltered default, since the data really is business-wide.
 */
export function InventoryBranchFilter({
  branches,
  allLabel,
}: {
  branches: { id: string; name: string }[];
  allLabel: string;
}) {
  const router = useRouter();
  const pathname = usePathname();
  const searchParams = useSearchParams();
  const [, startTransition] = useTransition();

  const current = searchParams.get("branch") ?? "";

  function onChange(value: string) {
    const params = new URLSearchParams(searchParams.toString());
    if (value) params.set("branch", value);
    else params.delete("branch");
    params.delete("cursor");
    startTransition(() => {
      router.push(`${pathname}?${params.toString()}`);
    });
  }

  if (branches.length === 0) return null;

  return (
    // w-full sm:w-56: fills the available (shrinkable) width on mobile —
    // never w-fit's own unbounded intrinsic sizing, which a
    // 100-character branch name would otherwise force wider than the
    // viewport — and settles to a fixed, predictable width from sm: up.
    // Codex adversarial review, application-layer round 2, Blocker 6.
    <Select value={current || "all"} onValueChange={(v) => onChange(v === "all" ? "" : (v ?? ""))}>
      <SelectTrigger className="w-full min-w-0 sm:w-56" aria-label="Branch">
        <SelectValue placeholder={allLabel}>
          {(value: string) => resolveBranchSelectLabel(value, branches, { sentinels: { all: allLabel }, placeholder: allLabel })}
        </SelectValue>
      </SelectTrigger>
      <SelectContent>
        <SelectItem value="all">{allLabel}</SelectItem>
        {branches.map((branch) => (
          <SelectItem key={branch.id} value={branch.id} className="max-w-full">
            <span className="truncate">{branch.name}</span>
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  );
}
