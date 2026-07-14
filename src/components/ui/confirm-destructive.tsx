import * as React from "react";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
  AlertDialogTrigger,
} from "@/components/ui/alert-dialog";

type ConfirmDestructiveProps = {
  /**
   * The trigger element (usually a delete/remove button). Rendered as-is via `asChild`,
   * so pass a real Button with your own icon + aria-label.
   */
  children: React.ReactElement;
  title: string;
  /** Short plain-English explanation of what will be permanently removed. */
  description: React.ReactNode;
  confirmLabel?: string;
  cancelLabel?: string;
  onConfirm: () => void;
  /** Disable the trigger without unmounting the dialog. */
  disabled?: boolean;
};

/**
 * Shared confirmation for any clinically significant delete/destroy action.
 * Wrap the trigger button with this instead of wiring up AlertDialog by hand
 * so the wording, layout, and destructive-action colour stay consistent across
 * the whole app.
 */
export function ConfirmDestructive({
  children,
  title,
  description,
  confirmLabel = "Delete",
  cancelLabel = "Cancel",
  onConfirm,
  disabled,
}: ConfirmDestructiveProps) {
  return (
    <AlertDialog>
      <AlertDialogTrigger asChild disabled={disabled}>
        {children}
      </AlertDialogTrigger>
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>{title}</AlertDialogTitle>
          <AlertDialogDescription>{description}</AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogCancel>{cancelLabel}</AlertDialogCancel>
          <AlertDialogAction
            className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
            onClick={onConfirm}
          >
            {confirmLabel}
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}
