"use client";

import { useActionState } from "react";
import { connectWhatsappAccountAction, disconnectWhatsappAccountAction, syncWhatsappTemplatesAction } from "@/lib/whatsapp/actions";
import { Button } from "@/components/ui/button";

// No provider-credential form of any kind here — access token/app
// secret/verify token are environment-only in this interim round. See
// lib/whatsapp/config.ts's own header comment.

export function ConnectWhatsappForm({ businessId }: { businessId: string }) {
  const [state, action, pending] = useActionState(connectWhatsappAccountAction, undefined);
  return (
    <form action={action} className="flex flex-col gap-2">
      <input type="hidden" name="businessId" value={businessId} />
      <Button type="submit" disabled={pending}>Connect WhatsApp</Button>
      {state?.error ? <p role="alert" className="text-sm text-destructive">{state.error}</p> : null}
    </form>
  );
}

export function DisconnectWhatsappForm({ businessId }: { businessId: string }) {
  const [state, action, pending] = useActionState(disconnectWhatsappAccountAction, undefined);
  return (
    <form action={action} className="flex flex-col gap-2">
      <input type="hidden" name="businessId" value={businessId} />
      <Button type="submit" variant="outline" disabled={pending}>Disconnect</Button>
      {state?.error ? <p role="alert" className="text-sm text-destructive">{state.error}</p> : null}
    </form>
  );
}

export function SyncTemplatesForm({ businessId }: { businessId: string }) {
  const [state, action, pending] = useActionState(syncWhatsappTemplatesAction, undefined);
  return (
    <form action={action} className="flex flex-col gap-2">
      <input type="hidden" name="businessId" value={businessId} />
      <Button type="submit" variant="outline" disabled={pending}>Sync templates</Button>
      {state?.error ? <p role="alert" className="text-sm text-destructive">{state.error}</p> : null}
      {state?.success ? <p className="text-sm text-muted-foreground">Templates synced.</p> : null}
    </form>
  );
}
