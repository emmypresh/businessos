"use client";

import { useActionState, useId, useState } from "react";
import { updateBusinessTimezone } from "@/lib/business/actions";
import type { TimezoneOption } from "@/lib/business/timezone-catalog";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";

export function BusinessTimezoneForm({
  businessId,
  currentTimezone,
  options,
}: {
  businessId: string;
  currentTimezone: string;
  options: TimezoneOption[];
}) {
  const [state, action, pending] = useActionState(updateBusinessTimezone, undefined);
  const [timezone, setTimezone] = useState(currentTimezone);
  // Codex remediation (Phase 1Q-0B-0B, accessibility LOW finding): the
  // Select trigger previously had no associated label at all — an
  // aria-invalid attribute alone gives no accessible NAME. useId keeps
  // this instance-unique so a page rendering this form twice (it never
  // does today, but nothing prevents it) still has no duplicate ids.
  const timezoneFieldId = useId();

  return (
    <form action={action} className="flex flex-col gap-2">
      <input type="hidden" name="businessId" value={businessId} />
      <input type="hidden" name="timezone" value={timezone} />
      <div className="flex flex-col gap-2 sm:flex-row sm:items-end sm:gap-3">
        <div className="flex w-full flex-col gap-1.5 sm:w-64">
          <Label htmlFor={timezoneFieldId}>Business timezone</Label>
          <Select value={timezone} onValueChange={(v) => setTimezone(v ?? currentTimezone)}>
            <SelectTrigger
              id={timezoneFieldId}
              className="w-full"
              aria-invalid={!!state?.fieldErrors?.timezone}
            >
              <SelectValue placeholder="Choose a timezone" />
            </SelectTrigger>
            <SelectContent>
              {options.map((option) => (
                <SelectItem key={option.value} value={option.value}>
                  {option.label}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
        <Button type="submit" disabled={pending}>
          Save timezone
        </Button>
      </div>
      {state?.fieldErrors?.timezone ? (
        <p role="alert" className="text-sm text-destructive">{state.fieldErrors.timezone[0]}</p>
      ) : null}
      {state?.error ? <p role="alert" className="text-sm text-destructive">{state.error}</p> : null}
      {state?.success ? <p className="text-sm text-muted-foreground">Timezone updated.</p> : null}
    </form>
  );
}
