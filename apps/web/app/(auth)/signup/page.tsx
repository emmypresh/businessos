import { AuthCard } from "@/components/auth/auth-card";
import { SignUpForm } from "@/components/auth/signup-form";

export default function SignUpPage() {
  return (
    <AuthCard title="Create your account">
      <SignUpForm />
    </AuthCard>
  );
}
