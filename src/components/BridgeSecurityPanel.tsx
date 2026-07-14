import { useMemo } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useServerFn } from "@tanstack/react-start";
import {
  getBridgeSecurityOverview,
  updateBridgeSecurityAlert,
  type BridgeSecurityAlert,
  type BridgeSecurityOverview,
} from "@/lib/security.functions";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { ShieldAlert, ShieldCheck, RefreshCw } from "lucide-react";
import { toast } from "sonner";

const EVENT_LABELS: Record<string, string> = {
  signature_failure: "Signature failure",
  replay_detected: "Replay detected",
  stale_timestamp: "Stale timestamp",
  missing_headers: "Missing auth headers",
  invalid_actor: "Invalid user context",
  role_denied: "Role denied",
};

function label(type: string): string {
  return EVENT_LABELS[type] ?? type;
}

function timeAgo(iso: string): string {
  const diff = Date.now() - new Date(iso).getTime();
  const mins = Math.floor(diff / 60000);
  if (mins < 1) return "just now";
  if (mins < 60) return `${mins}m ago`;
  const hrs = Math.floor(mins / 60);
  if (hrs < 24) return `${hrs}h ago`;
  return `${Math.floor(hrs / 24)}d ago`;
}

export function BridgeSecurityPanel() {
  const qc = useQueryClient();
  const fetchOverview = useServerFn(getBridgeSecurityOverview);
  const updateAlert = useServerFn(updateBridgeSecurityAlert);

  const { data, isLoading, error, refetch, isRefetching } = useQuery({
    queryKey: ["bridge-security"],
    queryFn: () => fetchOverview() as Promise<BridgeSecurityOverview>,
    retry: false,
    refetchInterval: 60_000,
  });

  const mutate = useMutation({
    mutationFn: (v: { id: string; status: "acknowledged" | "resolved" }) => updateAlert({ data: v }),
    onSuccess: (_r, v) => {
      qc.invalidateQueries({ queryKey: ["bridge-security"] });
      toast.success(v.status === "resolved" ? "Incident resolved" : "Incident acknowledged");
    },
    onError: (e: Error) => toast.error("Could not update incident", { description: e.message }),
  });

  const openAlerts = useMemo(
    () => (data?.alerts ?? []).filter((a) => a.status === "open"),
    [data],
  );
  const pastAlerts = useMemo(
    () => (data?.alerts ?? []).filter((a) => a.status !== "open"),
    [data],
  );

  if (data && !data.isAdmin) return null;

  return (
    <Card>
      <CardHeader className="flex flex-row items-center gap-2 space-y-0">
        <ShieldAlert className="h-5 w-5 text-primary" />
        <div className="min-w-0">
          <CardTitle className="text-lg">Bridge security</CardTitle>
          <p className="text-sm text-muted-foreground">
            Automated alerts for repeated signature failures or replay detections on the partner bridge.
          </p>
        </div>
        <div className="ml-auto flex items-center gap-2">
          {data && data.openCount > 0 && (
            <Badge variant="destructive">{data.openCount} open</Badge>
          )}
          <Button
            variant="outline"
            size="sm"
            className="gap-1.5"
            onClick={() => refetch()}
            disabled={isRefetching}
          >
            <RefreshCw className={`h-4 w-4 ${isRefetching ? "animate-spin" : ""}`} />
            Refresh
          </Button>
        </div>
      </CardHeader>
      <CardContent className="space-y-4">
        {isLoading && <TextSkeleton />}
        {error && (
          <p className="text-sm text-destructive">
            {(error as Error).message || "Could not load security status."}
          </p>
        )}

        {data && !isLoading && !error && (
          <>
            {openAlerts.length === 0 && pastAlerts.length === 0 ? (
              <div className="flex items-center gap-2 rounded-md border border-border bg-muted/40 p-3 text-sm text-muted-foreground">
                <ShieldCheck className="h-4 w-4 text-primary" />
                No suspicious bridge activity detected.
              </div>
            ) : (
              <div className="space-y-2">
                {openAlerts.map((a) => (
                  <AlertRow key={a.id} alert={a} onUpdate={mutate.mutate} pending={mutate.isPending} />
                ))}
                {pastAlerts.map((a) => (
                  <AlertRow key={a.id} alert={a} onUpdate={mutate.mutate} pending={mutate.isPending} />
                ))}
              </div>
            )}

            <details className="group">
              <summary className="cursor-pointer text-sm font-medium text-muted-foreground hover:text-foreground">
                Recent security events ({data.recentEvents.length})
              </summary>
              <div className="mt-2 overflow-hidden rounded-md border border-border">
                {data.recentEvents.length === 0 ? (
                  <p className="p-3 text-sm text-muted-foreground">No recent events.</p>
                ) : (
                  <ul className="divide-y divide-border text-sm">
                    {data.recentEvents.map((e) => (
                      <li key={e.id} className="flex flex-wrap items-center gap-x-3 gap-y-1 p-2.5">
                        <span className="font-medium">{label(e.event_type)}</span>
                        {e.endpoint && (
                          <span className="font-mono text-xs text-muted-foreground">{e.endpoint}</span>
                        )}
                        {e.actor_email && (
                          <span className="text-xs text-muted-foreground">{e.actor_email}</span>
                        )}
                        {e.ip && <span className="text-xs text-muted-foreground">{e.ip}</span>}
                        <span className="ml-auto text-xs text-muted-foreground">{timeAgo(e.created_at)}</span>
                      </li>
                    ))}
                  </ul>
                )}
              </div>
            </details>
          </>
        )}
      </CardContent>
    </Card>
  );
}

function AlertRow({
  alert,
  onUpdate,
  pending,
}: {
  alert: BridgeSecurityAlert;
  onUpdate: (v: { id: string; status: "acknowledged" | "resolved" }) => void;
  pending: boolean;
}) {
  const open = alert.status === "open";
  return (
    <div
      className={`flex flex-wrap items-center gap-x-3 gap-y-2 rounded-md border p-3 ${
        open ? "border-destructive/40 bg-destructive/5" : "border-border bg-muted/30"
      }`}
    >
      <div className="min-w-0">
        <div className="flex flex-wrap items-center gap-2">
          <span className="font-semibold">{label(alert.event_type)}</span>
          <Badge variant={open ? "destructive" : "secondary"}>{alert.status}</Badge>
          <span className="text-sm text-muted-foreground">
            {alert.event_count} in {alert.window_minutes}m (threshold {alert.threshold})
          </span>
        </div>
        <p className="text-xs text-muted-foreground">
          First {timeAgo(alert.first_seen)} · last {timeAgo(alert.last_seen)}
          {alert.sample_ip ? ` · ${alert.sample_ip}` : ""}
          {alert.sample_actor_email ? ` · ${alert.sample_actor_email}` : ""}
        </p>
      </div>
      {open && (
        <div className="ml-auto flex gap-2">
          <Button
            variant="outline"
            size="sm"
            disabled={pending}
            onClick={() => onUpdate({ id: alert.id, status: "acknowledged" })}
          >
            Acknowledge
          </Button>
          <Button
            size="sm"
            disabled={pending}
            onClick={() => onUpdate({ id: alert.id, status: "resolved" })}
          >
            Resolve
          </Button>
        </div>
      )}
    </div>
  );
}
