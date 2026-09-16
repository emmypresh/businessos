import { requirePermissionOrNotFound, hasPermission } from "@/lib/business/dal";
import { PERMISSION } from "@/lib/business/constants";
import { getWhatsappAccount, getWhatsappPhoneNumbers, listWhatsappTemplates } from "@/lib/whatsapp/dal";
import { getWhatsappConfig } from "@/lib/whatsapp/config";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { ConnectWhatsappForm, DisconnectWhatsappForm, SyncTemplatesForm } from "@/components/whatsapp/whatsapp-connection-controls";

// whatsapp.view is this route's own read gate; the connect/disconnect/
// sync controls additionally require whatsapp.manage — mirrors
// app/[businessId]/settings/billing/page.tsx's own identical
// view-vs-manage split exactly. Full Embedded Signup, a conversation
// inbox UI, and a provider-credential paste form are all explicitly
// deferred — see this phase's own final report.
//
// NEVER RENDERED HERE: access token, app secret, verify token — these
// values are environment-only in this interim round and are never even
// read by a Server Component (lib/whatsapp/config.ts is `server-only`
// and this page never imports the raw config values into JSX).
export default async function WhatsappSettingsPage({ params }: PageProps<"/[businessId]/settings/whatsapp">) {
  const { businessId } = await params;
  await requirePermissionOrNotFound(businessId, PERMISSION.WHATSAPP_VIEW);
  const canManage = await hasPermission(businessId, PERMISSION.WHATSAPP_MANAGE);

  const [account, numbers, templates] = await Promise.all([
    getWhatsappAccount(businessId),
    getWhatsappPhoneNumbers(businessId),
    listWhatsappTemplates(businessId),
  ]);

  // A server-side-only presence check (never the token/secret values
  // themselves) — configured() controls whether this environment can
  // connect ANY business at all in this interim round.
  const configured = getWhatsappConfig() !== null;

  return (
    <div className="flex flex-col gap-6">
      <div>
        <h1 className="text-2xl font-semibold tracking-tight">WhatsApp</h1>
        <p className="text-sm text-muted-foreground">Connect your WhatsApp Business number for customer messaging.</p>
      </div>

      {!configured ? (
        <Alert variant="destructive">
          <AlertTitle>WhatsApp provider configuration required</AlertTitle>
          <AlertDescription>
            This environment has no Meta WhatsApp Cloud API configuration yet. Contact an administrator.
          </AlertDescription>
        </Alert>
      ) : null}

      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            Connection
            <Badge variant={account?.status === "CONNECTED" ? "default" : "secondary"}>
              {account?.status ?? "NOT CONFIGURED"}
            </Badge>
          </CardTitle>
          <CardDescription>
            {account?.displayName ?? "No WhatsApp Business Account connected yet."}
          </CardDescription>
        </CardHeader>
        <CardContent className="flex flex-col gap-4">
          {numbers.length > 0 ? (
            <ul className="text-sm text-muted-foreground">
              {numbers.map((n) => (
                <li key={n.id}>
                  {n.displayPhoneNumber} — {n.status}
                  {n.isPrimary ? " (primary)" : ""}
                </li>
              ))}
            </ul>
          ) : null}

          {canManage && configured ? (
            account?.status === "CONNECTED" ? (
              <DisconnectWhatsappForm businessId={businessId} />
            ) : (
              <ConnectWhatsappForm businessId={businessId} />
            )
          ) : null}
        </CardContent>
      </Card>

      {canManage && account?.status === "CONNECTED" ? (
        <Card>
          <CardHeader>
            <CardTitle>Templates</CardTitle>
            <CardDescription>Provider-approved message templates ({templates.length}).</CardDescription>
          </CardHeader>
          <CardContent className="flex flex-col gap-4">
            <ul className="text-sm text-muted-foreground">
              {templates.map((t) => (
                <li key={t.id}>
                  {t.name} ({t.language}) — {t.category} — {t.status}
                </li>
              ))}
            </ul>
            <SyncTemplatesForm businessId={businessId} />
          </CardContent>
        </Card>
      ) : null}
    </div>
  );
}
