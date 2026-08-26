"use client";

import { Button } from "@/components/ui/button";
import { Alert, AlertDescription } from "@/components/ui/alert";

export default function BusinessError({
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  return (
    <div className="flex flex-col items-center justify-center gap-4 p-16">
      <Alert variant="destructive" role="alert">
        <AlertDescription>Something went wrong loading this business.</AlertDescription>
      </Alert>
      <Button onClick={reset} variant="outline">Try again</Button>
    </div>
  );
}
