export const MOVEMENT_TYPE = {
  OPENING_STOCK: "OPENING_STOCK",
  ADJUSTMENT_IN: "ADJUSTMENT_IN",
  ADJUSTMENT_OUT: "ADJUSTMENT_OUT",
} as const;

export type MovementType = (typeof MOVEMENT_TYPE)[keyof typeof MOVEMENT_TYPE];

export const MOVEMENT_TYPE_LABEL: Record<MovementType, string> = {
  [MOVEMENT_TYPE.OPENING_STOCK]: "Opening stock",
  [MOVEMENT_TYPE.ADJUSTMENT_IN]: "Stock increase",
  [MOVEMENT_TYPE.ADJUSTMENT_OUT]: "Stock decrease",
};

// The UI only ever offers these two directions; the raw movement_type
// enum (and the fact that the sign is server-derived, never client-sent)
// is an implementation detail the form never exposes as copy.
export type AdjustmentDirection = "increase" | "decrease";

export function directionToMovementType(direction: AdjustmentDirection): MovementType {
  return direction === "increase" ? MOVEMENT_TYPE.ADJUSTMENT_IN : MOVEMENT_TYPE.ADJUSTMENT_OUT;
}
