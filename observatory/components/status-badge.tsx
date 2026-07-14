import { Badge } from "@/components/ui/badge";

// Same color language as the eve app's inline observe page
// (catalog/observe-page.ts's .badge-* classes) — kept in sync by eye since
// this is a different rendering stack (Tailwind classes vs. a CSS string),
// not by shared code.
const STATUS_CLASSES: Record<string, string> = {
  pending: "bg-muted text-muted-foreground",
  armed: "bg-green-100 text-green-800 dark:bg-green-950 dark:text-green-400",
  delivering: "bg-amber-100 text-amber-800 dark:bg-amber-950 dark:text-amber-400",
  fired: "bg-blue-100 text-blue-800 dark:bg-blue-950 dark:text-blue-400",
  expired: "bg-muted text-muted-foreground",
  failed: "bg-red-100 text-red-800 dark:bg-red-950 dark:text-red-400",
};

export function StatusBadge({ status }: { status: string }) {
  return (
    <Badge variant="outline" className={STATUS_CLASSES[status] ?? ""}>
      {status}
    </Badge>
  );
}
