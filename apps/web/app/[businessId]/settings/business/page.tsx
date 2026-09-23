import { notFound } from "next/navigation";
import { requirePermissionOrNotFound, getBusinessDetails } from "@/lib/business/dal";
import { PERMISSION } from "@/lib/business/constants";
import { getCountryMetadata, getCurrencyDisplayName } from "@/lib/business/country-currency";
import { getTimezoneOptionsForCountry } from "@/lib/business/timezone-catalog";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { BusinessTimezoneForm } from "@/components/settings/business-timezone-form";

// business.manage (OWNER/ADMIN, per the seeded Phase 1 matrix — see
// lib/business/constants.ts's own PERMISSION.BUSINESS_MANAGE comment)
// gates this entire page, both view and edit — there is no separate
// "view" permission for a business's own identity settings the way
// billing.view/billing.manage split, so this page is administrator-only
// end to end, matching the phase brief's "only appropriate business
// administrators" instruction.
//
// Country and base currency are READ-ONLY here by deliberate product
// policy (see the phase brief's Currency/Country Editability sections):
// changing a business's base currency or country after it has
// transactional data is an accounting problem this phase does not solve.
// Only timezone is editable — updateBusinessTimezone
// (lib/business/actions.ts) independently re-checks business.manage
// itself, so this page's own gate is a courtesy, never the security
// boundary.
export default async function BusinessSettingsPage({ params }: PageProps<"/[businessId]/settings/business">) {
  const { businessId } = await params;
  await requirePermissionOrNotFound(businessId, PERMISSION.BUSINESS_MANAGE);

  const business = await getBusinessDetails(businessId);
  if (!business) {
    notFound();
  }

  const countryMetadata = getCountryMetadata(business.country_code);
  const timezoneOptions = getTimezoneOptionsForCountry(business.country_code);

  return (
    <div className="flex flex-col gap-6">
      <div>
        <h1 className="text-2xl font-semibold tracking-tight">Business</h1>
        <p className="text-sm text-muted-foreground">Country, currency, and timezone for this business.</p>
      </div>

      <Card>
        <CardHeader>
          <CardTitle>Country &amp; currency</CardTitle>
          <CardDescription>Set when the business was created. These can&apos;t be changed here.</CardDescription>
        </CardHeader>
        <CardContent className="flex flex-col gap-3 text-sm">
          <div>
            <p className="text-muted-foreground">Country</p>
            <p className="font-medium">
              {countryMetadata?.countryName ?? business.country_code} <span className="text-muted-foreground">({business.country_code})</span>
            </p>
          </div>
          <div>
            <p className="text-muted-foreground">Base currency</p>
            <p className="font-medium">
              {getCurrencyDisplayName(business.currency_code)}{" "}
              <span className="text-muted-foreground">({business.currency_code})</span>
            </p>
          </div>
          <p className="text-muted-foreground">
            Base currency is set when the business is created.
          </p>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Timezone</CardTitle>
          <CardDescription>
            Used for local date display and business-day boundaries. Stored timestamps and reports are
            unaffected.
          </CardDescription>
        </CardHeader>
        <CardContent>
          <BusinessTimezoneForm
            businessId={businessId}
            currentTimezone={business.timezone}
            options={timezoneOptions}
          />
        </CardContent>
      </Card>
    </div>
  );
}
