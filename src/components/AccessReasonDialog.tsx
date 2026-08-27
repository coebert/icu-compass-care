import * as React from "react";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog";

type Props = {
  children: React.ReactElement;
  title: string;
  description: React.ReactNode;
  confirmLabel: string;
  destructive?: boolean;
  pending?: boolean;
  /** Extra fields rendered above the reason box (e.g. a temporary password). */
  extra?: React.ReactNode;
  /** Return false to keep the dialog open (e.g. extra field invalid). */
  onConfirm: (reason: string) => boolean | void;
};

/**
 * Confirmation dialog that requires the administrator to record WHY an access
 * change is being made. Every provisioning and deprovisioning action is written
 * to the tamper-evident access log with this reason, so information governance
 * reviewers can see the justification alongside the change.
 */
export function AccessReasonDialog({
  children,
  title,
  description,
  confirmLabel,
  destructive = false,
  pending = false,
  extra,
  onConfirm,
}: Props) {
  const [open, setOpen] = React.useState(false);
  const [reason, setReason] = React.useState("");
  const valid = reason.trim().length >= 3;

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        setOpen(next);
        if (!next) setReason("");
      }}
    >
      <DialogTrigger asChild>{children}</DialogTrigger>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{title}</DialogTitle>
          <DialogDescription>{description}</DialogDescription>
        </DialogHeader>
        <div className="space-y-4">
          {extra}
          <div className="space-y-1.5">
            <Label htmlFor="access-reason">Reason (recorded in the access log)</Label>
            <Textarea
              id="access-reason"
              value={reason}
              onChange={(e) => setReason(e.target.value)}
              rows={3}
              placeholder="e.g. New ICU registrar starting rotation on 01/09/2026"
            />
            <p className="text-xs text-muted-foreground">
              At least 3 characters. Stored with your name and the time of the change.
            </p>
          </div>
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={() => setOpen(false)}>
            Cancel
          </Button>
          <Button
            variant={destructive ? "destructive" : "default"}
            disabled={!valid || pending}
            onClick={() => {
              const result = onConfirm(reason.trim());
              if (result !== false) setOpen(false);
            }}
          >
            {pending ? "Working…" : confirmLabel}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
