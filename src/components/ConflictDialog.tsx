import { useState, useCallback } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { useRouter } from "@tanstack/react-router";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { AlertTriangle, RefreshCw } from "lucide-react";

/**
 * Detects the `"CONFLICT: …"` prefix the server prepends to
 * optimistic-concurrency errors (see updatePatient) and strips it.
 */
export function parseConflict(e: unknown): string | null {
  const msg = e instanceof Error ? e.message : typeof e === "string" ? e : "";
  if (!msg.startsWith("CONFLICT:")) return null;
  return msg.replace("CONFLICT:", "").trim();
}

type ConflictState = {
  message: string;
  /** React Query keys to invalidate on "Reload latest". */
  invalidateKeys?: (string | number | (string | number)[])[];
};

/**
 * Shared conflict dialog + hook. Replaces the transient
 * "Edit conflict" toast that clinicians could miss. Whenever a
 * mutation rejects with a `CONFLICT:` error, call `showConflict(e, opts)`
 * and render `<ConflictDialog />`.
 */
export function useConflictDialog() {
  const [state, setState] = useState<ConflictState | null>(null);
  const qc = useQueryClient();
  const router = useRouter();

  const showConflict = useCallback(
    (e: unknown, opts?: { invalidateKeys?: ConflictState["invalidateKeys"] }): boolean => {
      const message = parseConflict(e);
      if (!message) return false;
      setState({ message, invalidateKeys: opts?.invalidateKeys });
      return true;
    },
    [],
  );

  const dismiss = useCallback(() => setState(null), []);

  const reload = useCallback(async () => {
    const keys = state?.invalidateKeys ?? [];
    await Promise.all(
      keys.map((k) =>
        qc.invalidateQueries({ queryKey: Array.isArray(k) ? k : [k] }),
      ),
    );
    await router.invalidate();
    setState(null);
  }, [state, qc, router]);

  const dialog = (
    <Dialog open={!!state} onOpenChange={(v) => !v && dismiss()}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2 text-amber-700 dark:text-amber-400">
            <AlertTriangle className="h-5 w-5" />
            Someone else changed this record
          </DialogTitle>
          <DialogDescription className="pt-2 text-foreground">
            {state?.message ?? ""}
          </DialogDescription>
        </DialogHeader>
        <div className="rounded-md border bg-muted/50 p-3 text-sm text-muted-foreground">
          <p className="font-medium text-foreground">Your changes were not saved.</p>
          <p className="mt-1">
            The safe option is to reload the latest version, review what
            changed, and re-apply your edit. If you save on top, you will
            silently overwrite whatever the other clinician just wrote.
          </p>
        </div>
        <DialogFooter className="gap-2 sm:gap-0">
          <Button variant="outline" onClick={dismiss}>
            Keep editing (do not save)
          </Button>
          <Button onClick={reload} className="gap-1.5">
            <RefreshCw className="h-4 w-4" />
            Reload latest
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );

  return { showConflict, dismiss, dialog };
}
