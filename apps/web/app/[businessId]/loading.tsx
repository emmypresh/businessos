import { Loader2 } from "lucide-react";

export default function BusinessLoading() {
  return (
    <div className="p-8">
      <Loader2 className="size-5 animate-spin text-muted-foreground" role="status" aria-label="Loading" />
    </div>
  );
}
