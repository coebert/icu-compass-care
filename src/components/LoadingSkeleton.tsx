import { Skeleton } from "@/components/ui/skeleton";
import { cn } from "@/lib/utils";

/**
 * Shared skeleton placeholders for initial loads. Prefer these over ad-hoc
 * "Loading…" text so the shape of what's coming is visible and shifts less
 * on hydration.
 */

/** A list of card-like rows. Sized to look like a patient / bed / task list. */
export function ListSkeleton({
  rows = 4,
  className,
  rowClassName,
}: {
  rows?: number;
  className?: string;
  rowClassName?: string;
}) {
  return (
    <div
      className={cn("space-y-2", className)}
      role="status"
      aria-live="polite"
      aria-busy="true"
      aria-label="Loading"
    >
      {Array.from({ length: rows }).map((_, i) => (
        <div
          key={i}
          className={cn(
            "flex items-center gap-3 rounded-lg border bg-card p-3",
            rowClassName,
          )}
        >
          <Skeleton className="h-9 w-9 rounded-full" />
          <div className="flex-1 space-y-2">
            <Skeleton className="h-3.5 w-1/3" />
            <Skeleton className="h-3 w-2/3" />
          </div>
          <Skeleton className="h-5 w-14 rounded-full" />
        </div>
      ))}
    </div>
  );
}

/** Compact rows for tables / dense lists (staff, passkeys, etc). */
export function RowSkeleton({
  rows = 3,
  className,
}: {
  rows?: number;
  className?: string;
}) {
  return (
    <div
      className={cn("space-y-2", className)}
      role="status"
      aria-live="polite"
      aria-busy="true"
      aria-label="Loading"
    >
      {Array.from({ length: rows }).map((_, i) => (
        <div key={i} className="flex items-center gap-3">
          <Skeleton className="h-4 w-4 rounded" />
          <Skeleton className="h-4 flex-1" />
          <Skeleton className="h-4 w-16" />
        </div>
      ))}
    </div>
  );
}

/** Two-line paragraph placeholder for text-heavy areas. */
export function TextSkeleton({ className }: { className?: string }) {
  return (
    <div
      className={cn("space-y-2", className)}
      role="status"
      aria-live="polite"
      aria-busy="true"
      aria-label="Loading"
    >
      <Skeleton className="h-3 w-3/4" />
      <Skeleton className="h-3 w-1/2" />
    </div>
  );
}
