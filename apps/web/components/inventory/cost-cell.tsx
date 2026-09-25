"use client";

import { useState, useTransition } from "react";
import { Button } from "@/components/ui/button";
import { revealMovementCost } from "@/lib/inventory/actions";
import { formatMoney } from "@/lib/currency";

export function CostCell({
  businessId,
  ledgerId,
  currencyCode,
}: {
  businessId: string;
  ledgerId: string;
  // The owning business's own authoritative currency (never editable here,
  // never a new symbol map) — threaded down from the product/business
  // record so a revealed cost never renders as a bare number with no
  // currency identity. Hidden-cost and permission behavior are unchanged;
  // this only affects how an already-revealed amount is displayed.
  currencyCode: string;
}) {
  const [revealed, setRevealed] = useState<number | null | "error">(null);
  const [shown, setShown] = useState(false);
  const [isPending, startTransition] = useTransition();

  if (!shown) {
    return (
      <Button
        type="button"
        variant="ghost"
        size="sm"
        disabled={isPending}
        onClick={() => {
          startTransition(async () => {
            const result = await revealMovementCost(businessId, ledgerId);
            setRevealed("error" in result ? "error" : result.cost);
            setShown(true);
          });
        }}
      >
        {isPending ? "Loading…" : "Show cost"}
      </Button>
    );
  }

  if (revealed === "error") return <span className="text-sm text-destructive">—</span>;
  if (revealed === null) return <span className="text-sm text-muted-foreground">—</span>;
  return <span>{formatMoney(revealed, currencyCode, { display: "symbol" })}</span>;
}
