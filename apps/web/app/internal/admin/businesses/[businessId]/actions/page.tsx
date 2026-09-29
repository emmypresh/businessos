import type { Metadata } from "next";
import { notFound } from "next/navigation";
import Link from "next/link";
import { requireAnyPlatformPermission, hasPlatformPermission } from "@/lib/platform/dal";
import { PLATFORM_PERMISSION } from "@/lib/platform/constants";
import { getPlatformBusinessActionContext } from "@/lib/platform/business-operations-dal";
import { IdSchema, parsePageParam } from "@/lib/validation/platform-business-operations";
import { ActionsTab } from "@/components/platform/actions-tab";

export const metadata: Metadata = {
  title: "Platform actions — Internal Administration",
};

function toSearchParams(raw: Record<string, string | string[] | undefined>): URLSearchParams {
  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(raw)) {
    if (typeof value === "string") params.set(key, value);
  }
  return params;
}

// Phase 1O-D remediation — the dedicated, narrow action entry point.
//
// QA found that BILLING holds platform.subscriptions.extend_trial but the
// only existing Platform Actions surface (the "?tab=actions" tab on
// /internal/admin/businesses/[businessId]) sits behind that page's own
// shell gate, requirePlatformPermission(BUSINESSES_VIEW) — a permission
// BILLING has never held (1O-A's own role matrix). This route exists so a
// caller with a controlled-action permission but no businesses.view can
// still reach it.
//
// Admission (requireAnyPlatformPermission) requires: authenticated
// identity + active platform admin + AAL2 + at least ONE of
// {platform.businesses.suspend, platform.businesses.reactivate,
// platform.subscriptions.extend_trial}. No tenant-role fallback, no
// client-only check — see lib/platform/dal.ts's own header comment on this
// helper. Route admission is NOT a substitute for per-mutation
// authorization: platform_suspend_business/platform_reactivate_business/
// platform_extend_trial each still independently re-check their own exact
// permission (20261001080000_platform_controlled_actions.sql), so a
// BILLING caller who somehow rendered a Suspend button would still be
// denied by the RPC itself — see ActionsTab's own permission-gated
// rendering, which never shows a disabled/hinted button for an
// unauthorized action, only its absence.
//
// Data comes from get_platform_business_action_context
// (20261002080000_platform_billing_action_access.sql), gated the same way
// as this route (any controlled-action permission, never
// platform.businesses.view) and returning ONLY id/name/status/subscription
// trial state — never members, branches, activity, audit, or diagnostics.
// The existing /internal/admin/businesses/[businessId] support console
// page is untouched by this route and still requires
// platform.businesses.view exactly as before.
export default async function PlatformBusinessActionsPage({
  params,
  searchParams,
}: PageProps<"/internal/admin/businesses/[businessId]/actions">) {
  await requireAnyPlatformPermission([
    PLATFORM_PERMISSION.BUSINESSES_SUSPEND,
    PLATFORM_PERMISSION.BUSINESSES_REACTIVATE,
    PLATFORM_PERMISSION.SUBSCRIPTIONS_EXTEND_TRIAL,
  ]);

  const { businessId } = await params;
  const parsedId = IdSchema.safeParse(businessId);
  if (!parsedId.success) {
    notFound();
  }

  const rawSearchParams = await searchParams;
  const page = parsePageParam(rawSearchParams.page);
  const urlSearchParams = toSearchParams(rawSearchParams);

  // Per-action visibility is re-derived independently here, exactly like
  // the support-console page does — never inferred from route admission
  // (which only proves "at least one"). canViewAudit gates action HISTORY
  // only (platform.audit.view is a wholly separate permission a mutation
  // permission never implies — phase instructions §37 / 1O-D's own
  // migration comment), never businesses.view.
  const [canSuspend, canReactivate, canExtendTrial, canViewAudit] = await Promise.all([
    hasPlatformPermission(PLATFORM_PERMISSION.BUSINESSES_SUSPEND),
    hasPlatformPermission(PLATFORM_PERMISSION.BUSINESSES_REACTIVATE),
    hasPlatformPermission(PLATFORM_PERMISSION.SUBSCRIPTIONS_EXTEND_TRIAL),
    hasPlatformPermission(PLATFORM_PERMISSION.AUDIT_VIEW),
  ]);
  const canViewSupportConsole = await hasPlatformPermission(PLATFORM_PERMISSION.BUSINESSES_VIEW);

  const context = await getPlatformBusinessActionContext(parsedId.data);

  return (
    <div className="flex flex-col gap-6">
      <div>
        <Link
          href={
            canViewSupportConsole
              ? `/internal/admin/businesses/${parsedId.data}?tab=actions`
              : "/internal/admin/actions"
          }
          className="text-sm text-muted-foreground underline-offset-4 hover:underline"
        >
          &larr; {canViewSupportConsole ? "Business detail" : "Find a business"}
        </Link>
        <h2 className="mt-2 text-2xl font-semibold tracking-tight">{context.business_name}</h2>
        <p className="text-sm text-muted-foreground">Platform actions</p>
      </div>

      <ActionsTab
        businessId={parsedId.data}
        overview={context}
        page={page}
        searchParams={urlSearchParams}
        canSuspend={canSuspend}
        canReactivate={canReactivate}
        canExtendTrial={canExtendTrial}
        canViewHistory={canViewAudit}
      />
    </div>
  );
}
