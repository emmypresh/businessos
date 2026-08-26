import { getBusinessMembership } from "@/lib/business/dal";
import { createClient } from "@/lib/supabase/server";
import { MembersTable } from "@/components/dashboard/members-table";

export default async function MembersPage({
  params,
}: PageProps<"/[businessId]/members">) {
  const { businessId } = await params;
  await getBusinessMembership(businessId); // re-verifies access; throws notFound() otherwise

  const supabase = await createClient();
  const { data, error } = await supabase
    .from("business_members")
    .select("id, status, created_at, roles(name)")
    .eq("business_id", businessId)
    .order("created_at", { ascending: true });

  if (error) {
    throw new Error(`Failed to load members: ${error.message}`);
  }

  return (
    <div>
      <h1 className="text-2xl font-semibold tracking-tight">Members</h1>
      <div className="mt-6">
        <MembersTable members={data ?? []} />
      </div>
    </div>
  );
}
