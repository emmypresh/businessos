// Client-safe (no "server-only") — imported directly by every
// branch-bearing Select in the app to resolve its CLOSED trigger's
// displayed label.
//
// Codex adversarial review, application-layer round 3, Medium 2: this
// project's Select primitive (@base-ui/react/select, wrapped in
// components/ui/select.tsx) does NOT automatically derive a selected
// trigger's displayed text from its matching <SelectItem>'s own rendered
// children, the way this codebase's prior Radix-based mental model would
// suggest. Base UI's own SelectValue only resolves a label from an
// explicit `items` array/record passed to <Select>, an `itemToStringLabel`
// callback, or a `children` render-function passed to <SelectValue> itself
// (see @base-ui/react's resolveValueLabel.mjs — resolveSelectedLabel falls
// back to stringifying the raw controlled `value` when none of those are
// present). Every branch Select in this app controls its value as the
// branch's id, so without one of those three escape hatches the trigger
// displayed a raw UUID instead of the branch's name. This helper is the
// one shared `children` render-function every branch Select now passes to
// its own <SelectValue> — never a raw UUID, and never the stored branch
// name altered or truncated at the data layer.
export function resolveBranchSelectLabel(
  value: string | null | undefined,
  branches: { id: string; name: string }[],
  options: { sentinels?: Record<string, string>; placeholder?: string } = {}
): string {
  if (!value) return options.placeholder ?? "";
  if (options.sentinels && value in options.sentinels) {
    return options.sentinels[value];
  }
  const match = branches.find((b) => b.id === value);
  // Unreachable in practice: every value a branch Select can ever hold
  // comes from either `options.sentinels` or `branches` itself — the
  // exact same list used to render its own <SelectItem>s, so a real value
  // with no matching label would mean the Select's own state diverged
  // from its own option set. Falling back to an empty string (never the
  // raw id/value) is a deliberate, defensive floor: a branch control must
  // never show a bare UUID to a user, even in a state that should be
  // impossible today.
  return match?.name ?? "";
}
