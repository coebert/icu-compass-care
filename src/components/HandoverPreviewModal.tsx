import { useEffect, useMemo, useState } from "react";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogFooter,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import { Slider } from "@/components/ui/slider";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { FileDown, X } from "lucide-react";
import {
  handoverPdfPreviewUrl,
  downloadHandoverFromUrl,
  type HandoverPatient,
  type HandoverPdfOptions,
  type HandoverPageSize,
} from "@/lib/handover-pdf";

/**
 * Renders the landscape handover PDF in an embedded viewer so the user can
 * review it before downloading, with configurable header (title, subtitle,
 * generated timestamp) and footer (custom text, page numbers). The PDF is
 * rebuilt whenever the config changes, and object URLs are revoked to avoid
 * leaking blob URLs.
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

  // Configurable header/footer state.
  const [headerTitle, setHeaderTitle] = useState(title ?? "ICU Handover Sheet");
  const [subtitle, setSubtitle] = useState("");
  const [footerText, setFooterText] = useState(
    "Confidential — patient identifiable information",
  );
  const [showTimestamp, setShowTimestamp] = useState(true);
  const [showPageNumbers, setShowPageNumbers] = useState(true);
  const [pageSize, setPageSize] = useState<HandoverPageSize>("a4");
  const [marginX, setMarginX] = useState(8);
  const [fontScale, setFontScale] = useState(1);

  // Keep the title in sync when the caller's default changes (e.g. archive toggle).
  useEffect(() => {
    if (title) setHeaderTitle(title);
  }, [title]);

  const options = useMemo<HandoverPdfOptions>(
    () => ({
      title: headerTitle,
      subtitle,
      footerText,
      showTimestamp,
      showPageNumbers,
      pageSize,
      marginX,
      fontScale,
    }),
    [headerTitle, subtitle, footerText, showTimestamp, showPageNumbers, pageSize, marginX, fontScale],
  );

  useEffect(() => {
    if (!open) return;
    const objectUrl = handoverPdfPreviewUrl(patients, options);
    setUrl(objectUrl);
    return () => {
      URL.revokeObjectURL(objectUrl);
      setUrl(null);
    };
  }, [open, patients, options]);

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="flex h-[92vh] max-w-[min(96vw,1200px)] flex-col gap-4">
        <DialogHeader>
          <DialogTitle>Handover PDF preview</DialogTitle>
        </DialogHeader>

        {/* Header / footer configuration */}
        <div className="grid gap-3 rounded-md border bg-muted/40 p-3 sm:grid-cols-2 lg:grid-cols-3">
          <div className="space-y-1">
            <Label htmlFor="pdf-title" className="text-xs">Header title</Label>
            <Input
              id="pdf-title"
              value={headerTitle}
              onChange={(e) => setHeaderTitle(e.target.value)}
              placeholder="ICU Handover Sheet"
            />
          </div>
          <div className="space-y-1">
            <Label htmlFor="pdf-subtitle" className="text-xs">Subtitle (optional)</Label>
            <Input
              id="pdf-subtitle"
              value={subtitle}
              onChange={(e) => setSubtitle(e.target.value)}
              placeholder="e.g. Critical Care Unit"
            />
          </div>
          <div className="space-y-1">
            <Label htmlFor="pdf-footer" className="text-xs">Footer text</Label>
            <Input
              id="pdf-footer"
              value={footerText}
              onChange={(e) => setFooterText(e.target.value)}
              placeholder="Confidential…"
            />
          </div>
          <div className="flex items-center gap-2">
            <Switch id="pdf-timestamp" checked={showTimestamp} onCheckedChange={setShowTimestamp} />
            <Label htmlFor="pdf-timestamp" className="text-xs">Show generated timestamp</Label>
          </div>
          <div className="flex items-center gap-2">
            <Switch id="pdf-pages" checked={showPageNumbers} onCheckedChange={setShowPageNumbers} />
            <Label htmlFor="pdf-pages" className="text-xs">Show page numbers</Label>
          <div className="space-y-1">
            <Label htmlFor="pdf-pagesize" className="text-xs">Page size</Label>
            <Select value={pageSize} onValueChange={(v) => setPageSize(v as HandoverPageSize)}>
              <SelectTrigger id="pdf-pagesize">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="a4">A4</SelectItem>
                <SelectItem value="letter">Letter</SelectItem>
              </SelectContent>
            </Select>
          </div>
          <div className="space-y-1">
            <Label htmlFor="pdf-margin" className="text-xs">Margin: {marginX} mm</Label>
            <Slider
              id="pdf-margin"
              min={2}
              max={30}
              step={1}
              value={[marginX]}
              onValueChange={([v]) => setMarginX(v)}
              className="pt-2"
            />
          </div>
          <div className="space-y-1">
            <Label htmlFor="pdf-fontscale" className="text-xs">Font scale: {Math.round(fontScale * 100)}%</Label>
            <Slider
              id="pdf-fontscale"
              min={0.6}
              max={1.6}
              step={0.05}
              value={[fontScale]}
              onValueChange={([v]) => setFontScale(v)}
              className="pt-2"
            />
          </div>
        </div>

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
