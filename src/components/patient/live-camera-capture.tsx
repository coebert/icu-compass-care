import { useEffect, useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import { Camera, X, RefreshCw, Check, AlertTriangle, SwitchCamera } from "lucide-react";
import { loadPage, type RedactionPage } from "@/components/patient/chart-redactor";

/**
 * Live camera capture that pulls frames directly from getUserMedia and hands
 * them to the redaction flow. No file input, no image written to the device's
 * gallery — the frame is grabbed to an in-memory canvas and released as soon
 * as the caller consumes it.
 *
 * Governance:
 *  - Video stream tracks are stopped on unmount and whenever the user cancels.
 *  - Frames are downscaled to ≤2000px longest edge and JPEG-encoded (canvas
 *    re-encode strips EXIF/GPS).
 *  - Nothing hits the network from this component; the redactor + extractor
 *    pipeline downstream continues to bake redactions before upload.
 */
export function LiveCameraCapture({
  maxPages = 3,
  onDone,
  onCancel,
}: {
  maxPages?: number;
  onDone: (pages: RedactionPage[]) => void;
  onCancel: () => void;
}) {
  const videoRef = useRef<HTMLVideoElement | null>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const [facing, setFacing] = useState<"environment" | "user">("environment");
  const [starting, setStarting] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [pages, setPages] = useState<RedactionPage[]>([]);

  useEffect(() => {
    let cancelled = false;
    async function start() {
      setStarting(true);
      setError(null);
      // Tear down any previous stream before requesting a new one
      if (streamRef.current) {
        streamRef.current.getTracks().forEach((t) => t.stop());
        streamRef.current = null;
      }
      try {
        if (!navigator.mediaDevices?.getUserMedia) {
          throw new Error("Camera access is not available in this browser.");
        }
        const stream = await navigator.mediaDevices.getUserMedia({
          video: {
            facingMode: { ideal: facing },
            width: { ideal: 1920 },
            height: { ideal: 1440 },
          },
          audio: false,
        });
        if (cancelled) {
          stream.getTracks().forEach((t) => t.stop());
          return;
        }
        streamRef.current = stream;
        const v = videoRef.current;
        if (v) {
          v.srcObject = stream;
          v.playsInline = true;
          v.muted = true;
          await v.play().catch(() => {});
        }
      } catch (err) {
        const msg =
          err instanceof Error
            ? err.name === "NotAllowedError"
              ? "Camera permission denied. Enable camera access in your browser settings and try again."
              : err.name === "NotFoundError"
                ? "No camera was found on this device."
                : err.message
            : "Could not open the camera.";
        setError(msg);
      } finally {
        if (!cancelled) setStarting(false);
      }
    }
    void start();
    return () => {
      cancelled = true;
      if (streamRef.current) {
        streamRef.current.getTracks().forEach((t) => t.stop());
        streamRef.current = null;
      }
    };
  }, [facing]);

  const capture = async () => {
    const v = videoRef.current;
    if (!v || !v.videoWidth || !v.videoHeight) {
      setError("Camera not ready yet — hold on a moment and try again.");
      return;
    }
    const maxEdge = 2000;
    const scale = Math.min(1, maxEdge / Math.max(v.videoWidth, v.videoHeight));
    const w = Math.round(v.videoWidth * scale);
    const h = Math.round(v.videoHeight * scale);
    const canvas = document.createElement("canvas");
    canvas.width = w;
    canvas.height = h;
    const ctx = canvas.getContext("2d");
    if (!ctx) {
      setError("Canvas not available.");
      return;
    }
    ctx.drawImage(v, 0, 0, w, h);
    const dataUrl = canvas.toDataURL("image/jpeg", 0.85);
    const page = await loadPage(dataUrl);
    setPages((prev) => [...prev, page].slice(0, maxPages));
  };

  const removeLast = () => setPages((prev) => prev.slice(0, -1));

  const finish = () => {
    if (pages.length === 0) return;
    // Stop stream first so the camera light turns off immediately
    if (streamRef.current) {
      streamRef.current.getTracks().forEach((t) => t.stop());
      streamRef.current = null;
    }
    onDone(pages);
  };

  const cancel = () => {
    if (streamRef.current) {
      streamRef.current.getTracks().forEach((t) => t.stop());
      streamRef.current = null;
    }
    onCancel();
  };

  return (
    <div className="space-y-3">
      <div className="relative overflow-hidden rounded border bg-black">
        <video
          ref={videoRef}
          className="block h-auto w-full max-h-[55vh] object-contain"
          playsInline
          muted
        />
        {starting && (
          <div className="absolute inset-0 flex items-center justify-center bg-black/60 text-xs text-white">
            Starting camera…
          </div>
        )}
        {!starting && !error && (
          <button
            type="button"
            onClick={() => setFacing((f) => (f === "environment" ? "user" : "environment"))}
            className="absolute right-2 top-2 rounded-full bg-black/50 p-2 text-white hover:bg-black/70"
            title="Switch camera"
            aria-label="Switch camera"
          >
            <SwitchCamera className="h-4 w-4" />
          </button>
        )}
      </div>

      {error && (
        <p className="flex items-center gap-2 text-sm text-destructive">
          <AlertTriangle className="h-4 w-4" /> {error}
        </p>
      )}

      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="text-xs text-muted-foreground">
          Captured {pages.length} / {maxPages} page{maxPages === 1 ? "" : "s"}. No photo is
          saved to your device — frames are grabbed directly from the camera.
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <Button variant="ghost" size="sm" onClick={cancel} className="gap-1">
            <X className="h-4 w-4" /> Cancel
          </Button>
          {pages.length > 0 && (
            <Button variant="outline" size="sm" onClick={removeLast} className="gap-1">
              <RefreshCw className="h-4 w-4" /> Retake last
            </Button>
          )}
          <Button
            size="sm"
            onClick={capture}
            disabled={starting || !!error || pages.length >= maxPages}
            className="gap-1"
          >
            <Camera className="h-4 w-4" />
            {pages.length === 0 ? "Capture page" : `Capture page ${pages.length + 1}`}
          </Button>
          <Button
            size="sm"
            onClick={finish}
            disabled={pages.length === 0}
            className="gap-1"
          >
            <Check className="h-4 w-4" /> Use {pages.length} page{pages.length === 1 ? "" : "s"}
          </Button>
        </div>
      </div>
    </div>
  );
}
