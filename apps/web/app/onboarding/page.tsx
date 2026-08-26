import { AuthCard } from "@/components/auth/auth-card";
import { CreateBusinessForm } from "@/components/onboarding/create-business-form";

export default function OnboardingPage() {
  return (
    <AuthCard title="Create your business">
      <CreateBusinessForm />
    </AuthCard>
  );
}
