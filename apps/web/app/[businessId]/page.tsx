import { getBusinessMembership } from "@/lib/business/dal";

export default async function BusinessDashboardPage({
  params,
}: PageProps<"/[businessId]">) {
  const { businessId } = await params;
  const membership = await getBusinessMembership(businessId);

  return (
    <div>
      <h1 className="text-2xl font-semibold tracking-tight">
        Welcome to {membership.businesses?.name}
      </h1>
      <p className="mt-2 text-muted-foreground">
        You are signed in as {membership.roles?.name ?? "a member"}.
      </p>
    </div>
  );
}
