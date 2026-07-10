import { useQuery } from "@tanstack/react-query";
import { useServerFn } from "@tanstack/react-start";
import { getSyncStatus, type SyncStatus } from "@/lib/sync.functions";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { CheckCircle2, AlertTriangle, RefreshCw } from "lucide-react";

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

export function SyncStatusPanel() {
  const fetchStatus = useServerFn(getSyncStatus);
  const { data, isLoading, error } = useQuery({
    queryKey: ["sync-status"],
    queryFn: () => fetchStatus() as Promise<SyncStatus>,
    retry: false,
    refetchInterval: 60_000,
  });

  return (
    <Card>
      <CardHeader className="pb-3">
        <CardTitle className="flex items-center gap-2 text-base">
          <RefreshCw className="h-4 w-4 text-muted-foreground" />
          Cross-project sync status
        </CardTitle>
      </CardHeader>
      <CardContent>
        {isLoading ? (
          <p className="text-sm text-muted-foreground">Loading sync status…</p>
        ) : error ? (
          <p className="text-sm text-muted-foreground">
            You do not have permission to view sync status.
          </p>
        ) : (
          <div className="grid gap-3 sm:grid-cols-2">
            <div className="rounded-md border p-3">
              <div className="flex items-center gap-2 text-sm font-medium">
                <CheckCircle2 className="h-4 w-4 text-emerald-600" />
                Last successful sync
              </div>
              <p className="mt-1 text-lg font-semibold">
                {relTime(data?.lastSuccess?.created_at ?? null)}
              </p>
              {data?.lastSuccess ? (
                <p className="mt-0.5 text-xs text-muted-foreground">
                  {data.lastSuccess.direction} · {data.lastSuccess.entity} ·{" "}
                  {data.lastSuccess.record_count} record
                  {data.lastSuccess.record_count === 1 ? "" : "s"}
                </p>
              ) : (
                <p className="mt-0.5 text-xs text-muted-foreground">No syncs recorded yet.</p>
              )}
            </div>

            <div className="rounded-md border p-3">
              <div className="flex items-center gap-2 text-sm font-medium">
                <AlertTriangle
                  className={`h-4 w-4 ${data?.lastError ? "text-destructive" : "text-muted-foreground"}`}
                />
                Last error
              </div>
              {data?.lastError ? (
                <>
                  <p className="mt-1 flex items-center gap-2">
                    <Badge variant="destructive">{relTime(data.lastError.created_at)}</Badge>
                    <span className="text-xs text-muted-foreground">
                      {data.lastError.direction} · {data.lastError.entity}
                    </span>
                  </p>
                  <p className="mt-1 max-w-full truncate text-xs text-destructive" title={data.lastError.error_message ?? ""}>
                    {data.lastError.error_message || "Unknown error"}
                  </p>
                </>
              ) : (
                <p className="mt-1 text-lg font-semibold text-emerald-600">None</p>
              )}
            </div>
          </div>
        )}
      </CardContent>
    </Card>
  );
}
