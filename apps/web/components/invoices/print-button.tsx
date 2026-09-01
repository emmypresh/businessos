"use client";

import { Button } from "@/components/ui/button";
import { Printer } from "lucide-react";

export function PrintButton() {
  return (
    <Button type="button" onClick={() => window.print()} className="gap-2">
      <Printer className="size-4" />
      Print
    </Button>
  );
}
