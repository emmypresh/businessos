import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import type { PlatformBusinessOverview } from "@/lib/platform/business-operations-dal";

// Compact status rows, not alarmist — restrained severity values only
// (OK/INFO/WARNING), per phase instruction #32. Severity is never
// conveyed by color alone: the badge text itself always carries the
// severity word (accessibility instruction #45, "diagnostic state not
// color-only").
const SEVERITY_VARIANT: Record<string, "default" | "outline" | "destructive"> = {
  OK: "default",
  INFO: "outline",
  WARNING: "destructive",
};

export function DiagnosticsTab({ overview }: { overview: PlatformBusinessOverview }) {
  return (
    <Card>
      <CardHeader>
        <CardTitle>Diagnostics</CardTitle>
      </CardHeader>
      <CardContent>
        <ul className="flex flex-col gap-2">
          {overview.diagnostics.map((diagnostic) => (
            <li
              key={diagnostic.code}
              className="flex items-center justify-between gap-3 rounded-md border p-3 text-sm"
            >
              <span>{diagnostic.message}</span>
              <Badge variant={SEVERITY_VARIANT[diagnostic.severity] ?? "outline"}>
                {diagnostic.severity}
              </Badge>
            </li>
          ))}
        </ul>
      </CardContent>
    </Card>
  );
}
