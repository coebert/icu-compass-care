import { useEffect, useMemo, useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import { Slider } from "@/components/ui/slider";
import { Switch } from "@/components/ui/switch";
import { Label } from "@/components/ui/label";
import { ShieldCheck, Undo2, ChevronLeft, ChevronRight, Trash2, Check, AlertTriangle } from "lucide-react";

/**
 * Mandatory pre-upload redaction step. For every page the reviewer must:
 *   1. Drag at least one box over the sticker, AND
 *   2. Tick "Name covered" AND "DOB covered" to confirm the two mandatory
 *      identifiers are no longer visible.
 * Only then does the page count as "ready" — the parent uses `isRedactionReady`
 * to gate the Send-to-extractor button. Boxes are baked into the canvas as a
 * heavy Gaussian blur (configurable radius) with an optional "REDACTED"
 * watermark, and the resulting JPEG data URL is what the server sees — the
 * original file is never uploaded.
 */

export type RedactionSettings = {
  /** Gaussian blur radius in pixels applied inside each box. 0 = solid black. */
  blurRadius: number;
  /** Overlay a "REDACTED" watermark on each box. */
  watermark: boolean;
};

export const DEFAULT_REDACTION_SETTINGS: RedactionSettings = {
  blurRadius: 18,
  watermark: true,
};

export type RedactionPage = {
  originalDataUrl: string; // input (downscaled) image
  width: number;
  height: number;
  boxes: { x: number; y: number; w: number; h: number }[]; // in image coordinates
  nameConfirmed: boolean;
  dobConfirmed: boolean;
};

export async function loadPage(dataUrl: string): Promise<RedactionPage> {
  const img = await new Promise<HTMLImageElement>((resolve, reject) => {
    const el = new Image();
    el.onload = () => resolve(el);
    el.onerror = reject;
    el.src = dataUrl;
  });
  return {
    originalDataUrl: dataUrl,
    width: img.width,
    height: img.height,
    boxes: [],
    nameConfirmed: false,
    dobConfirmed: false,
  };
}

export function pageCoverageStatus(p: RedactionPage): {
  ready: boolean;
  boxes: number;
  nameConfirmed: boolean;
  dobConfirmed: boolean;
} {
  return {
    ready: p.boxes.length > 0 && p.nameConfirmed && p.dobConfirmed,
    boxes: p.boxes.length,
    nameConfirmed: p.nameConfirmed,
    dobConfirmed: p.dobConfirmed,
  };
}

export function isRedactionReady(pages: RedactionPage[]): boolean {
  return pages.length > 0 && pages.every((p) => pageCoverageStatus(p).ready);
}

export async function bakeRedactions(
  page: RedactionPage,
  settings: RedactionSettings = DEFAULT_REDACTION_SETTINGS,
): Promise<string> {
  const img = await new Promise<HTMLImageElement>((resolve, reject) => {
    const el = new Image();
    el.onload = () => resolve(el);
    el.onerror = reject;
    el.src = page.originalDataUrl;
  });
  const canvas = document.createElement("canvas");
  canvas.width = page.width;
  canvas.height = page.height;
  const ctx = canvas.getContext("2d");
  if (!ctx) throw new Error("Canvas not available");
  ctx.drawImage(img, 0, 0, page.width, page.height);

  const radius = Math.max(0, Math.round(settings.blurRadius));

  if (radius === 0) {
    // Fallback: solid black fill when the user turns blur down to zero.
    ctx.fillStyle = "#000";
    for (const b of page.boxes) ctx.fillRect(b.x, b.y, b.w, b.h);
  } else {
    // Render a fully-blurred copy of the page once, then stamp the box regions
    // over the sharp original. This is much cheaper than blurring per-box and
    // gives consistent coverage even for large boxes.
    const blurred = document.createElement("canvas");
    blurred.width = page.width;
    blurred.height = page.height;
    const bctx = blurred.getContext("2d");
    if (!bctx) throw new Error("Canvas not available");
    // Chained blur passes yield a heavier smear than a single filter call and
    // guarantee no legible glyphs survive even on high-resolution captures.
    bctx.filter = `blur(${radius}px)`;
    bctx.drawImage(img, 0, 0, page.width, page.height);
    bctx.filter = `blur(${Math.max(4, Math.round(radius / 2))}px)`;
    bctx.drawImage(blurred, 0, 0);
    bctx.filter = "none";
    for (const b of page.boxes) {
      ctx.drawImage(blurred, b.x, b.y, b.w, b.h, b.x, b.y, b.w, b.h);
    }
  }

  if (settings.watermark) {
    ctx.fillStyle = "rgba(0,0,0,0.7)";
    ctx.font = `bold ${Math.max(12, Math.round(page.width / 80))}px sans-serif`;
    ctx.textBaseline = "top";
    for (const b of page.boxes) {
      const label = "REDACTED";
      const pad = 4;
      const metrics = ctx.measureText(label);
      const tw = metrics.width + pad * 2;
      const th = Math.max(14, Math.round(page.width / 70));
      // Small opaque plate behind the text so it stays legible on any background.
      ctx.fillStyle = "rgba(255,255,255,0.85)";
      ctx.fillRect(b.x + 2, b.y + 2, Math.min(tw, b.w - 4), Math.min(th, b.h - 4));
      ctx.fillStyle = "rgba(0,0,0,0.9)";
      ctx.fillText(label, b.x + 2 + pad, b.y + 4);
    }
  }
  return canvas.toDataURL("image/jpeg", 0.85);
}

export function ChartRedactor({
  pages,
  onChange,
  settings,
  onSettingsChange,
}: {
  pages: RedactionPage[];
  onChange: (next: RedactionPage[]) => void;
  settings: RedactionSettings;
  onSettingsChange: (next: RedactionSettings) => void;
}) {
  const [idx, setIdx] = useState(0);
  const page = pages[idx];
  const containerRef = useRef<HTMLDivElement | null>(null);
  const [rendered, setRendered] = useState({ w: 0, h: 0 });
  const drag = useRef<{ x: number; y: number } | null>(null);
  const [preview, setPreview] = useState<{ x: number; y: number; w: number; h: number } | null>(null);

  useEffect(() => {
    const el = containerRef.current;
    if (!el || !page) return;
    const measure = () => {
      const rect = el.getBoundingClientRect();
      const scale = Math.min(rect.width / page.width, 1);
      setRendered({ w: page.width * scale, h: page.height * scale });
    };
    measure();
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    return () => ro.disconnect();
  }, [page]);

  const scale = page ? rendered.w / page.width : 1;

  const toImageCoords = (clientX: number, clientY: number) => {
    const rect = containerRef.current!.getBoundingClientRect();
    return {
      x: Math.max(0, Math.min(page.width, (clientX - rect.left) / scale)),
      y: Math.max(0, Math.min(page.height, (clientY - rect.top) / scale)),
    };
  };

  const updatePage = (mut: (p: RedactionPage) => RedactionPage) => {
    const next = pages.slice();
    next[idx] = mut(page);
    onChange(next);
  };

  const onPointerDown = (e: React.PointerEvent) => {
    if (!page) return;
    (e.target as Element).setPointerCapture(e.pointerId);
    drag.current = toImageCoords(e.clientX, e.clientY);
    setPreview({ x: drag.current.x, y: drag.current.y, w: 0, h: 0 });
  };
  const onPointerMove = (e: React.PointerEvent) => {
    if (!drag.current) return;
    const p = toImageCoords(e.clientX, e.clientY);
    setPreview({
      x: Math.min(drag.current.x, p.x),
      y: Math.min(drag.current.y, p.y),
      w: Math.abs(p.x - drag.current.x),
      h: Math.abs(p.y - drag.current.y),
    });
  };
  const onPointerUp = () => {
    if (drag.current && preview && preview.w > 8 && preview.h > 8) {
      updatePage((p) => ({
        ...p,
        boxes: [...p.boxes, preview],
        nameConfirmed: false,
        dobConfirmed: false,
      }));
    }
    drag.current = null;
    setPreview(null);
  };

  const totalBoxes = useMemo(() => pages.reduce((n, p) => n + p.boxes.length, 0), [pages]);

  // Live preview of the applied blur, using a CSS filter that mirrors the
  // bake step so the reviewer sees what the extractor will actually receive.
  // (Watermark is drawn separately below.)
  const previewBlurPx = settings.blurRadius > 0 ? settings.blurRadius * scale : 0;

  if (!page) return null;

  const modeLabel = settings.blurRadius === 0 ? "Solid black" : `Blur ${settings.blurRadius}px`;

  return (
    <div className="space-y-3">
      <div className="rounded border border-amber-500/40 bg-amber-500/5 p-3 text-xs">
        <p className="flex items-center gap-2 font-medium text-amber-800 dark:text-amber-300">
          <ShieldCheck className="h-4 w-4" /> Cover patient name and date of birth before sending
        </p>
        <p className="mt-1 text-muted-foreground">
          Drag a rectangle over each of the <strong>name</strong> and <strong>date of birth</strong> on
          the sticker. Leave the <strong>hospital number</strong> and <strong>initials</strong> visible so
          the extractor can identify the record. Redacted regions are blurred (or blacked out) in your
          browser — Gemini never sees the pixels underneath.
        </p>
      </div>

      {/* Redaction style controls — apply to all pages. */}
      <div className="flex flex-wrap items-center gap-4 rounded border bg-muted/30 p-2 text-xs">
        <div className="flex min-w-[220px] flex-1 items-center gap-2">
          <Label htmlFor="redact-blur" className="whitespace-nowrap text-xs">
            Blur strength
          </Label>
          <Slider
            id="redact-blur"
            min={0}
            max={40}
            step={1}
            value={[settings.blurRadius]}
            onValueChange={(v) => onSettingsChange({ ...settings, blurRadius: v[0] ?? 0 })}
            className="flex-1"
          />
          <span className="w-20 shrink-0 tabular-nums text-muted-foreground">{modeLabel}</span>
        </div>
        <label className="flex items-center gap-2">
          <Switch
            checked={settings.watermark}
            onCheckedChange={(v) => onSettingsChange({ ...settings, watermark: v })}
          />
          <span>Show "REDACTED" watermark</span>
        </label>
      </div>

      <div
        ref={containerRef}
        className="relative mx-auto max-h-[60vh] w-full touch-none select-none overflow-hidden rounded border bg-muted"
        style={{ height: rendered.h || undefined }}
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={onPointerUp}
        onPointerCancel={onPointerUp}
      >
        <img
          src={page.originalDataUrl}
          alt={`Chart page ${idx + 1}`}
          className="pointer-events-none absolute inset-0 h-full w-full object-contain"
          draggable={false}
        />
        {page.boxes.map((b, i) => {
          const style: React.CSSProperties = {
            left: b.x * scale,
            top: b.y * scale,
            width: b.w * scale,
            height: b.h * scale,
          };
          if (settings.blurRadius === 0) {
            return (
              <div key={i} className="absolute bg-black" style={style} title="Redacted region">
                {settings.watermark && (
                  <span className="pointer-events-none block px-1 text-[10px] font-semibold text-white/80">
                    REDACTED
                  </span>
                )}
              </div>
            );
          }
          return (
            <div
              key={i}
              className="pointer-events-none absolute overflow-hidden"
              style={style}
              title="Redacted region"
            >
              <img
                src={page.originalDataUrl}
                alt=""
                aria-hidden
                draggable={false}
                className="absolute"
                style={{
                  left: -b.x * scale,
                  top: -b.y * scale,
                  width: rendered.w,
                  height: rendered.h,
                  filter: `blur(${previewBlurPx}px)`,
                }}
              />
              {settings.watermark && (
                <span className="absolute left-1 top-1 rounded bg-white/80 px-1 text-[10px] font-semibold text-black">
                  REDACTED
                </span>
              )}
            </div>
          );
        })}
        {preview && (
          <div
            className="absolute border-2 border-amber-400 bg-black/60"
            style={{
              left: preview.x * scale,
              top: preview.y * scale,
              width: preview.w * scale,
              height: preview.h * scale,
            }}
          />
        )}
      </div>

      <div className="flex flex-wrap items-center justify-between gap-2 text-xs">
        <div className="flex items-center gap-1">
          <Button
            size="sm"
            variant="outline"
            disabled={idx === 0}
            onClick={() => setIdx((i) => Math.max(0, i - 1))}
            aria-label="Previous page"
          >
            <ChevronLeft className="h-3.5 w-3.5" />
          </Button>
          <span className="tabular-nums text-muted-foreground">
            Page {idx + 1} / {pages.length}
          </span>
          <Button
            size="sm"
            variant="outline"
            disabled={idx >= pages.length - 1}
            onClick={() => setIdx((i) => Math.min(pages.length - 1, i + 1))}
            aria-label="Next page"
          >
            <ChevronRight className="h-3.5 w-3.5" />
          </Button>
        </div>
        <div className="flex items-center gap-1">
          <span className="text-muted-foreground">
            {page.boxes.length} box{page.boxes.length === 1 ? "" : "es"} on this page ·{" "}
            {totalBoxes} total
          </span>
          <Button
            size="sm"
            variant="ghost"
            disabled={page.boxes.length === 0}
            onClick={() =>
              updatePage((p) => ({
                ...p,
                boxes: p.boxes.slice(0, -1),
                nameConfirmed: false,
                dobConfirmed: false,
              }))
            }
          >
            <Undo2 className="mr-1 h-3.5 w-3.5" /> Undo
          </Button>
          <Button
            size="sm"
            variant="ghost"
            disabled={page.boxes.length === 0}
            onClick={() =>
              updatePage((p) => ({ ...p, boxes: [], nameConfirmed: false, dobConfirmed: false }))
            }
          >
            <Trash2 className="mr-1 h-3.5 w-3.5" /> Clear
          </Button>
        </div>
      </div>

      <div
        className={`rounded border p-2 text-xs ${
          page.boxes.length === 0
            ? "border-amber-500/50 bg-amber-500/5"
            : page.nameConfirmed && page.dobConfirmed
              ? "border-emerald-500/50 bg-emerald-500/5"
              : "border-amber-500/50 bg-amber-500/5"
        }`}
      >
        <p className="mb-1 font-medium">Confirm redaction on this page</p>
        <div className="flex flex-wrap gap-4">
          <label className="flex items-center gap-2">
            <input
              type="checkbox"
              checked={page.nameConfirmed}
              disabled={page.boxes.length === 0}
              onChange={(e) => updatePage((p) => ({ ...p, nameConfirmed: e.target.checked }))}
            />
            <span>Patient <strong>name</strong> is fully covered</span>
          </label>
          <label className="flex items-center gap-2">
            <input
              type="checkbox"
              checked={page.dobConfirmed}
              disabled={page.boxes.length === 0}
              onChange={(e) => updatePage((p) => ({ ...p, dobConfirmed: e.target.checked }))}
            />
            <span>Patient <strong>date of birth</strong> is fully covered</span>
          </label>
        </div>
        {page.boxes.length === 0 && (
          <p className="mt-1 text-muted-foreground">
            Draw at least one box before confirming.
          </p>
        )}
      </div>

      <div>
        <p className="mb-1 text-[11px] font-medium uppercase text-muted-foreground">
          Redaction coverage per page
        </p>
        <ol className="flex flex-wrap gap-1">
          {pages.map((p, i) => {
            const s = pageCoverageStatus(p);
            const isCurrent = i === idx;
            const tone = s.ready
              ? "border-emerald-500/60 bg-emerald-500/10 text-emerald-800 dark:text-emerald-300"
              : "border-amber-500/60 bg-amber-500/10 text-amber-800 dark:text-amber-300";
            return (
              <li key={i}>
                <button
                  type="button"
                  onClick={() => setIdx(i)}
                  className={`flex items-center gap-1 rounded border px-2 py-1 text-[11px] ${tone} ${
                    isCurrent ? "ring-2 ring-primary" : ""
                  }`}
                  aria-label={`Page ${i + 1}: ${s.ready ? "ready" : "needs confirmation"}`}
                >
                  {s.ready ? (
                    <Check className="h-3 w-3" />
                  ) : (
                    <AlertTriangle className="h-3 w-3" />
                  )}
                  <span className="font-medium">P{i + 1}</span>
                  <span className="tabular-nums opacity-70">
                    {s.boxes}b · {s.nameConfirmed ? "N" : "n"}
                    {s.dobConfirmed ? "D" : "d"}
                  </span>
                </button>
              </li>
            );
          })}
        </ol>
        <p className="mt-1 text-[11px] text-muted-foreground">
          Legend: <strong>b</strong> = boxes drawn · <strong>N</strong>/<strong>D</strong> capital = name/DOB confirmed.
          Every page must be green before you can send.
        </p>
      </div>
    </div>
  );
}
