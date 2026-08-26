"use client";

import { useState, useTransition } from "react";
import { Button } from "@/components/ui/button";
import { revealMovementCost } from "@/lib/inventory/actions";

export function CostCell({ businessId, ledgerId }: { businessId: string; ledgerId: string }) {
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
  return <span>{revealed.toFixed(2)}</span>;
}
