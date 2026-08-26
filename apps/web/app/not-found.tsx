import Link from "next/link";
import { Button } from "@/components/ui/button";

export default function NotFound() {
  return (
    <div className="flex min-h-full flex-col items-center justify-center gap-4 p-16 text-center">
      <h1 className="text-xl font-semibold">Not found</h1>
      <p className="text-muted-foreground">This page doesn&apos;t exist, or you don&apos;t have access to it.</p>
      <Button variant="outline" nativeButton={false} render={<Link href="/">Go home</Link>} />
    </div>
  );
}
