import { createFileRoute, Link } from "@tanstack/react-router";
import { useMemo, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useServerFn } from "@tanstack/react-start";
import { toast } from "sonner";
import { ArrowLeft, Check, ClipboardCheck, Clock, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Textarea } from "@/components/ui/textarea";
import { ListSkeleton } from "@/components/LoadingSkeleton";
import { listChecklistProposals, reviewChecklistProposal } from "@/lib/checklists.functions";
import { formatTargetMinutes, roleLabel } from "@/lib/checklists";
import { fmtDateTime } from "@/lib/icu";

export const Route = createFileRoute("/_authenticated/checklist-approvals")({
  component: ChecklistApprovalsPage,
  head: () => ({
    meta: [
      { title: "Checklist approvals — ICU Handover" },
      {
        name: "description",
        content:
          "Unit administrators review and approve checklist changes before they appear on patient checklist tabs.",
      },
      { property: "og:title", content: "Checklist approvals — ICU Handover" },
      {
        property: "og:description",
        content: "Queued checklist edits awaiting administrator review, with approve or reject decisions recorded.",
      },
      { property: "og:type", content: "website" },
      { name: "twitter:card", content: "summary" },
    ],
  }),
});

type ProposalItem = {
  key: string;
  label: string;
  hint?: string | null;
  responsible?: string | null;
  accountable?: string | null;
  target_minutes?: number | null;
  critical?: boolean | null;
};

type Proposal = {
  id: string;
  template_id: string | null;
  kind: "create" | "update";
  name: string;
  description: string | null;
  specialty: string | null;
  items: ProposalItem[];
  note: string | null;
  status: "pending" | "approved" | "rejected";
  proposed_by_email: string | null;
  reviewed_by_email: string | null;
  reviewed_at: string | null;
  review_note: string | null;
  created_at: string;
};

function ChecklistApprovalsPage() {
  const qc = useQueryClient();
  const list = useServerFn(listChecklistProposals);
  const review = useServerFn(reviewChecklistProposal);
  const [notes, setNotes] = useState<Record<string, string>>({});

  const { data, isLoading, error } = useQuery({
    queryKey: ["checklist-proposals"],
    queryFn: () => list() as unknown as Promise<{ canReview: boolean; proposals: Proposal[] }>,
    retry: false,
  });

  const reviewM = useMutation({
    mutationFn: (v: { id: string; decision: "approved" | "rejected" }) =>
      review({ data: { id: v.id, decision: v.decision, review_note: notes[v.id]?.trim() || null } }),
    onSuccess: (_r, v) => {
      void qc.invalidateQueries({ queryKey: ["checklist-proposals"] });
      void qc.invalidateQueries({ queryKey: ["checklist-templates"] });
      toast.success(v.decision === "approved" ? "Change approved and published" : "Change rejected");
    },
    onError: (e: Error) => toast.error(e.message || "Could not record that decision"),
  });

  const pending = useMemo(() => (data?.proposals ?? []).filter((p) => p.status === "pending"), [data]);
  const decided = useMemo(() => (data?.proposals ?? []).filter((p) => p.status !== "pending"), [data]);
  const canReview = data?.canReview ?? false;

  if (error) {
    return (
      <Card>
        <CardContent className="py-12 text-center text-muted-foreground">
          You do not have permission to view checklist approvals.
        </CardContent>
      </Card>
    );
  }

  return (
    <div className="space-y-4">
      <Button asChild variant="outline" size="sm" className="gap-1.5">
        <Link to="/admin">
          <ArrowLeft className="h-4 w-4" /> Back to admin
        </Link>
      </Button>

      <div className="min-w-0">
        <h1 className="text-2xl font-bold">Checklist approvals</h1>
        <p className="text-sm text-muted-foreground">
          Changes to checklists made by clinical staff wait here. Nothing reaches a patient&apos;s
          checklist tab until an administrator approves it. Administrators&apos; own changes go live
          immediately and are recorded in the version history.
        </p>
      </div>

      {isLoading ? (
        <ListSkeleton rows={3} />
      ) : (
        <>
          <Card>
            <CardHeader className="flex-row items-center justify-between gap-2 space-y-0">
              <CardTitle className="flex items-center gap-2 text-base">
                <Clock className="h-4 w-4 text-amber-600" /> Awaiting review
              </CardTitle>
              <Badge variant={pending.length ? "default" : "secondary"}>{pending.length}</Badge>
            </CardHeader>
            <CardContent className="space-y-4">
              {pending.length === 0 ? (
                <p className="text-sm text-muted-foreground">No checklist changes are waiting.</p>
              ) : (
                pending.map((p) => (
                  <div key={p.id} className="rounded-lg border border-amber-300/60 bg-amber-50/40 p-3 dark:bg-amber-950/10">
                    <ProposalHeader p={p} />
                    <ProposalItems items={p.items} />
                    {p.note ? (
                      <p className="mt-2 text-sm">
                        <span className="text-muted-foreground">Reason: </span>
                        {p.note}
                      </p>
                    ) : null}
                    {canReview ? (
                      <div className="mt-3 space-y-2">
                        <Textarea
                          rows={2}
                          placeholder="Review note (optional)"
                          value={notes[p.id] ?? ""}
                          onChange={(e) => setNotes((n) => ({ ...n, [p.id]: e.target.value }))}
                        />
                        <div className="flex flex-wrap gap-2">
                          <Button
                            size="sm"
                            className="gap-1.5"
                            disabled={reviewM.isPending}
                            onClick={() => reviewM.mutate({ id: p.id, decision: "approved" })}
                          >
                            <Check className="h-4 w-4" /> Approve &amp; publish
                          </Button>
                          <Button
                            size="sm"
                            variant="outline"
                            className="gap-1.5"
                            disabled={reviewM.isPending}
                            onClick={() => reviewM.mutate({ id: p.id, decision: "rejected" })}
                          >
                            <X className="h-4 w-4" /> Reject
                          </Button>
                        </div>
                      </div>
                    ) : (
                      <p className="mt-2 text-xs text-muted-foreground">
                        An administrator will review this change.
                      </p>
                    )}
                  </div>
                ))
              )}
            </CardContent>
          </Card>

          <Card>
            <CardHeader>
              <CardTitle className="flex items-center gap-2 text-base">
                <ClipboardCheck className="h-4 w-4" /> Decided
              </CardTitle>
            </CardHeader>
            <CardContent className="space-y-3">
              {decided.length === 0 ? (
                <p className="text-sm text-muted-foreground">No decisions recorded yet.</p>
              ) : (
                decided.map((p) => (
                  <div key={p.id} className="rounded-lg border p-3">
                    <ProposalHeader p={p} />
                    {p.review_note ? (
                      <p className="mt-1 text-sm">
                        <span className="text-muted-foreground">Review note: </span>
                        {p.review_note}
                      </p>
                    ) : null}
                    <p className="mt-1 text-xs text-muted-foreground">
                      {p.status === "approved" ? "Approved" : "Rejected"} by{" "}
                      {p.reviewed_by_email ?? "an administrator"}
                      {p.reviewed_at ? ` on ${fmtDateTime(p.reviewed_at)}` : ""}
                    </p>
                  </div>
                ))
              )}
            </CardContent>
          </Card>
        </>
      )}
    </div>
  );
}

function ProposalHeader({ p }: { p: Proposal }) {
  return (
    <div className="flex flex-wrap items-center gap-2">
      <span className="font-semibold">{p.name}</span>
      <Badge variant="outline">{p.kind === "create" ? "New checklist" : "Edit"}</Badge>
      {p.specialty ? <Badge variant="secondary">{p.specialty}</Badge> : null}
      {p.status !== "pending" ? (
        <Badge variant={p.status === "approved" ? "default" : "destructive"}>
          {p.status === "approved" ? "Approved" : "Rejected"}
        </Badge>
      ) : null}
      <span className="text-xs text-muted-foreground">
        proposed by {p.proposed_by_email ?? "a member of staff"} · {fmtDateTime(p.created_at)}
      </span>
    </div>
  );
}

function ProposalItems({ items }: { items: ProposalItem[] }) {
  return (
    <ol className="mt-2 space-y-1 text-sm">
      {items.map((it, i) => (
        <li key={it.key || i} className="flex flex-wrap items-baseline gap-x-2">
          <span className="text-muted-foreground">{i + 1}.</span>
          <span className="font-medium">{it.label}</span>
          {it.critical ? <Badge variant="destructive">Key</Badge> : null}
          {it.target_minutes ? (
            <Badge variant="outline">{formatTargetMinutes(it.target_minutes)}</Badge>
          ) : null}
          {it.responsible ? (
            <span className="text-xs text-muted-foreground">{roleLabel(it.responsible)}</span>
          ) : null}
          {it.hint ? <span className="text-xs text-muted-foreground">— {it.hint}</span> : null}
        </li>
      ))}
    </ol>
  );
}
