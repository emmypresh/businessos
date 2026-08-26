import Link from "next/link";
import { Card, CardContent } from "@/components/ui/card";
import type { MembershipRow } from "@/lib/business/dal";

export function BusinessSwitcherList({
  memberships,
}: {
  memberships: MembershipRow[];
}) {
  return (
    <div className="mx-auto flex w-full max-w-md flex-col gap-3 px-6 py-16">
      <h1 className="text-xl font-semibold tracking-tight">Choose a business</h1>
      {memberships.map((membership) => (
        <Link key={membership.business_id} href={`/${membership.business_id}`}>
          <Card className="transition-colors hover:bg-accent">
            <CardContent className="flex items-center justify-between py-4">
              <span className="font-medium">{membership.businesses?.name}</span>
              <span className="text-sm text-muted-foreground">{membership.roles?.name}</span>
            </CardContent>
          </Card>
        </Link>
      ))}
    </div>
  );
}
