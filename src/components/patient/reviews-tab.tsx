import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useServerFn } from "@tanstack/react-start";
import type { PatientReview as DomainReview } from "@/lib/domain-types";
import {
  listPatientReviews,
  addPatientReview,
  updatePatientReview,
  deletePatientReview,
  REVIEW_SPECIALTIES,
} from "@/lib/patient-reviews.functions";
import { fmtDateTime } from "@/lib/icu";
import { InfoBlock } from "@/components/patient/shared";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { Card, CardContent } from "@/components/ui/card";
import { SectionUpdated } from "@/components/patient/section-updated";
import { Badge } from "@/components/ui/badge";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { DateTimePicker } from "@/components/ui/date-picker";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Pencil, Trash2, Plus, Clock, Users } from "lucide-react";
import { toast } from "sonner";

type Review = DomainReview & Record<string, any>;

export function ReviewsTab({ patientId }: { patientId: string }) {
  const qc = useQueryClient();
  const listReviews = useServerFn(listPatientReviews);
  const addReview = useServerFn(addPatientReview);
  const editReview = useServerFn(updatePatientReview);
  const removeReview = useServerFn(deletePatientReview);

  const [dialogOpen, setDialogOpen] = useState(false);
  const [editId, setEditId] = useState<string | null>(null);
  const [specialty, setSpecialty] = useState<string>(REVIEW_SPECIALTIES[0]);
  const [review, setReview] = useState("");
  const [plan, setPlan] = useState("");
  const [reviewedAt, setReviewedAt] = useState<string>("");

  const { data: reviews = [], isLoading } = useQuery({
    queryKey: ["patient-reviews", patientId],
    queryFn: () => listReviews({ data: { patientId } }) as Promise<Review[]>,
  });

  const invalidate = () => qc.invalidateQueries({ queryKey: ["patient-reviews", patientId] });

  const openAdd = () => {
    setEditId(null);
    setSpecialty(REVIEW_SPECIALTIES[0]);
    setReview("");
    setPlan("");
    setReviewedAt(new Date().toISOString());
    setDialogOpen(true);
  };

  const openEdit = (r: Review) => {
    setEditId(r.id);
    setSpecialty(r.specialty);
    setReview(r.review ?? "");
    setPlan(r.plan ?? "");
    setReviewedAt(r.reviewed_at ?? new Date().toISOString());
    setDialogOpen(true);
  };

  const saveMut = useMutation({
    mutationFn: () =>
      editId
        ? editReview({ data: { id: editId, specialty, review, plan, reviewed_at: reviewedAt } as never })
        : addReview({ data: { patient_id: patientId, specialty, review, plan, reviewed_at: reviewedAt } as never }),
    onSuccess: () => {
      invalidate();
      setDialogOpen(false);
      toast.success(editId ? "Review updated" : "Review added");
    },
    onError: (e: Error) => toast.error("Could not save review", { description: e.message }),
  });

  const deleteMut = useMutation({
    mutationFn: (id: string) => removeReview({ data: { id } }),
    onSuccess: () => {
      invalidate();
      toast.success("Review removed");
    },
    onError: (e: Error) => toast.error("Could not remove review", { description: e.message }),
  });

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-start gap-2">
        <div>
          <div className="flex items-center gap-2 text-sm text-muted-foreground">
            <Users className="h-4 w-4" />
            Reviews and plans from specialty teams — retained after discharge.
          </div>
          <SectionUpdated items={reviews} className="mt-0.5" />
        </div>
        <Button size="sm" className="ml-auto gap-1.5" onClick={openAdd}>
          <Plus className="h-4 w-4" /> Add review
        </Button>
      </div>

      {isLoading ? (
        <ListSkeleton rows={3} />
      ) : reviews.length === 0 ? (

        <Card>
          <CardContent className="py-8 text-center text-sm text-muted-foreground">
            No specialty reviews recorded yet.
          </CardContent>
        </Card>
      ) : (
        <div className="space-y-3">
          {reviews.map((r) => (
            <Card key={r.id}>
              <CardContent className="space-y-2 p-4">
                <div className="flex flex-wrap items-center gap-2">
                  <Badge variant="secondary">{r.specialty}</Badge>
                  <span className="ml-auto flex items-center gap-1 text-xs text-muted-foreground">
                    <Clock className="h-3 w-3" />
                    {r.reviewed_at ? fmtDateTime(r.reviewed_at) : "Date not recorded"}
                  </span>
                </div>
                <InfoBlock label="Review" value={r.review} />
                <InfoBlock label="Plan" value={r.plan} />
                <div className="flex gap-1 pt-1">
                  <Button variant="ghost" size="sm" className="h-7 gap-1 px-2 text-xs" onClick={() => openEdit(r)}>
                    <Pencil className="h-3 w-3" /> Edit
                  </Button>
                  <Button
                    variant="ghost"
                    size="sm"
                    className="h-7 gap-1 px-2 text-xs text-destructive"
                    onClick={() => deleteMut.mutate(r.id)}
                  >
                    <Trash2 className="h-3 w-3" /> Remove
                  </Button>
                </div>
              </CardContent>
            </Card>
          ))}
        </div>
      )}

      <Dialog open={dialogOpen} onOpenChange={setDialogOpen}>
        <DialogContent className="max-w-md">
          <DialogHeader>
            <DialogTitle>{editId ? "Edit specialty review" : "Add specialty review"}</DialogTitle>
          </DialogHeader>
          <div className="space-y-4">
            <div className="space-y-1.5">
              <Label>Specialty team</Label>
              <Select value={specialty} onValueChange={setSpecialty}>
                <SelectTrigger><SelectValue /></SelectTrigger>
                <SelectContent>
                  {REVIEW_SPECIALTIES.map((s) => (
                    <SelectItem key={s} value={s}>{s}</SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <div className="space-y-1.5">
              <Label>Date &amp; time of review</Label>
              <DateTimePicker value={reviewedAt} onChange={(v) => setReviewedAt(v ?? "")} />
            </div>
            <div className="space-y-1.5">
              <Label>Review / findings</Label>
              <Textarea
                value={review}
                onChange={(e) => setReview(e.target.value)}
                placeholder="Assessment and impression from the specialty team"
                rows={3}
              />
            </div>
            <div className="space-y-1.5">
              <Label>Plan / recommendations</Label>
              <Textarea
                value={plan}
                onChange={(e) => setPlan(e.target.value)}
                placeholder="Recommended plan and actions"
                rows={3}
              />
            </div>
            <div className="flex justify-end gap-2">
              <Button variant="outline" onClick={() => setDialogOpen(false)}>Cancel</Button>
              <Button onClick={() => saveMut.mutate()} disabled={saveMut.isPending || !reviewedAt}>
                {saveMut.isPending ? "Saving…" : editId ? "Save changes" : "Add review"}
              </Button>
            </div>
          </div>
        </DialogContent>
      </Dialog>
    </div>
  );
}
