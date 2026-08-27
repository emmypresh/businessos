"use client";

import { useFormStatus } from "react-dom";
import { Loader2 } from "lucide-react";
import { Button } from "@/components/ui/button";

export function SubmitButton({
  children,
  disabled = false,
}: {
  children: React.ReactNode;
  // Additional caller-supplied disable condition (e.g. a client-side-only
  // validation guard), combined with the existing pending-state disable —
  // every other caller omits this and is unaffected.
  disabled?: boolean;
}) {
  const { pending } = useFormStatus();
  return (
    <Button type="submit" disabled={pending || disabled} aria-busy={pending} className="w-full">
      {pending ? <Loader2 className="size-4 animate-spin" /> : children}
    </Button>
  );
}
