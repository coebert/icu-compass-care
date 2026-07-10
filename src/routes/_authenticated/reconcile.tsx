import { createFileRoute } from "@tanstack/react-router";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useServerFn } from "@tanstack/react-start";
import {
  getReconciliation,
  reconcilePartner,
  type EntityRecon,
  type ReconEntity,
  type ReconRow,
} from "@/lib/reconcile.functions";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { RefreshCw, ArrowDownToLine, AlertTriangle } from "lucide-react";
import { toast } from "sonner";
import { BridgeHealthCheck } from "@/components/BridgeHealthCheck";
import { SyncStatusPanel } from "@/components/SyncStatusPanel";

export const Route = createFileRoute("/_authenticated/reconcile")({
  component: ReconcilePage,
});

const ENTITY_LABELS: Record<ReconEntity, string> = {
  notifications: "Notifications",
  referrals: "Referrals",
  audit_log: "Audit events",
};

function stateBadge(state: ReconRow["state"]) {
  switch (state) {
    case "diverged":
      return <Badge variant="destructive">Diverged</Badge>;
    case "remote_only":
      return <Badge className="bg-amber-500 hover:bg-amber-500/90">Only on partner</Badge>;
    case "local_only":
      return <Badge variant="secondary">Only here</Badge>;
    default:
      return <Badge variant="outline">Matched</Badge>;
  }
}

function shortTime(iso: string | null): string {
  if (!iso) return "—";
  return new Date(iso).toLocaleString();
}

function ReconcilePage() {
  const qc = useQueryClient();
  const fetchRecon = useServerFn(getReconciliation);
  const pull = useServerFn(reconcilePartner);

  const { data, isLoading, error, isFetching } = useQuery({
    queryKey: ["reconciliation"],
    queryFn: () => fetchRecon() as Promise<EntityRecon[]>,
    retry: false,
  });

  const pullMut = useMutation({
    mutationFn: (v: { entity: ReconEntity; ids: string[] | "all" }) => pull({ data: v }),
    onSuccess: (res) => {
      qc.invalidateQueries({ queryKey: ["reconciliation"] });
      if (res.failed > 0) {
        toast.warning(`Pulled ${res.applied}, ${res.failed} failed`, {
          description: res.errors.join("; ") || undefined,
        });
      } else {
        toast.success(`Reconciled ${res.applied} record${res.applied === 1 ? "" : "s"}`);
      }
    },
    onError: (e: Error) => toast.error("Reconcile failed", { description: e.message }),
  });

  if (error) {
    return (
      <Card>
        <CardContent className="py-12 text-center text-muted-foreground">
          You do not have permission to review cross-project sync.
        </CardContent>
      </Card>
    );
  }

  const entities = data ?? [];

  return (
    <div className="space-y-6">
      <div className="flex items-center gap-3">
        <div>
          <h1 className="text-2xl font-bold">Cross-project sync review</h1>
          <p className="text-sm text-muted-foreground">
            Compare notifications, referrals and audit events against the linked project and
            reconcile any mismatches.
          </p>
        </div>
        <div className="ml-auto flex items-center gap-3">
          <SyncStatusPanel />
          <Button
            variant="outline"
            size="sm"
            className="gap-1.5"
            onClick={() => qc.invalidateQueries({ queryKey: ["reconciliation"] })}
            disabled={isFetching}
          >
            <RefreshCw className={`h-4 w-4 ${isFetching ? "animate-spin" : ""}`} /> Refresh
          </Button>
        </div>
      </div>

      <BridgeHealthCheck />

      {isLoading ? (
        <p className="text-sm text-muted-foreground">Comparing with the linked project…</p>
      ) : (
        <Tabs defaultValue="notifications">
          <TabsList>
            {entities.map((e) => (
              <TabsTrigger key={e.entity} value={e.entity} className="gap-1.5">
                {ENTITY_LABELS[e.entity]}
                {e.mismatches.length > 0 && (
                  <Badge variant="secondary" className="ml-1">{e.mismatches.length}</Badge>
                )}
              </TabsTrigger>
            ))}
          </TabsList>

          {entities.map((e) => (
            <TabsContent key={e.entity} value={e.entity} className="space-y-4">
              <Card>
                <CardHeader className="flex flex-row items-center gap-3 space-y-0">
                  <div>
                    <CardTitle className="text-base">{ENTITY_LABELS[e.entity]}</CardTitle>
                    <p className="text-xs text-muted-foreground">
                      {e.localCount} here · {e.remoteCount} on partner · {e.matched} in sync
                    </p>
                  </div>
                  {e.mismatches.some((m) => m.state !== "local_only") && (
                    <Button
                      size="sm"
                      className="ml-auto gap-1.5"
                      disabled={pullMut.isPending}
                      onClick={() => pullMut.mutate({ entity: e.entity, ids: "all" })}
                    >
                      <ArrowDownToLine className="h-4 w-4" /> Pull all from partner
                    </Button>
                  )}
                </CardHeader>
                <CardContent>
                  {e.error ? (
                    <div className="flex items-center gap-2 rounded-md border border-destructive/40 bg-destructive/5 p-3 text-sm text-destructive">
                      <AlertTriangle className="h-4 w-4" /> {e.error}
                    </div>
                  ) : e.mismatches.length === 0 ? (
                    <p className="py-6 text-center text-sm text-muted-foreground">
                      Everything is in sync with the linked project.
                    </p>
                  ) : (
                    <Table>
                      <TableHeader>
                        <TableRow>
                          <TableHead>Record</TableHead>
                          <TableHead>Status</TableHead>
                          <TableHead>Here</TableHead>
                          <TableHead>Partner</TableHead>
                          <TableHead className="text-right">Action</TableHead>
                        </TableRow>
                      </TableHeader>
                      <TableBody>
                        {e.mismatches.map((m) => (
                          <TableRow key={m.id}>
                            <TableCell>
                              <p className="font-medium">{m.label}</p>
                              <p className="max-w-[22rem] truncate text-xs text-muted-foreground">
                                {m.sub || m.id.slice(0, 8)}
                              </p>
                            </TableCell>
                            <TableCell>{stateBadge(m.state)}</TableCell>
                            <TableCell className="text-xs text-muted-foreground">
                              {shortTime(m.localVersion)}
                            </TableCell>
                            <TableCell className="text-xs text-muted-foreground">
                              {shortTime(m.remoteVersion)}
                            </TableCell>
                            <TableCell className="text-right">
                              {m.state === "local_only" ? (
                                <span className="text-xs text-muted-foreground">
                                  partner must pull
                                </span>
                              ) : (
                                <Button
                                  variant="outline"
                                  size="sm"
                                  className="gap-1.5"
                                  disabled={pullMut.isPending}
                                  onClick={() =>
                                    pullMut.mutate({ entity: e.entity, ids: [m.id] })
                                  }
                                >
                                  <ArrowDownToLine className="h-3.5 w-3.5" /> Pull
                                </Button>
                              )}
                            </TableCell>
                          </TableRow>
                        ))}
                      </TableBody>
                    </Table>
                  )}
                </CardContent>
              </Card>
            </TabsContent>
          ))}
        </Tabs>
      )}
    </div>
  );
}
