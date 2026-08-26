"use client";

import { Button } from "@/components/ui/button";
import { Alert, AlertDescription } from "@/components/ui/alert";

export default function OnboardingError({
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  return (
    <div className="mx-auto flex min-h-full w-full max-w-md flex-col items-center justify-center gap-4 px-6 py-16">
      <Alert variant="destructive" role="alert">
        <AlertDescription>Something went wrong while creating your business. Please try again.</AlertDescription>
      </Alert>
      <Button onClick={reset} variant="outline">Try again</Button>
    </div>
  );
}
