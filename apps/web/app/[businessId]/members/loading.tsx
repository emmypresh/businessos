import { Loader2 } from "@/components/ui/icon";

export default function MembersLoading() {
  return <Loader2 className="size-5 animate-spin text-muted-foreground" role="status" aria-label="Loading members" />;
}
