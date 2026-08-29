"use client";

import type { ReactNode } from "react";
import { Tabs, TabsList, TabsTrigger, TabsContent } from "@/components/ui/tabs";

/**
 * A thin client boundary around the Tabs primitive only — all data
 * fetching and permission gating happens server-side in
 * app/[businessId]/staff/page.tsx; this component just arranges the two
 * already-rendered trees (`membersContent`/`invitationsContent`) into
 * tabs and reads the initial tab from the page's own `defaultTab` prop
 * (itself derived from the `?tab=` query param — see that page for why:
 * redirected here after sending/revoking an invitation).
 */
export function StaffTabs({
  defaultTab,
  membersContent,
  invitationsContent,
}: {
  defaultTab: string;
  membersContent: ReactNode;
  invitationsContent?: ReactNode;
}) {
  if (!invitationsContent) {
    // staff.invite-less caller — no tabs UI at all, just the members list,
    // matching "Do NOT fetch/list invitations for staff.view-only users."
    return <>{membersContent}</>;
  }

  return (
    <Tabs defaultValue={defaultTab}>
      <TabsList>
        <TabsTrigger value="members">Members</TabsTrigger>
        <TabsTrigger value="invitations">Invitations</TabsTrigger>
      </TabsList>
      <TabsContent value="members" className="pt-4">
        {membersContent}
      </TabsContent>
      <TabsContent value="invitations" className="pt-4">
        {invitationsContent}
      </TabsContent>
    </Tabs>
  );
}
