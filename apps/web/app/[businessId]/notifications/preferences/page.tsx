import { getBusinessMembership } from "@/lib/business/dal";
import { getNotificationPreferences } from "@/lib/notifications/dal";
import { SUPPORTED_NOTIFICATION_TYPES } from "@/lib/notifications/constants";
import { PageHeader } from "@/components/dashboard/page-header";
import { PreferencesForm, type PreferenceState } from "@/components/notifications/preferences-form";

export default async function NotificationPreferencesPage({
  params,
}: PageProps<"/[businessId]/notifications/preferences">) {
  const { businessId } = await params;

  // Same permissionless, active-member-only gate as the feed itself —
  // never any operational permission (see lib/notifications/dal.ts's own
  // header comment).
  await getBusinessMembership(businessId);

  const stored = await getNotificationPreferences(businessId);
  const storedByType = new Map(stored.map((p) => [p.notificationType, p.inAppEnabled]));

  // A MISSING row means enabled — this is where that DB-level contract
  // (see 20260903080200_create_notification_preferences.sql's own header
  // comment) becomes a concrete default for the UI, and ONLY for the
  // fixed set of types this round actually supports — never every type
  // the regex-validated column could theoretically hold.
  const initialPreferences: PreferenceState = Object.fromEntries(
    SUPPORTED_NOTIFICATION_TYPES.map((type) => [type, storedByType.get(type) ?? true])
  );

  return (
    <div className="flex flex-col gap-6">
      <PageHeader
        title="Notification preferences"
        description="Choose which in-app notifications you want to receive for this business."
      />
      <PreferencesForm businessId={businessId} initialPreferences={initialPreferences} />
    </div>
  );
}
