"use client";

import { useState, useTransition } from "react";
import { Checkbox } from "@/components/ui/checkbox";
import { Label } from "@/components/ui/label";
import { updateNotificationPreferenceAction } from "@/lib/notifications/actions";
import { NOTIFICATION_TYPE_LABEL, SUPPORTED_NOTIFICATION_TYPES } from "@/lib/notifications/constants";

export type PreferenceState = Record<string, boolean>;

// A MISSING row means enabled — this component's own initial state
// already reflects that (the page passes `true` as the default for any
// type with no stored row; see app/[businessId]/notifications/
// preferences/page.tsx), so this component itself never has to reason
// about "missing vs. explicit" — only "on vs. off".
export function PreferencesForm({
  businessId,
  initialPreferences,
}: {
  businessId: string;
  initialPreferences: PreferenceState;
}) {
  const [preferences, setPreferences] = useState(initialPreferences);
  const [pendingType, startTransition] = useTransition();
  const [savedType, setSavedType] = useState<string | null>(null);

  function toggle(notificationType: string, nextValue: boolean) {
    setPreferences((prev) => ({ ...prev, [notificationType]: nextValue }));
    setSavedType(null);
    startTransition(async () => {
      const result = await updateNotificationPreferenceAction(businessId, {
        notificationType,
        inAppEnabled: nextValue,
      });
      if (result?.error) {
        // Revert on failure — the server is the source of truth.
        setPreferences((prev) => ({ ...prev, [notificationType]: !nextValue }));
      } else {
        setSavedType(notificationType);
      }
    });
  }

  return (
    <div className="flex flex-col divide-y divide-border rounded-lg border" data-testid="notification-preferences-form">
      {SUPPORTED_NOTIFICATION_TYPES.map((type) => {
        const enabled = preferences[type] ?? true;
        return (
          <div key={type} className="flex items-center justify-between gap-4 p-4">
            <Label htmlFor={`pref-${type}`} className="flex-1 text-sm font-medium">
              {NOTIFICATION_TYPE_LABEL[type] ?? type}
            </Label>
            <div className="flex items-center gap-2">
              {savedType === type ? <span className="text-xs text-muted-foreground">Saved</span> : null}
              <Checkbox
                id={`pref-${type}`}
                checked={enabled}
                disabled={pendingType}
                onCheckedChange={(checked) => toggle(type, checked === true)}
                aria-label={`In-app notifications for ${NOTIFICATION_TYPE_LABEL[type] ?? type}`}
                data-testid={`notification-preference-${type}`}
              />
            </div>
          </div>
        );
      })}
    </div>
  );
}
