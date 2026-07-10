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
import { FileDown, Save, Trash2, X } from "lucide-react";
import {
  handoverPdfPreviewUrl,
  downloadHandoverFromUrl,
  formatHandoverFilename,
  type HandoverPatient,
  type HandoverPdfOptions,
  type HandoverPageSize,
} from "@/lib/handover-pdf";
import {
  loadHandoverPresets,
  saveHandoverPreset,
  deleteHandoverPreset,
  type HandoverPreset,
} from "@/lib/handover-presets";
import { toast } from "sonner";


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
  const [filenameFormat, setFilenameFormat] = useState("{title} - {timestamp}.pdf");
  const [showTimestamp, setShowTimestamp] = useState(true);
  const [showPageNumbers, setShowPageNumbers] = useState(true);
  const [pageSize, setPageSize] = useState<HandoverPageSize>("a4");
  const [marginX, setMarginX] = useState(8);
  const [fontScale, setFontScale] = useState(1);

  // Saved header/footer presets (persisted in localStorage across sessions).
  const [presets, setPresets] = useState<HandoverPreset[]>([]);
  const [selectedPresetId, setSelectedPresetId] = useState<string>("");
  const [presetName, setPresetName] = useState("");

  useEffect(() => {
    setPresets(loadHandoverPresets());
  }, []);

  function applyPreset(id: string) {
    const preset = presets.find((p) => p.id === id);
    if (!preset) return;
    const o = preset.options;
    setSelectedPresetId(id);
    setPresetName(preset.name);
    setHeaderTitle(o.title ?? "ICU Handover Sheet");
    setSubtitle(o.subtitle ?? "");
    setFooterText(o.footerText ?? "Confidential — patient identifiable information");
    setFilenameFormat(o.filenameFormat ?? "{title} - {timestamp}.pdf");
    setShowTimestamp(o.showTimestamp ?? true);
    setShowPageNumbers(o.showPageNumbers ?? true);
    setPageSize(o.pageSize ?? "a4");
    setMarginX(o.marginX ?? 8);
    setFontScale(o.fontScale ?? 1);
  }

  function handleSavePreset() {
    const name = presetName.trim();
    if (!name) {
      toast.error("Enter a preset name to save");
      return;
    }
    const next = saveHandoverPreset(name, options);
    setPresets(next);
    const saved = next.find((p) => p.name.toLowerCase() === name.toLowerCase());
    if (saved) setSelectedPresetId(saved.id);
    toast.success(`Saved preset "${name}"`);
  }

  function handleDeletePreset() {
    if (!selectedPresetId) return;
    const removed = presets.find((p) => p.id === selectedPresetId);
    const next = deleteHandoverPreset(selectedPresetId);
    setPresets(next);
    setSelectedPresetId("");
    if (removed) toast.success(`Deleted preset "${removed.name}"`);
  }

  useEffect(() => {
    if (title) setHeaderTitle(title);
  }, [title]);

  const options = useMemo<HandoverPdfOptions>(
    () => ({
      title: headerTitle,
      subtitle,
      footerText,
      filenameFormat,
      showTimestamp,
      showPageNumbers,
      pageSize,
      marginX,
      fontScale,
    }),
    [headerTitle, subtitle, footerText, filenameFormat, showTimestamp, showPageNumbers, pageSize, marginX, fontScale],
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

        {/* Header / footer presets */}
        <div className="flex flex-wrap items-end gap-2 rounded-md border bg-muted/40 p-3">
          <div className="min-w-[180px] flex-1 space-y-1">
            <Label htmlFor="pdf-preset" className="text-xs">Saved preset</Label>
            <Select
              value={selectedPresetId}
              onValueChange={applyPreset}
              disabled={presets.length === 0}
            >
              <SelectTrigger id="pdf-preset">
                <SelectValue placeholder={presets.length ? "Load a preset…" : "No saved presets"} />
              </SelectTrigger>
              <SelectContent>
                {presets.map((p) => (
                  <SelectItem key={p.id} value={p.id}>{p.name}</SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          <div className="min-w-[180px] flex-1 space-y-1">
            <Label htmlFor="pdf-preset-name" className="text-xs">Preset name</Label>
            <Input
              id="pdf-preset-name"
              value={presetName}
              onChange={(e) => setPresetName(e.target.value)}
              placeholder="e.g. Night handover"
            />
          </div>
          <Button variant="secondary" className="gap-1.5" onClick={handleSavePreset}>
            <Save className="h-4 w-4" /> Save
          </Button>
          <Button
            variant="outline"
            className="gap-1.5"
            onClick={handleDeletePreset}
            disabled={!selectedPresetId}
          >
            <Trash2 className="h-4 w-4" /> Delete
          </Button>
        </div>

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
            <Label htmlFor="pdf-filename" className="text-xs">
              Filename format
              <span className="ml-1 font-normal text-muted-foreground">({"{title}, {timestamp}, {date}"})</span>
            </Label>
            <Input
              id="pdf-filename"
              value={filenameFormat}
              onChange={(e) => setFilenameFormat(e.target.value)}
              placeholder="{title} - {timestamp}.pdf"
            />
            <p className="text-[10px] text-muted-foreground">
              Download: {formatHandoverFilename(headerTitle, filenameFormat, new Date())}
            </p>
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
          </div>
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
            onClick={() => url && downloadHandoverFromUrl(url, { title: headerTitle, filenameFormat })}
          >
            <FileDown className="h-4 w-4" /> Download PDF
          </Button>
        </DialogFooter>

      </DialogContent>
    </Dialog>
  );
}
