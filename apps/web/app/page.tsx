import { redirect } from "next/navigation";
import Link from "next/link";
import { Button } from "@/components/ui/button";
import { getAuthUser } from "@/lib/auth/dal";
import { listMemberships } from "@/lib/business/dal";
import { BusinessSwitcherList } from "@/components/dashboard/business-switcher-list";

export default async function HomePage() {
  const user = await getAuthUser();

  if (!user) {
    return (
      <div className="flex flex-1 flex-col items-center justify-center gap-6 bg-muted/30 px-6 text-center">
        <h1 className="text-3xl font-semibold tracking-tight">BusinessOS</h1>
        <p className="max-w-md text-muted-foreground">
          Run your business in one place.
        </p>
        <div className="flex gap-4">
          <Button variant="outline" nativeButton={false} render={<Link href="/login">Log in</Link>} />
          <Button nativeButton={false} render={<Link href="/signup">Sign up</Link>} />
        </div>
      </div>
    );
  }

  const memberships = await listMemberships();

  if (memberships.length === 0) {
    redirect("/onboarding");
  }

  if (memberships.length === 1) {
    redirect(`/${memberships[0].business_id}`);
  }

  // 2+ memberships: deterministic list (ordered by created_at ascending,
  // per listMemberships), never an unordered pick of memberships[0].
  return <BusinessSwitcherList memberships={memberships} />;
}
