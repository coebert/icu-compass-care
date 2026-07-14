import { useQuery } from "@tanstack/react-query";
import { useServerFn } from "@tanstack/react-start";
import type { Investigation as DomainInvestigation } from "@/lib/domain-types";
import { listInvestigations } from "@/lib/investigations.functions";
import { fmtDateTime } from "@/lib/icu";
import { RECENT_INVESTIGATION_CATEGORIES, mostRecentInvestigation } from "@/lib/handover-pdf";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { FlaskConical, Clock } from "lucide-react";

type Investigation = DomainInvestigation & Record<string, any>;

export function RecentInvestigations({ patientId }: { patientId: string }) {
  const listInv = useServerFn(listInvestigations);
  const { data: investigations = [], isLoading } = useQuery({
    queryKey: ["investigations", patientId],
    queryFn: () => listInv({ data: { patientId } }) as Promise<Investigation[]>,
  });

  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2 text-base">
          <FlaskConical className="h-4 w-4" /> Most recent investigations
        </CardTitle>
      </CardHeader>
      <CardContent className="grid gap-4 sm:grid-cols-3">
        {RECENT_INVESTIGATION_CATEGORIES.map((category) => {
          const latest = mostRecentInvestigation(investigations, category);
          return (
            <div key={category} className="rounded-md border border-border p-3">
              <p className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
                {category}
              </p>
              {isLoading ? (
                <TextSkeleton className="mt-1" />

              ) : latest ? (
                <>
                  <p className="mt-1 whitespace-pre-wrap text-sm">
                    {latest.findings?.trim() ? latest.findings : "—"}
                  </p>
                  <p className="mt-1 flex items-center gap-1 text-xs text-muted-foreground">
                    <Clock className="h-3 w-3" />
                    {latest.result_at ? fmtDateTime(latest.result_at) : "Date not recorded"}
                  </p>
                </>
              ) : (
                <p className="mt-1 text-sm text-muted-foreground">No result recorded</p>
              )}
            </div>
          );
        })}
      </CardContent>
    </Card>
  );
}
