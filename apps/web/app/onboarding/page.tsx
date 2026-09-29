import { AuthCard } from "@/components/auth/auth-card";
import { CreateBusinessForm } from "@/components/onboarding/create-business-form";
import { listActiveBusinessCategories } from "@/lib/business/categories-dal";

export default async function OnboardingPage() {
  const categories = await listActiveBusinessCategories();

  return (
    <AuthCard title="Create your business">
      <CreateBusinessForm categories={categories} />
    </AuthCard>
  );
}
