import { useState } from "react";
import { toast } from "sonner";
import { Shield } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { AccessReasonDialog } from "@/components/AccessReasonDialog";
import { ROLE_DESCRIPTIONS, ROLE_LABELS, type UiRole } from "@/lib/roles";

/**
 * Changing someone's role is an access-control decision, so it always records a
 * reason in the tamper-evident access log (account_access_events).
 *
 * Which roles appear is decided by the caller: a unit administrator may only
 * assign clinician / unit administrator, and the server enforces the same rule.
 */
export function RoleChanger({
  who,
  current,
  options,
  pending,
  onChange,
  label = "Change role",
}: {
  who: string;
  current: UiRole;
  options: readonly UiRole[];
  pending: boolean;
  onChange: (next: UiRole, reason: string) => void;
  label?: string;
}) {
  const [next, setNext] = useState<UiRole>(current);
  const fieldId = `role-${who.replace(/\W+/g, "-")}`;
  return (
    <AccessReasonDialog
      title={`Change the role for ${who}?`}
      description="Roles decide what someone can see and change. The new role takes effect immediately and is recorded in the access change log."
      confirmLabel="Change role"
      pending={pending}
      extra={
        <div className="space-y-1.5">
          <Label htmlFor={fieldId}>New role</Label>
          <Select value={next} onValueChange={(v) => setNext(v as UiRole)}>
            <SelectTrigger id={fieldId}>
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {options.map((r) => (
                <SelectItem key={r} value={r}>
                  {ROLE_LABELS[r]}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
          <p className="text-xs text-muted-foreground">{ROLE_DESCRIPTIONS[next]}</p>
        </div>
      }
      onConfirm={(reason) => {
        if (next === current) {
          toast.error("Pick a different role");
          return false;
        }
        onChange(next, reason);
        return true;
      }}
    >
      <Button variant="outline" size="sm" className="gap-1.5">
        <Shield className="h-4 w-4" aria-hidden="true" /> {label}
      </Button>
    </AccessReasonDialog>
  );
}
