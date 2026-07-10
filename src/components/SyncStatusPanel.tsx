import { useQuery } from "@tanstack/react-query";
import { useServerFn } from "@tanstack/react-start";
import { getSyncStatus, type SyncEvent } from "@/lib/sync.functions";
import { Card, CardContent } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { ArrowDownToLine, ArrowUpFromLine, RefreshCw } from "lucide-react";

function timeAgo(iso: string | undefined | null): string {
  if (!iso) return "never";
  const secs = Math.floor((Date.now() - new Date(iso).getTime()) / 1000);
  if (secs < 60) return "just now";
  const mins = Math.floor(secs / 60);
  if (mins < 60) return `${mins} min ago`;
  const hrs = Math.floor(mins / 60);
  if (hrs < 24) return `${hrs} hr ago`;
  const days = Math.floor(hrs / 24);
  return `${days} day${days === 1 ? "" : "s"} ago`;
}

function describe(e: SyncEvent): string {
  const who = e.actor_email ? ` by ${e.actor_email}` : e.actor_role ? ` by a ${e.actor_role}` : "";
  return `${e.record_count} ${e.entity}${who}`;
}

export function SyncStatusPanel() {
  const fetchStatus = useServerFn(getSyncStatus);
  const { data, isLoading } = useQuery({
    queryKey: ["sync-status"],
    queryFn: () => fetchStatus(),
    refetchInterval: 30_000,
  });

  return (
    <Card>
      <CardContent className="space-y-3 p-4">
        <div className="flex items-center gap-2">
          <RefreshCw className="h-4 w-4 text-muted-foreground" />
          <h2 className="text-sm font-semibold">Sync status</h2>
          <span className="ml-auto text-xs text-muted-foreground">Linked project</span>
        </div>

        {isLoading ? (
          <p className="text-xs text-muted-foreground">Checking…</p>
        ) : (
          <>
            <div className="grid gap-2 sm:grid-cols-2">
              <div className="rounded-md border p-3">
                <div className="flex items-center gap-1.5 text-xs font-medium text-muted-foreground">
                  <ArrowDownToLine className="h-3.5 w-3.5" /> Last pushed in
                </div>
                <p className="mt-1 text-sm font-semibold">{timeAgo(data?.lastPush?.created_at)}</p>
                {data?.lastPush && (
                  <p className="text-xs text-muted-foreground">{describe(data.lastPush)}</p>
                )}
              </div>
              <div className="rounded-md border p-3">
                <div className="flex items-center gap-1.5 text-xs font-medium text-muted-foreground">
                  <ArrowUpFromLine className="h-3.5 w-3.5" /> Last pulled out
                </div>
                <p className="mt-1 text-sm font-semibold">{timeAgo(data?.lastPull?.created_at)}</p>
                {data?.lastPull && (
                  <p className="text-xs text-muted-foreground">{describe(data.lastPull)}</p>
                )}
              </div>
            </div>

            {data && data.recent.length > 0 ? (
              <div className="space-y-1">
                {data.recent.map((e) => (
                  <div key={e.id} className="flex items-center gap-2 text-xs">
                    <Badge variant="outline" className="gap-1">
                      {e.direction === "push" ? (
                        <ArrowDownToLine className="h-3 w-3" />
                      ) : (
                        <ArrowUpFromLine className="h-3 w-3" />
                      )}
                      {e.direction === "push" ? "In" : "Out"}
                    </Badge>
                    <span className="text-muted-foreground">{describe(e)}</span>
                    <span className="ml-auto text-muted-foreground">{timeAgo(e.created_at)}</span>
                  </div>
                ))}
              </div>
            ) : (
              <p className="text-xs text-muted-foreground">No sync activity with the linked project yet.</p>
            )}
          </>
        )}
      </CardContent>
    </Card>
  );
}
