import { createFileRoute, Link } from "@tanstack/react-router";
import { useEffect, useMemo, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { useServerFn } from "@tanstack/react-start";
import { z } from "zod";
import { listPatients } from "@/lib/patients.functions";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import { Slider } from "@/components/ui/slider";
import { Checkbox } from "@/components/ui/checkbox";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { ArrowLeft, FileDown } from "lucide-react";
import {
  handoverPdfPreviewUrl,
  downloadHandover,
  HANDOVER_COLUMNS,
  ALL_HANDOVER_COLUMN_KEYS,
  type HandoverPatient,
  type HandoverPdfOptions,
  type HandoverPageSize,
  type HandoverColumnKey,
} from "@/lib/handover-pdf";

const searchSchema = z.object({
  archived: z.boolean().optional().catch(false),
});

export const Route = createFileRoute("/_authenticated/patients/handover-preview")({
  validateSearch: searchSchema,
  component: HandoverPreviewPage,
});

import type { Patient as DomainPatient } from "@/lib/domain-types";
type Patient = DomainPatient & Record<string, any>;

/**
 * Full-page printable preview of the ICU handover sheet. Renders the exact PDF
 * that will be exported inside a large embedded viewer so scaling and
 * pagination can be reviewed at full size before downloading. Page size,
 * margins, font scale and included columns are all adjustable live.
 */
function HandoverPreviewPage() {
  const { archived } = Route.useSearch();
  const list = useServerFn(listPatients);

  const { data: patients = [] } = useQuery({
    queryKey: ["patients"],
    queryFn: () => list() as Promise<Patient[]>,
  });

  const handoverPatients = useMemo<HandoverPatient[]>(() => {
    return patients.filter((p) => {
      const active = p.status === "admitted" || p.status === "referred";
      return archived ? !active : active;
    });
  }, [patients, archived]);

  const [pageSize, setPageSize] = useState<HandoverPageSize>("a4");
  const [marginX, setMarginX] = useState(8);
  const [fontScale, setFontScale] = useState(1);
  const [showTimestamp, setShowTimestamp] = useState(true);
  const [showPageNumbers, setShowPageNumbers] = useState(true);
  const [columns, setColumns] = useState<HandoverColumnKey[]>(ALL_HANDOVER_COLUMN_KEYS);

  const title = archived ? "ICU Handover — Archived" : "ICU Handover Sheet";

  const options = useMemo<HandoverPdfOptions>(
    () => ({
      title,
      showTimestamp,
      showPageNumbers,
      pageSize,
      marginX,
      fontScale,
      columns,
    }),
    [title, showTimestamp, showPageNumbers, pageSize, marginX, fontScale, columns],
  );

  const [url, setUrl] = useState<string | null>(null);

  useEffect(() => {
    const objectUrl = handoverPdfPreviewUrl(handoverPatients, options);
    setUrl(objectUrl);
    return () => {
      URL.revokeObjectURL(objectUrl);
      setUrl(null);
    };
  }, [handoverPatients, options]);

  const toggleColumn = (key: HandoverColumnKey) =>
    setColumns((prev) =>
      prev.includes(key) ? prev.filter((k) => k !== key) : [...prev, key],
    );

  return (
    <div className="flex h-[calc(100dvh-4rem)] flex-col gap-4 p-4 sm:p-6">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex items-center gap-3">
          <Button asChild variant="outline" size="sm" className="gap-1.5">
            <Link to="/patients">
              <ArrowLeft className="h-4 w-4" /> Back to patients
            </Link>
          </Button>
          <div>
            <h1 className="text-lg font-semibold">Printable handover preview</h1>
            <p className="text-xs text-muted-foreground">
              {handoverPatients.length} patient{handoverPatients.length === 1 ? "" : "s"} · review scaling & pagination before exporting
            </p>
          </div>
        </div>
        <Button
          disabled={!url}
          className="gap-1.5"
          onClick={() => downloadHandover(handoverPatients, options)}
        >
          <FileDown className="h-4 w-4" /> Download PDF
        </Button>
      </div>

      <div className="grid min-h-0 flex-1 gap-4 lg:grid-cols-[280px_1fr]">
        {/* Controls */}
        <div className="space-y-4 overflow-y-auto rounded-md border bg-muted/40 p-4">
          <div className="space-y-1">
            <Label htmlFor="pv-pagesize" className="text-xs">Page size</Label>
            <Select value={pageSize} onValueChange={(v) => setPageSize(v as HandoverPageSize)}>
              <SelectTrigger id="pv-pagesize" className="h-10">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="a4">A4</SelectItem>
                <SelectItem value="letter">Letter</SelectItem>
              </SelectContent>
            </Select>
          </div>

          <div className="space-y-1">
            <Label htmlFor="pv-margin" className="text-xs">Margin: {marginX} mm</Label>
            <Slider
              id="pv-margin"
              min={2}
              max={30}
              step={1}
              value={[marginX]}
              onValueChange={([v]) => setMarginX(v)}
              className="py-3"
            />
          </div>

          <div className="space-y-1">
            <Label htmlFor="pv-fontscale" className="text-xs">Font scale: {Math.round(fontScale * 100)}%</Label>
            <Slider
              id="pv-fontscale"
              min={0.6}
              max={1.6}
              step={0.05}
              value={[fontScale]}
              onValueChange={([v]) => setFontScale(v)}
              className="py-3"
            />
          </div>

          <div className="flex items-center gap-3">
            <Switch id="pv-timestamp" checked={showTimestamp} onCheckedChange={setShowTimestamp} />
            <Label htmlFor="pv-timestamp" className="text-xs">Show generated timestamp</Label>
          </div>
          <div className="flex items-center gap-3">
            <Switch id="pv-pages" checked={showPageNumbers} onCheckedChange={setShowPageNumbers} />
            <Label htmlFor="pv-pages" className="text-xs">Show page numbers</Label>
          </div>

          <div className="space-y-2">
            <div className="flex items-center justify-between">
              <Label className="text-xs font-medium">Columns to include</Label>
              <div className="flex gap-3">
                <button
                  type="button"
                  className="text-xs text-primary hover:underline"
                  onClick={() => setColumns(ALL_HANDOVER_COLUMN_KEYS)}
                >
                  All
                </button>
                <button
                  type="button"
                  className="text-xs text-muted-foreground hover:underline"
                  onClick={() => setColumns([])}
                >
                  Clear
                </button>
              </div>
            </div>
            <div className="grid grid-cols-1 gap-2">
              {HANDOVER_COLUMNS.map((c) => (
                <label key={c.key} className="flex items-center gap-2 text-xs">
                  <Checkbox
                    checked={columns.includes(c.key)}
                    onCheckedChange={() => toggleColumn(c.key)}
                  />
                  {c.header}
                </label>
              ))}
            </div>
            {columns.length === 0 && (
              <p className="text-[10px] text-muted-foreground">
                No columns selected — all columns will be shown.
              </p>
            )}
          </div>
        </div>

        {/* Preview */}
        <div className="min-h-0 overflow-hidden rounded-md border bg-muted">
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
      </div>
    </div>
  );
}
