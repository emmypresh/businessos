import { Badge } from "@/components/ui/badge";
import { getStockState, STOCK_STATE, STOCK_STATE_LABEL } from "@/lib/inventory/stock";

export function StockStateBadge({
  trackInventory,
  quantity,
  lowStockThreshold,
}: {
  trackInventory: boolean;
  quantity: number;
  lowStockThreshold: number | null;
}) {
  const state = getStockState(trackInventory, quantity, lowStockThreshold);

  const variant =
    state === STOCK_STATE.OUT_OF_STOCK
      ? "destructive"
      : state === STOCK_STATE.LOW_STOCK
        ? "secondary"
        : state === STOCK_STATE.NOT_TRACKED
          ? "outline"
          : "default";

  return <Badge variant={variant}>{STOCK_STATE_LABEL[state]}</Badge>;
}
