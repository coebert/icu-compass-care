import { useMutation } from "@tanstack/react-query";
import { useServerFn } from "@tanstack/react-start";
import { checkBridgeHealth, type BridgeHealthResult } from "@/lib/bridge-health.functions";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { CheckCircle2, XCircle, ShieldCheck, Stethoscope, Loader2 } from "lucide-react";
import { toast } from "sonner";

function StatusRow({ ok, label, detail }: { ok: boolean; label: string; detail?: string }) {
  return (
    <div className="flex items-start gap-2 text-sm">
      {ok ? (
        <CheckCircle2 className="mt-0.5 h-4 w-4 shrink-0 text-emerald-600" />
      ) : (
        <XCircle className="mt-0.5 h-4 w-4 shrink-0 text-destructive" />
      )}
      <div>
        <span className="font-medium">{label}</span>
        {detail ? <span className="text-muted-foreground"> — {detail}</span> : null}
      </div>
    </div>
  );
}

export function BridgeHealthCheck() {
  const run = useServerFn(checkBridgeHealth);

  const mut = useMutation({
    mutationFn: () => run() as Promise<BridgeHealthResult>,
    onSuccess: (r) => {
      if (r.ok) toast.success("Bridge health check passed");
      else toast.warning("Bridge health check found issues");
    },
    onError: (e: Error) => toast.error("Health check failed", { description: e.message }),
  });

  const r = mut.data;

  return (
    <Card>
      <CardHeader className="flex flex-row items-center justify-between gap-3 space-y-0">
        <div>
          <CardTitle className="flex items-center gap-2 text-base">
            <ShieldCheck className="h-4 w-4" /> Bridge health check
          </CardTitle>
          <p className="mt-1 text-sm text-muted-foreground">
            Verify the linked project's bridge endpoints, signature auth, and a clean sample payload.
          </p>
        </div>
        <Button onClick={() => mut.mutate()} disabled={mut.isPending} className="gap-1.5">
          {mut.isPending ? <Loader2 className="h-4 w-4 animate-spin" /> : <Stethoscope className="h-4 w-4" />}
          Run check
        </Button>
      </CardHeader>

      {r ? (
        <CardContent className="space-y-4">
          <div className="flex items-center gap-2">
            {r.ok ? (
              <Badge className="bg-emerald-600 hover:bg-emerald-600/90">All checks passed</Badge>
            ) : (
              <Badge variant="destructive">Issues found</Badge>
            )}
            <span className="text-xs text-muted-foreground">
              {r.config.partnerHost ?? "partner not configured"} · {new Date(r.checkedAt).toLocaleTimeString()}
            </span>
          </div>

          <div className="space-y-1.5">
            <StatusRow ok={r.config.partnerUrlConfigured} label="Partner URL configured" />
            <StatusRow ok={r.config.secretConfigured} label="Shared secret configured" />
            <StatusRow
              ok={r.signatureAuth.validAccepted}
              label="Valid signatures accepted"
            />
            <StatusRow
              ok={r.signatureAuth.invalidRejected}
              label="Tampered signatures rejected"
            />
          </div>

          <div>
            <p className="mb-1.5 text-xs font-semibold uppercase text-muted-foreground">Endpoints</p>
            <div className="space-y-1.5">
              {r.endpoints.map((e) => (
                <StatusRow
                  key={e.path}
                  ok={e.ok}
                  label={e.label}
                  detail={
                    e.ok
                      ? `HTTP ${e.status}${e.recordCount != null ? ` · ${e.recordCount} rows` : ""}`
                      : `HTTP ${e.status}${e.error ? ` · ${e.error}` : ""}`
                  }
                />
              ))}
            </div>
          </div>

          <div>
            <p className="mb-1.5 text-xs font-semibold uppercase text-muted-foreground">Sample payload</p>
            <StatusRow
              ok={r.samplePayload.clean}
              label={
                r.samplePayload.clean
                  ? "No dob / nhs_number keys present"
                  : `Forbidden keys present: ${r.samplePayload.forbiddenKeysPresent.join(", ")}`
              }
            />
            {r.samplePayload.sample ? (
              <pre className="mt-2 overflow-x-auto rounded-md bg-muted p-3 text-xs">
                {JSON.stringify(r.samplePayload.sample, null, 2)}
              </pre>
            ) : (
              <p className="mt-1 text-xs text-muted-foreground">
                No patient rows on the partner side to sample (contract still verified clean).
              </p>
            )}
          </div>
        </CardContent>
      ) : (
        <CardContent className="text-sm text-muted-foreground">
          Run the check to verify the cross-project bridge end-to-end.
        </CardContent>
      )}
    </Card>
  );
}
