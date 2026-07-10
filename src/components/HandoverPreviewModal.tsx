import { useEffect, useState } from "react";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogFooter,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { FileDown, X } from "lucide-react";
import {
  handoverPdfPreviewUrl,
  downloadHandoverFromUrl,
  type HandoverPatient,
} from "@/lib/handover-pdf";

/**
 * Renders the landscape handover PDF in an embedded viewer so the user can
 * review it before downloading. The PDF is (re)built whenever the modal opens
 * with a fresh set of patients, and the object URL is revoked on close to
 * avoid leaking blob URLs.
 */
export function HandoverPreviewModal({
  open,
  onOpenChange,
  patients,
  title,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  patients: HandoverPatient[];
  title?: string;
}) {
  const [url, setUrl] = useState<string | null>(null);

  useEffect(() => {
    if (!open) return;
    const objectUrl = handoverPdfPreviewUrl(patients, { title });
    setUrl(objectUrl);
    return () => {
      URL.revokeObjectURL(objectUrl);
      setUrl(null);
    };
  }, [open, patients, title]);

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="flex h-[92vh] max-w-[min(96vw,1200px)] flex-col gap-4">
        <DialogHeader>
          <DialogTitle>Handover PDF preview</DialogTitle>
        </DialogHeader>

        <div className="min-h-0 flex-1 overflow-hidden rounded-md border bg-muted">
          {url ? (
            <iframe
              title="Handover PDF preview"
              src={`${url}#toolbar=1&view=FitH`}
              className="h-full w-full"
            />
          ) : (
            <div className="flex h-full items-center justify-center text-sm text-muted-foreground">
              Preparing preview…
            </div>
          )}
        </div>

        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)} className="gap-1.5">
            <X className="h-4 w-4" /> Close
          </Button>
          <Button
            disabled={!url}
            className="gap-1.5"
            onClick={() => url && downloadHandoverFromUrl(url)}
          >
            <FileDown className="h-4 w-4" /> Download PDF
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
