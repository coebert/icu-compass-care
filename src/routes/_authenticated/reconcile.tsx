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
import {
  RECON_REASON_TEXT,
  RECON_STATE_LABEL,
  classifyLoadError,
  LOAD_ERROR_TEXT,
} from "@/lib/reconcile-text";
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

export const Route = createFileRoute("/_authenticated/reconcile")({
  head: () => ({
    meta: [
      { title: "Cross-project sync review · ICU Handover Hub" },
      {
        name: "description",
        content: "Trust administrator review of records shared with Critical Care Connect.",
      },
    ],
  }),
  component: ReconcilePage,
});

const ENTITY_LABELS: Record<ReconEntity, string> = {
  notifications: "Notifications",
  referrals: "Referrals",
  audit_log: "Audit events",
};

function stateBadge(state: ReconRow["state"]) {
  const label = RECON_STATE_LABEL[state];
  switch (state) {
    case "conflict":
      return <Badge variant="destructive">{label}</Badge>;
    case "diverged":
    case "remote_only":
      return <Badge>{label}</Badge>;
    case "held":
    case "local_only":
      return <Badge variant="secondary">{label}</Badge>;
    default:
      return <Badge variant="outline">{label}</Badge>;
  }
}

function shortTime(iso: string | null): string {
  if (!iso) return "—";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "—";
  return d.toLocaleString("en-GB", { hour12: false, hourCycle: "h23" });
}

function ReconcilePage() {
  const qc = useQueryClient();
  const fetchRecon = useServerFn(getReconciliation);
  const pull = useServerFn(reconcilePartner);

  const { data, isLoading, error, isFetching, refetch, dataUpdatedAt } = useQuery({
    queryKey: ["reconciliation"],
    queryFn: () => fetchRecon() as Promise<EntityRecon[]>,
    retry: false,
  });

  const pullMut = useMutation({
    mutationFn: (v: { entity: "referrals"; ids: string[] | "all" }) => pull({ data: v }),
    onSuccess: (res) => {
      void qc.invalidateQueries({ queryKey: ["reconciliation"] });
      void qc.invalidateQueries({ queryKey: ["referral-candidates"] });
      if (res.errors.length > 0 || res.failed > 0 || res.conflicts > 0) {
        toast.warning(
          `Updated ${res.applied}. ${res.conflicts} need review here (pulling again won't change them). ${res.failed} failed.`,
          { description: res.errors.join(" ") || undefined },
        );
      } else {
        toast.success(
          `Updated ${res.applied} record${res.applied === 1 ? "" : "s"}` +
            (res.skipped > 0 ? `; ${res.skipped} already up to date or removal recorded` : ""),
        );
      }
    },
    onError: (e: unknown) => {
      const kind = classifyLoadError(e, typeof navigator === "undefined" || navigator.onLine);
      toast.error("Pull didn't complete", {
        description:
          kind === "denied" || kind === "session" || kind === "offline"
            ? LOAD_ERROR_TEXT[kind]
            : "Nothing was confirmed. Refresh to see the current state.",
      });
    },
  });

  const errorKind = error
    ? classifyLoadError(error, typeof navigator === "undefined" || navigator.onLine)
    : null;
  const busy = isFetching || pullMut.isPending;

  // No data to show at all: permission problem or a failed first load.
  if (errorKind && !data) {
    return (
      <Card>
        <CardContent
          role="alert"
          className="flex flex-col items-center gap-4 py-12 text-center text-muted-foreground"
        >
          <p>{LOAD_ERROR_TEXT[errorKind]}</p>
          {errorKind !== "denied" && (
            <Button
              variant="outline"
              className="h-11 gap-1.5 sm:h-9"
              disabled={isFetching}
              onClick={() => void refetch()}
            >
              <RefreshCw className={`h-4 w-4 ${isFetching ? "animate-spin" : ""}`} /> Try again
            </Button>
          )}
        </CardContent>
      </Card>
    );
  }

  const entities = data ?? [];

  return (
    <div className="space-y-6">
      <div className="flex flex-col gap-3 sm:flex-row sm:items-center">
        <div>
          <h1 className="text-2xl font-bold">Cross-project sync review</h1>
          <p className="text-sm text-muted-foreground">
            Compare notifications, referrals and audit events with Critical Care Connect. Referrals
            can be pulled through the checked import, which never overwrites a copy changed or
            created here. Notifications and audit events are review only.
          </p>
        </div>
        <div className="flex flex-wrap items-center gap-3 sm:ml-auto">
          <Button
            variant="outline"
            className="h-11 gap-1.5 sm:h-9"
            onClick={() => void refetch()}
            disabled={isFetching}
          >
            <RefreshCw className={`h-4 w-4 ${isFetching ? "animate-spin" : ""}`} /> Refresh
          </Button>
        </div>
      </div>

      {errorKind && data && (
        <div
          role="alert"
          className="flex flex-wrap items-center gap-2 rounded-md border border-destructive/40 bg-destructive/5 p-3 text-sm text-destructive"
        >
          <AlertTriangle className="h-4 w-4" aria-hidden="true" />
          <span>
            {LOAD_ERROR_TEXT[errorKind]} Showing the comparison from{" "}
            {shortTime(new Date(dataUpdatedAt).toISOString())}, which may be out of date.
          </span>
          {errorKind !== "denied" && (
            <Button
              size="sm"
              variant="outline"
              className="h-11 sm:ml-auto sm:h-9"
              disabled={isFetching}
              onClick={() => void refetch()}
            >
              Try again
            </Button>
          )}
        </div>
      )}

      <BridgeHealthCheck />

      {isLoading ? (
        <p role="status" className="text-sm text-muted-foreground">
          Comparing with Critical Care Connect…
        </p>
      ) : (
        <Tabs defaultValue="notifications">
          <TabsList className="flex h-12 w-full max-w-full items-stretch justify-start gap-1 overflow-x-auto sm:h-9">
            {entities.map((e) => (
              <TabsTrigger key={e.entity} value={e.entity} className="gap-1.5">
                {ENTITY_LABELS[e.entity]}
                {e.error ? (
                  <AlertTriangle className="h-3.5 w-3.5 text-destructive" aria-label="error" />
                ) : (
                  e.mismatches.length > 0 && (
                    <Badge variant="secondary" className="ml-1">
                      {e.mismatches.length}
                    </Badge>
                  )
                )}
              </TabsTrigger>
            ))}
          </TabsList>

          {entities.map((e) => (
            <TabsContent key={e.entity} value={e.entity} className="space-y-4">
              <EntityCard
                e={e}
                stale={Boolean(errorKind)}
                busy={busy}
                onRetry={() => void refetch()}
                onPull={(ids) => pullMut.mutate({ entity: "referrals", ids })}
              />
            </TabsContent>
          ))}
        </Tabs>
      )}
    </div>
  );
}

function EntityCard({
  e,
  stale,
  busy,
  onRetry,
  onPull,
}: {
  e: EntityRecon;
  stale: boolean;
  busy: boolean;
  onRetry: () => void;
  onPull: (ids: string[] | "all") => void;
}) {
  const canPull = e.importable && !e.error && !stale && e.mismatches.some((m) => m.pullable);
  const needsReview = e.mismatches.filter((m) => m.state === "conflict" || m.state === "held");
  return (
    <Card>
      <CardHeader className="flex flex-col gap-3 space-y-0 sm:flex-row sm:items-center">
        <div>
          <CardTitle className="text-base">{ENTITY_LABELS[e.entity]}</CardTitle>
          {!e.error && (
            <p className="text-xs text-muted-foreground">
              {e.localCount} here · {e.remoteCount} on partner · {e.matched} in sync
            </p>
          )}
        </div>
        {!e.importable ? (
          <span className="text-xs text-muted-foreground sm:ml-auto">
            Review only — not copied into this app
          </span>
        ) : (
          canPull && (
            <Button
              size="sm"
              className="h-11 gap-1.5 sm:ml-auto sm:h-9"
              disabled={busy}
              onClick={() => onPull("all")}
            >
              <ArrowDownToLine className="h-4 w-4" aria-hidden="true" /> Pull all from partner
            </Button>
          )
        )}
      </CardHeader>
      <CardContent className="space-y-3">
        {e.error ? (
          <div
            role="alert"
            className="flex flex-wrap items-center gap-2 rounded-md border border-destructive/40 bg-destructive/5 p-3 text-sm text-destructive"
          >
            <AlertTriangle className="h-4 w-4" aria-hidden="true" />
            <span>{e.error}</span>
            <Button
              size="sm"
              variant="outline"
              className="h-11 sm:ml-auto sm:h-9"
              disabled={busy}
              onClick={onRetry}
            >
              Try again
            </Button>
          </div>
        ) : (
          <>
            {!e.partnerListComplete && (
              <p className="rounded-md border p-3 text-sm text-muted-foreground">
                Critical Care Connect didn't confirm its list is complete, so records missing from
                it may simply not have been sent.
              </p>
            )}
            {needsReview.length > 0 && (
              <p className="rounded-md border border-destructive/40 p-3 text-sm">
                {needsReview.length} need{needsReview.length === 1 ? "s" : ""} a person to review.
                Pulling won't change {needsReview.length === 1 ? "it" : "them"}.
              </p>
            )}
            {e.mismatches.length === 0 ? (
              <p className="py-6 text-center text-sm text-muted-foreground">
                {e.partnerListComplete
                  ? "Everything is in sync with Critical Care Connect."
                  : "No differences in the records compared."}
              </p>
            ) : (
              <>
                <ul className="space-y-3 sm:hidden">
                  {e.mismatches.map((m) => (
                    <li key={m.id} className="space-y-2 rounded-md border p-3">
                      <div className="flex items-start justify-between gap-2">
                        <div className="min-w-0">
                          <p className="font-medium">{m.label}</p>
                          <p className="truncate text-xs text-muted-foreground">
                            {m.sub || m.id.slice(0, 8)}
                          </p>
                        </div>
                        {stateBadge(m.state)}
                      </div>
                      <p className="text-sm text-muted-foreground">{RECON_REASON_TEXT[m.reason]}</p>
                      <p className="text-xs text-muted-foreground">
                        Here {shortTime(m.localVersion)} · Partner {shortTime(m.remoteVersion)}
                      </p>
                      <RowAction e={e} m={m} stale={stale} busy={busy} onPull={onPull} />
                    </li>
                  ))}
                </ul>
                <div className="hidden sm:block">
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
                            <p className="max-w-[28rem] text-xs text-muted-foreground">
                              {RECON_REASON_TEXT[m.reason]}
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
                            <RowAction e={e} m={m} stale={stale} busy={busy} onPull={onPull} />
                          </TableCell>
                        </TableRow>
                      ))}
                    </TableBody>
                  </Table>
                </div>
              </>
            )}
          </>
        )}
      </CardContent>
    </Card>
  );
}

function RowAction({
  e,
  m,
  stale,
  busy,
  onPull,
}: {
  e: EntityRecon;
  m: ReconRow;
  stale: boolean;
  busy: boolean;
  onPull: (ids: string[]) => void;
}) {
  if (!e.importable) return <span className="text-xs text-muted-foreground">Review only</span>;
  if (!m.pullable) {
    return (
      <span className="text-xs text-muted-foreground">
        {m.state === "conflict" || m.state === "held" ? "Review by hand" : "No action needed"}
      </span>
    );
  }
  return (
    <Button
      variant="outline"
      size="sm"
      className="h-11 gap-1.5 sm:h-9"
      disabled={busy || stale}
      aria-label={`Pull ${m.label} from Critical Care Connect`}
      onClick={() => onPull([m.id])}
    >
      <ArrowDownToLine className="h-3.5 w-3.5" aria-hidden="true" /> Pull
    </Button>
  );
}
