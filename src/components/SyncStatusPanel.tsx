import { useEffect, useState } from "react";
import { useQuery, useQueryClient, useMutation } from "@tanstack/react-query";
import { useServerFn } from "@tanstack/react-start";
import { getSyncStatus, runBridgeSyncFn, type SyncStatus } from "@/lib/sync.functions";
import type { SyncRunResult } from "@/lib/bridge-sync.server";
import {
  RESOURCE_STATE_TEXT,
  SYNC_ERROR_TEXT,
  overallState,
  resourceState,
  type ResourceState,
} from "@/lib/sync-status";
import { fmtDateTime } from "@/lib/icu";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { Button } from "@/components/ui/button";
import { CheckCircle2, AlertTriangle, RefreshCw, Clock } from "lucide-react";
import { cn } from "@/lib/utils";
import { toast } from "sonner";
import { supabase } from "@/integrations/supabase/client";

export function relTime(iso: string | null, now = Date.now()): string {
  if (!iso) return "never";
  const t = Date.parse(iso);
  if (!Number.isFinite(t)) return "unknown";
  const mins = Math.round((now - t) / 60000);
  if (mins < 1) return "just now";
  if (mins < 60) return `${mins} min ago`;
  const hrs = Math.round(mins / 60);
  if (hrs < 24) return `${hrs} h ago`;
  return fmtDateTime(iso);
}

const RESOURCE_LABEL: Record<string, string> = {
  patients: "Patients",
  investigations: "Investigations",
  referrals: "Referrals",
  microbiology: "Microbiology",
};

const BAD: ResourceState[] = ["failed", "unavailable", "incomplete"];
const WARN: ResourceState[] = ["delayed", "never"];

function stateTone(s: ResourceState) {
  if (BAD.includes(s)) return "text-destructive";
  if (WARN.includes(s)) return "text-amber-700 dark:text-amber-300";
  return "text-muted-foreground";
}

/** Re-render every 30 s so "x min ago" and "delayed" stay truthful. */
function useNow(intervalMs = 30_000) {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const t = window.setInterval(() => setNow(Date.now()), intervalMs);
    return () => window.clearInterval(t);
  }, [intervalMs]);
  return now;
}

/**
 * Header indicator for the inbound partner sync. Each stream (patients,
 * investigations, referrals, microbiology) is judged on its OWN latest pull
 * attempt and latest success, and the badge shows the worst of them, so a
 * healthy stream can never hide a failing one. Details open on click, tap or
 * Enter/Space; Trust administrators can start a manual sync.
 */
export function SyncStatusPanel({ className }: { className?: string; isAdmin?: boolean } = {}) {
  const queryClient = useQueryClient();
  const fetchStatus = useServerFn(getSyncStatus);
  const runSync = useServerFn(runBridgeSyncFn);
  const now = useNow();

  const status = useQuery({
    queryKey: ["sync-status"],
    queryFn: async (): Promise<SyncStatus | null> => {
      // Skip during sign-out: no session → no bearer → server fn 401s.
      const { data: s } = await supabase.auth.getSession();
      if (!s.session) return null;
      return fetchStatus() as Promise<SyncStatus>;
    },
    retry: false,
    refetchInterval: 60_000,
  });

  const retry = useMutation({
    mutationFn: () => runSync() as Promise<SyncRunResult>,
    onSuccess: async (res) => {
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: ["sync-status"] }),
        queryClient.invalidateQueries({ queryKey: ["reconciliation"] }),
        queryClient.invalidateQueries({ queryKey: ["patients"] }),
        queryClient.invalidateQueries({ queryKey: ["referral-candidates"] }),
      ]);
      if (res.ok) {
        toast.success("Partner sync completed");
      } else {
        const problems = res.results
          .filter((r) => r.error || r.failed > 0)
          .map(
            (r) =>
              `${RESOURCE_LABEL[r.entity] ?? r.entity}: ${SYNC_ERROR_TEXT[r.error ?? "partial_write_failure"]}`,
          );
        toast.warning("Partner sync incomplete", { description: problems.join(" ") });
      }
    },
    onError: async (e: Error) => {
      await queryClient.invalidateQueries({ queryKey: ["sync-status"] });
      toast.error("Sync could not be run", { description: e.message });
    },
  });

  if (status.isPending) {
    return (
      <span
        role="status"
        className={cn("inline-flex items-center gap-1.5 text-xs text-muted-foreground", className)}
      >
        <RefreshCw className="h-3.5 w-3.5 animate-spin" aria-hidden /> Checking sync…
      </span>
    );
  }

  const data = status.data;
  if (!status.isError && (!data || data.access === "restricted")) return null;

  type Granted = Extract<SyncStatus, { access: "granted" }>;
  const granted: Granted | null =
    !status.isError && data && data.access === "granted" ? (data as Granted) : null;
  // A failed status query is itself shown — never hidden or shown as healthy.
  const loadFailed = granted === null;
  const rows = granted
    ? granted.resources.map((r) => ({
        r,
        state: resourceState(r, now, granted.delayedAfterMinutes),
      }))
    : [];
  const overall: ResourceState = loadFailed
    ? "unavailable"
    : overallState(rows.map((x) => x.state));
  const lastSuccessOverall =
    rows
      .map((x) => x.r.lastSuccessAt)
      .filter((v): v is string => Boolean(v))
      .sort()
      .reverse()[0] ?? null;
  // Oldest per-stream success is what "everything is current as of" means.
  const oldestSuccess =
    rows.length > 0 && rows.every((x) => x.r.lastSuccessAt)
      ? rows.map((x) => x.r.lastSuccessAt as string).sort()[0]
      : null;

  const Icon = BAD.includes(overall)
    ? AlertTriangle
    : WARN.includes(overall)
      ? Clock
      : CheckCircle2;
  const badgeText = loadFailed
    ? "Sync status unavailable"
    : overall === "ok"
      ? `Synced ${relTime(oldestSuccess, now)}`
      : `Sync ${RESOURCE_STATE_TEXT[overall].toLowerCase()}`;
  const canRetry = Boolean(granted?.canRetry);

  return (
    <div className={cn("inline-flex shrink-0 items-center gap-2 whitespace-nowrap", className)}>
      <Popover>
        <PopoverTrigger asChild>
          <button
            type="button"
            aria-label={`Partner sync: ${badgeText}. Show details`}
            className={cn(
              "inline-flex min-h-9 items-center gap-1.5 whitespace-nowrap rounded-md border px-2 py-1 text-xs focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring sm:min-h-7",
              BAD.includes(overall)
                ? "border-destructive/40 text-destructive"
                : WARN.includes(overall)
                  ? "border-amber-500/40 text-amber-700 dark:text-amber-300"
                  : "text-muted-foreground",
            )}
          >
            <Icon
              className={cn("h-3.5 w-3.5 shrink-0", overall === "ok" && "text-emerald-600")}
              aria-hidden
            />
            {badgeText}
          </button>
        </PopoverTrigger>
        <PopoverContent className="w-80 space-y-2 text-xs" align="end">
          <p className="text-sm font-medium">Partner sync (incoming)</p>
          {loadFailed ? (
            <div role="alert" className="space-y-2">
              <p className="text-destructive">
                Sync status couldn't be loaded, so it is not known whether partner data is current.
              </p>
              <Button
                size="sm"
                variant="outline"
                className="h-9 gap-1.5"
                onClick={() => void status.refetch()}
                disabled={status.isFetching}
              >
                <RefreshCw
                  className={cn("h-3.5 w-3.5", status.isFetching && "animate-spin")}
                  aria-hidden
                />
                Check again
              </Button>
            </div>
          ) : (
            <>
              <ul className="space-y-2" aria-label="Sync status by record type">
                {rows.map(({ r, state }) => (
                  <li key={r.entity} className="rounded-md border p-2">
                    <div className="flex items-center justify-between gap-2">
                      <span className="font-medium">{RESOURCE_LABEL[r.entity] ?? r.entity}</span>
                      <span className={cn("font-medium", stateTone(state))}>
                        {RESOURCE_STATE_TEXT[state]}
                      </span>
                    </div>
                    {state === "unavailable" ? (
                      <p className="text-muted-foreground">
                        Status for this stream couldn't be read.
                      </p>
                    ) : (
                      <>
                        <p className="text-muted-foreground">
                          Last successful update:{" "}
                          {r.lastSuccessAt ? (
                            <time dateTime={r.lastSuccessAt} title={fmtDateTime(r.lastSuccessAt)}>
                              {relTime(r.lastSuccessAt, now)}
                            </time>
                          ) : (
                            "none recorded"
                          )}
                        </p>
                        {r.lastAttemptOk === false && r.lastAttemptAt && (
                          <p className="text-destructive">
                            {state === "incomplete"
                              ? "Last attempt incomplete"
                              : "Last attempt failed"}{" "}
                            <time dateTime={r.lastAttemptAt} title={fmtDateTime(r.lastAttemptAt)}>
                              {relTime(r.lastAttemptAt, now)}
                            </time>
                            : {SYNC_ERROR_TEXT[r.lastAttemptCode ?? "unknown"]}
                          </p>
                        )}
                        {state === "delayed" && (
                          <p className="text-amber-700 dark:text-amber-300">
                            No successful update for over {granted?.delayedAfterMinutes} min.
                          </p>
                        )}
                      </>
                    )}
                  </li>
                ))}
              </ul>
              <p className="text-muted-foreground">
                Most recent successful update on any stream: {relTime(lastSuccessOverall, now)}.
                Status checked {relTime(granted?.checkedAt, now)}.
              </p>
            </>
          )}
          {canRetry && (
            <Button
              size="sm"
              variant={BAD.includes(overall) ? "destructive" : "outline"}
              className="h-9 w-full gap-1.5"
              disabled={retry.isPending}
              onClick={() => retry.mutate()}
            >
              <RefreshCw
                className={cn("h-3.5 w-3.5", retry.isPending && "animate-spin")}
                aria-hidden
              />
              {retry.isPending ? "Syncing…" : BAD.includes(overall) ? "Retry sync now" : "Sync now"}
            </Button>
          )}
        </PopoverContent>
      </Popover>
      {canRetry && BAD.includes(overall) && (
        <Button
          variant="destructive"
          size="sm"
          className="h-9 gap-1.5 px-2 text-xs sm:h-7"
          disabled={retry.isPending}
          onClick={() => retry.mutate()}
          aria-label="Retry partner sync"
        >
          <RefreshCw className={cn("h-3.5 w-3.5", retry.isPending && "animate-spin")} aria-hidden />
          {retry.isPending ? "Syncing…" : "Retry"}
        </Button>
      )}
    </div>
  );
}
