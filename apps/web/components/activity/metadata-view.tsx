// Controlled, safe rendering of an audit event's own metadata JSONB blob
// — never a blind JSON.stringify dumped into the page, and never
// dangerouslySetInnerHTML. Known keys get a friendly label; an unknown
// key is still rendered (metadata is already server-validated to be a
// small, bounded, non-secret object — see
// supabase/migrations/20260902090000_create_audit_events.sql's own
// header comment), but as plain escaped text via ordinary JSX
// interpolation, never as markup.
const METADATA_KEY_LABEL: Record<string, string> = {
  total_amount: "Total",
  amount_paid: "Amount paid",
  item_count: "Items",
  refund_amount: "Refund amount",
  reason: "Reason",
  restocked_item_count: "Restocked items",
  amount: "Amount",
  category: "Category",
  method: "Method",
  quantity_delta: "Quantity change",
  movement_type: "Movement type",
  role: "Role",
  branch_count: "Branches",
};

function formatMetadataValue(value: unknown): string {
  if (value === null || value === undefined) return "—";
  if (typeof value === "boolean") return value ? "Yes" : "No";
  return String(value);
}

export function MetadataView({ metadata }: { metadata: Record<string, unknown> | null | undefined }) {
  const entries = Object.entries(metadata ?? {}).filter(([, v]) => v !== null && v !== undefined && v !== "");
  if (entries.length === 0) {
    return <p className="text-sm text-muted-foreground">No additional details.</p>;
  }
  return (
    <dl className="grid grid-cols-2 gap-y-1 text-sm">
      {entries.map(([key, value]) => (
        <div key={key} className="contents">
          <dt className="text-muted-foreground">{METADATA_KEY_LABEL[key] ?? key}</dt>
          <dd className="text-right">{formatMetadataValue(value)}</dd>
        </div>
      ))}
    </dl>
  );
}
