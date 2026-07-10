import { useQuery, useQueryClient, useMutation } from "@tanstack/react-query";
import { useServerFn } from "@tanstack/react-start";
import { getSyncStatus, runBridgeSyncFn, type SyncStatus } from "@/lib/sync.functions";
import type { SyncRunResult } from "@/lib/bridge-sync.server";
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from "@/components/ui/tooltip";
import { Button } from "@/components/ui/button";
import { CheckCircle2, AlertTriangle, RefreshCw } from "lucide-react";
import { cn } from "@/lib/utils";
import { toast } from "sonner";

function relTime(iso: string | null): string {
  if (!iso) return "never";
  const d = new Date(iso);
  const diff = Date.now() - d.getTime();
  const mins = Math.round(diff / 60000);
  if (mins < 1) return "just now";
  if (mins < 60) return `${mins} min ago`;
  const hrs = Math.round(mins / 60);
  if (hrs < 24) return `${hrs} h ago`;
  return d.toLocaleString();
}

function nextSyncText(lastSuccessIso: string | null, intervalMinutes: number): string {
  const intervalMs = intervalMinutes * 60_000;
  const lastMs = lastSuccessIso ? Date.parse(lastSuccessIso) : 0;
  let nextMs = lastMs > 0 ? lastMs + intervalMs : Date.now() + intervalMs;
  while (nextMs < Date.now()) {
    nextMs += intervalMs;
  }

  const diff = nextMs - Date.now();
  const mins = Math.round(diff / 60000);
  if (mins < 1) return "in <1 min";
  if (mins < 60) return `in ${mins} min`;
  const hrs = Math.round(mins / 60);
  if (hrs < 24) return `in ${hrs} h`;
  return `at ${new Date(nextMs).toLocaleString("en-GB", { hour12: false })}`;
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
    mutationFn: () => runSync() as Promise<SyncRunResult>,
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["sync-status"] });
      toast.success("Sync retry completed");
    },
    onError: (e: Error) => toast.error("Sync retry failed", { description: e.message }),
  });

  if (isLoading) {
    return (
      <span
        className={cn("inline-flex items-center gap-1.5 text-xs text-muted-foreground", className)}
      >
        <RefreshCw className="h-3.5 w-3.5 animate-spin" /> Sync…
      </span>
    );
  }

  if (error) return null;

  const hasError = !!data?.lastError;
  const showRetry = hasError && isAdmin;
  const intervalMinutes = data?.config.intervalMinutes ?? 15;
  const nextSync = data?.lastSuccess
    ? nextSyncText(data.lastSuccess.created_at, intervalMinutes)
    : nextSyncText(null, intervalMinutes);

  const badgeLabel = hasError ? "Last sync failed" : "Last synced";
  const badgeTime = relTime(
    (hasError ? data?.lastError?.created_at : data?.lastSuccess?.created_at) ?? null,
  );

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
              {badgeLabel} {badgeTime}
            </span>
          </TooltipTrigger>
          <TooltipContent className="max-w-xs space-y-1">
            <p className="font-medium">Cross-project sync</p>
            <p className="text-xs">
              <span className="text-muted-foreground">Last success:</span>{" "}
              {data?.lastSuccess ? (
                <>
                  {relTime(data.lastSuccess.created_at)} — {data.lastSuccess.direction} ·{" "}
                  {data.lastSuccess.entity} · {data.lastSuccess.record_count} record
                  {data.lastSuccess.record_count === 1 ? "" : "s"}
                </>
              ) : (
                <span className="text-muted-foreground">never</span>
              )}
            </p>
            <p className="text-xs">
              <span className="text-muted-foreground">Last error:</span>{" "}
              {hasError ? (
                <span className="text-destructive">
                  {relTime(data!.lastError!.created_at)} — {data!.lastError!.direction} ·{" "}
                  {data!.lastError!.entity}: {data!.lastError!.error_message || "Unknown error"}
                </span>
              ) : (
                <span className="text-emerald-600">none</span>
              )}
            </p>
            <p className="text-xs">
              <span className="text-muted-foreground">Next scheduled sync:</span> {nextSync} (every{" "}
              {intervalMinutes} min)
            </p>
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
