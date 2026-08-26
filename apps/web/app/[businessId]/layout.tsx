import { getBusinessMembership } from "@/lib/business/dal";
import { DashboardShell } from "@/components/dashboard/dashboard-shell";

export default async function BusinessLayout({
  children,
  params,
}: LayoutProps<"/[businessId]">) {
  const { businessId } = await params;
  const membership = await getBusinessMembership(businessId);

  return <DashboardShell membership={membership}>{children}</DashboardShell>;
}
