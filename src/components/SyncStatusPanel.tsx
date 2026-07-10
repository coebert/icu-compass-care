import { useQuery, useQueryClient, useMutation } from "@tanstack/react-query";
import { useServerFn } from "@tanstack/react-start";
import { getSyncStatus, runBridgeSyncFn, type SyncStatus } from "@/lib/sync.functions";
import type { SyncRunResult } from "@/lib/bridge-sync.server";
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import { Button } from "@/components/ui/button";
import { CheckCircle2, AlertTriangle, RefreshCw } from "lucide-react";
import { cn } from "@/lib/utils";
import { toast } from "sonner";

function relTime(iso: string | null): string {
  if (!iso) return "—";
  const d = new Date(iso);
  const diff = Date.now() - d.getTime();
  const mins = Math.round(diff / 60000);
  if (mins < 1) return "just now";
  if (mins < 60) return `${mins} min ago`;
  const hrs = Math.round(mins / 60);
  if (hrs < 24) return `${hrs} h ago`;
  return d.toLocaleString();
}

/**
 * Compact cross-project sync indicator intended to sit inline in a page
 * header. Shows last successful sync at a glance, flags the last error, and
 * exposes full detail on hover — deliberately low-prominence. Admins can retry
 * a failed sync directly from the banner.
 */
export function SyncStatusPanel({
  className,
  isAdmin = false,
}: {
  className?: string;
  isAdmin?: boolean;
} = {}) {
  const queryClient = useQueryClient();
  const fetchStatus = useServerFn(getSyncStatus);
  const runSync = useServerFn(runBridgeSyncFn);

  const { data, isLoading, error } = useQuery({
    queryKey: ["sync-status"],
    queryFn: () => fetchStatus() as Promise<SyncStatus>,
    retry: false,
    refetchInterval: 60_000,
  });

  const retry = useMutation({
    mutationFn: () => runSync() as Promise<SyncStatus>,
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["sync-status"] });
      toast.success("Sync retry completed");
    },
    onError: (e: Error) => toast.error("Sync retry failed", { description: e.message }),
  });

  if (isLoading) {
    return (
      <span className={cn("inline-flex items-center gap-1.5 text-xs text-muted-foreground", className)}>
        <RefreshCw className="h-3.5 w-3.5 animate-spin" /> Sync…
      </span>
    );
  }

  if (error) return null;

  const hasError = !!data?.lastError;
  const showRetry = hasError && isAdmin;

  return (
    <TooltipProvider>
      <div className={cn("inline-flex items-center gap-2", className)}>
        <Tooltip>
          <TooltipTrigger asChild>
            <span
              className={cn(
                "inline-flex cursor-default items-center gap-1.5 rounded-md border px-2 py-1 text-xs",
                hasError ? "border-destructive/40 text-destructive" : "text-muted-foreground",
              )}
            >
              {hasError ? (
                <AlertTriangle className="h-3.5 w-3.5" />
              ) : (
                <CheckCircle2 className="h-3.5 w-3.5 text-emerald-600" />
              )}
              Sync {relTime(data?.lastSuccess?.created_at ?? null)}
            </span>
          </TooltipTrigger>
          <TooltipContent className="max-w-xs space-y-1">
            <p className="font-medium">Cross-project sync</p>
            {data?.lastSuccess ? (
              <p className="text-xs">
                Last success {relTime(data.lastSuccess.created_at)} — {data.lastSuccess.direction} ·{" "}
                {data.lastSuccess.entity} · {data.lastSuccess.record_count} record
                {data.lastSuccess.record_count === 1 ? "" : "s"}
              </p>
            ) : (
              <p className="text-xs">No syncs recorded yet.</p>
            )}
            {hasError ? (
              <p className="text-xs text-destructive">
                Last error {relTime(data!.lastError!.created_at)} — {data!.lastError!.direction} ·{" "}
                {data!.lastError!.entity}: {data!.lastError!.error_message || "Unknown error"}
              </p>
            ) : (
              <p className="text-xs text-emerald-600">No errors.</p>
            )}
          </TooltipContent>
        </Tooltip>
        {showRetry && (
          <Button
            variant="outline"
            size="sm"
            className="h-7 gap-1.5 px-2 text-xs"
            disabled={retry.isPending}
            onClick={() => retry.mutate()}
          >
            <RefreshCw className={`h-3.5 w-3.5 ${retry.isPending ? "animate-spin" : ""}`} />
            Retry
          </Button>
        )}
      </div>
    </TooltipProvider>
  );
}
