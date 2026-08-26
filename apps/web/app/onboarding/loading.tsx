import { Loader2 } from "lucide-react";

export default function OnboardingLoading() {
  return (
    <div className="mx-auto flex min-h-full w-full max-w-md items-center justify-center px-6 py-16">
      <Loader2 className="size-5 animate-spin text-muted-foreground" role="status" aria-label="Loading" />
    </div>
  );
}
