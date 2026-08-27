import { ListSkeleton } from "@/components/LoadingSkeleton";
import { createFileRoute, Link } from "@tanstack/react-router";
import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useServerFn } from "@tanstack/react-start";
import {
  listStaff,
  listAccessEvents,
  createStaff,
  setStaffRole,
  setStaffSuspended,
  resetStaffPassword,
  deleteStaff,
} from "@/lib/admin.functions";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Textarea } from "@/components/ui/textarea";
import {
  Plus,
  Trash2,
  Shield,
  ShieldOff,
  Eye,
  EyeOff,
  Share2,
  Pill,
  Ban,
  RotateCcw,
  KeyRound,
  History,
} from "lucide-react";
import { AccessReasonDialog } from "@/components/AccessReasonDialog";
import { toast } from "sonner";
import { BridgeSecurityPanel } from "@/components/BridgeSecurityPanel";
import { UnitAccessPanel } from "@/components/UnitAccessPanel";
import { fmtDateTime } from "@/lib/icu";

export const Route = createFileRoute("/_authenticated/admin")({
  component: AdminPage,
});

type Staff = {
  id: string;
  display_name: string;
  email: string | null;
  job_title: string | null;
  roles: string[];
  suspended: boolean;
  last_sign_in_at: string | null;
  created_at: string | null;
};

type AccessEvent = {
  id: string;
  action: string;
  target_email: string | null;
  target_display_name: string | null;
  role: string | null;
  reason: string | null;
  actor_email: string | null;
  created_at: string;
};

const ACTION_LABELS: Record<string, string> = {
  provisioned: "Account created",
  role_changed: "Role changed",
  suspended: "Access suspended",
  reinstated: "Access reinstated",
  password_reset: "Password reset",
  deprovisioned: "Account removed",
};

function AdminPage() {
  const qc = useQueryClient();
  const list = useServerFn(listStaff);
  const events = useServerFn(listAccessEvents);
  const create = useServerFn(createStaff);
  const setRole = useServerFn(setStaffRole);
  const setSuspended = useServerFn(setStaffSuspended);
  const resetPassword = useServerFn(resetStaffPassword);
  const remove = useServerFn(deleteStaff);

  const [open, setOpen] = useState(false);
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [showPassword, setShowPassword] = useState(false);
  const [displayName, setDisplayName] = useState("");
  const [jobTitle, setJobTitle] = useState("");
  const [role, setRole2] = useState<"admin" | "clinician">("clinician");
  const [reason, setReason] = useState("");
  const [newPassword, setNewPassword] = useState("");

  const { data: staff = [], isLoading, error } = useQuery({
    queryKey: ["staff"],
    queryFn: () => list() as Promise<Staff[]>,
    retry: false,
  });

  const { data: accessEvents = [] } = useQuery({
    queryKey: ["access-events"],
    queryFn: () => events() as Promise<AccessEvent[]>,
    retry: false,
    enabled: !error,
  });

  const refresh = () => {
    qc.invalidateQueries({ queryKey: ["staff"] });
    qc.invalidateQueries({ queryKey: ["access-events"] });
  };

  const createMut = useMutation({
    mutationFn: () =>
      create({
        data: {
          email,
          password,
          display_name: displayName,
          job_title: jobTitle || undefined,
          role,
          reason,
        },
      }),
    onSuccess: () => {
      refresh();
      setOpen(false);
      setEmail("");
      setPassword("");
      setDisplayName("");
      setJobTitle("");
      setReason("");
      setRole2("clinician");
      toast.success("Account created", { description: "Share the temporary password securely." });
    },
    onError: (e: Error) => toast.error("Could not create account", { description: e.message }),
  });

  const roleMut = useMutation({
    mutationFn: (v: { user_id: string; role: "admin" | "clinician"; reason: string }) =>
      setRole({ data: v }),
    onSuccess: () => {
      refresh();
      toast.success("Role updated");
    },
    onError: (e: Error) => toast.error("Failed", { description: e.message }),
  });

  const suspendMut = useMutation({
    mutationFn: (v: {
      user_id: string;
      suspended: boolean;
      role?: "admin" | "clinician";
      reason: string;
    }) => setSuspended({ data: v }),
    onSuccess: (_d, v) => {
      refresh();
      toast.success(v.suspended ? "Access revoked immediately" : "Access reinstated");
    },
    onError: (e: Error) => toast.error("Failed", { description: e.message }),
  });

  const passwordMut = useMutation({
    mutationFn: (v: { user_id: string; password: string; reason: string }) =>
      resetPassword({ data: v }),
    onSuccess: () => {
      refresh();
      setNewPassword("");
      toast.success("Temporary password set", { description: "Share it securely." });
    },
    onError: (e: Error) => toast.error("Failed", { description: e.message }),
  });

  const removeMut = useMutation({
    mutationFn: (v: { user_id: string; reason: string }) => remove({ data: v }),
    onSuccess: () => {
      refresh();
      toast.success("Account removed");
    },
    onError: (e: Error) => toast.error("Failed", { description: e.message }),
  });

  if (error) {
    return (
      <Card>
        <CardContent className="py-12 text-center text-muted-foreground">
          You do not have permission to manage staff accounts.
        </CardContent>
      </Card>
    );
  }

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-center gap-3">
        <div className="min-w-0">
          <h1 className="text-2xl font-bold">Staff accounts</h1>
          <p className="text-sm text-muted-foreground">
            Onboard new staff, change roles, and revoke access the moment someone leaves the unit.
          </p>
        </div>
        <div className="ml-auto flex flex-wrap gap-2">
          <Button asChild variant="outline" className="h-11 gap-1.5 sm:h-10">
            <Link to="/antimicrobials">
              <Pill className="h-4 w-4" /> Antimicrobial library
            </Link>
          </Button>
          <Button asChild variant="outline" className="h-11 gap-1.5 sm:h-10">
            <Link to="/patients/sharing">
              <Share2 className="h-4 w-4" /> Partner sharing
            </Link>
          </Button>
          <Button className="h-11 gap-1.5 sm:h-10" onClick={() => setOpen(true)}>
            <Plus className="h-4 w-4" /> New account
          </Button>
        </div>
      </div>

      {isLoading ? (
        <ListSkeleton rows={4} />
      ) : (
        <div className="grid gap-3">
          {staff.map((s) => {
            const isAdmin = s.roles.includes("admin");
            const who = s.display_name || s.email || "this user";
            return (
              <Card key={s.id} className={s.suspended ? "border-destructive/40" : undefined}>
                <CardContent className="flex flex-wrap items-center gap-3 p-4">
                  <div className="min-w-0">
                    <p className="truncate font-medium">{s.display_name}</p>
                    <p className="truncate text-xs text-muted-foreground">{s.email}</p>
                    <p className="truncate text-xs text-muted-foreground">
                      {s.job_title ? `${s.job_title} · ` : ""}
                      {s.last_sign_in_at
                        ? `Last signed in ${fmtDateTime(s.last_sign_in_at)}`
                        : "Never signed in"}
                    </p>
                  </div>
                  {s.suspended ? (
                    <Badge variant="destructive">Access suspended</Badge>
                  ) : (
                    <Badge variant={isAdmin ? "default" : "secondary"}>
                      {isAdmin ? "Admin" : "Clinician"}
                    </Badge>
                  )}
                  <div className="ml-auto flex flex-wrap gap-2">
                    {!s.suspended && (
                      <AccessReasonDialog
                        title={isAdmin ? "Revoke admin access?" : "Grant admin access?"}
                        description={
                          isAdmin
                            ? `${who} will lose admin privileges (managing staff, roles, bed board, partner sharing) and become a regular clinician.`
                            : `${who} will gain full admin privileges: managing staff accounts, changing anyone's role, editing the bed board, and enabling partner-app sharing.`
                        }
                        confirmLabel={isAdmin ? "Revoke admin" : "Grant admin"}
                        pending={roleMut.isPending}
                        onConfirm={(r) =>
                          void roleMut.mutate({
                            user_id: s.id,
                            role: isAdmin ? "clinician" : "admin",
                            reason: r,
                          })
                        }
                      >
                        <Button variant="outline" size="sm" className="gap-1.5">
                          {isAdmin ? (
                            <ShieldOff className="h-4 w-4" />
                          ) : (
                            <Shield className="h-4 w-4" />
                          )}
                          {isAdmin ? "Make clinician" : "Make admin"}
                        </Button>
                      </AccessReasonDialog>
                    )}

                    <AccessReasonDialog
                      title="Set a temporary password?"
                      description={`${who} will be able to sign in with the password you set here. Share it securely and ask them to change it.`}
                      confirmLabel="Set password"
                      pending={passwordMut.isPending}
                      extra={
                        <div className="space-y-1.5">
                          <Label htmlFor="temp-password">Temporary password</Label>
                          <Input
                            id="temp-password"
                            type="text"
                            value={newPassword}
                            onChange={(e) => setNewPassword(e.target.value)}
                            minLength={8}
                            autoComplete="new-password"
                          />
                          <p className="text-xs text-muted-foreground">Minimum 8 characters.</p>
                        </div>
                      }
                      onConfirm={(r) => {
                        if (newPassword.length < 8) {
                          toast.error("Password must be at least 8 characters");
                          return false;
                        }
                        passwordMut.mutate({
                          user_id: s.id,
                          password: newPassword,
                          reason: r,
                        });
                        return true;
                      }}
                    >
                      <Button
                        variant="outline"
                        size="sm"
                        className="gap-1.5"
                        aria-label={`Set a temporary password for ${who}`}
                      >
                        <KeyRound className="h-4 w-4" /> Password
                      </Button>
                    </AccessReasonDialog>

                    {s.suspended ? (
                      <AccessReasonDialog
                        title="Reinstate access?"
                        description={`${who} will be able to sign in again as a clinician. Grant admin separately if needed.`}
                        confirmLabel="Reinstate access"
                        pending={suspendMut.isPending}
                        onConfirm={(r) =>
                          void suspendMut.mutate({
                            user_id: s.id,
                            suspended: false,
                            role: "clinician",
                            reason: r,
                          })
                        }
                      >
                        <Button variant="outline" size="sm" className="gap-1.5">
                          <RotateCcw className="h-4 w-4" /> Reinstate
                        </Button>
                      </AccessReasonDialog>
                    ) : (
                      <AccessReasonDialog
                        title="Revoke access now?"
                        description={`${who} will be blocked from signing in immediately and all their role grants are removed. Their account and past entries are kept, so access can be reinstated later.`}
                        confirmLabel="Revoke access"
                        destructive
                        pending={suspendMut.isPending}
                        onConfirm={(r) =>
                          void suspendMut.mutate({ user_id: s.id, suspended: true, reason: r })
                        }
                      >
                        <Button variant="outline" size="sm" className="gap-1.5">
                          <Ban className="h-4 w-4" /> Revoke access
                        </Button>
                      </AccessReasonDialog>
                    )}

                    <AccessReasonDialog
                      title="Remove this account permanently?"
                      description={`${who} will no longer be able to sign in and the account is deleted. Patient records and entries they created are retained and stay attributed to them. Prefer "Revoke access" if they may return.`}
                      confirmLabel="Remove account"
                      destructive
                      pending={removeMut.isPending}
                      onConfirm={(r) => void removeMut.mutate({ user_id: s.id, reason: r })}
                    >
                      <Button
                        variant="ghost"
                        size="icon"
                        className="text-destructive"
                        aria-label={`Remove account for ${who}`}
                      >
                        <Trash2 className="h-4 w-4" />
                      </Button>
                    </AccessReasonDialog>
                  </div>
                </CardContent>
              </Card>
            );
          })}
        </div>
      )}

      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2 text-base">
            <History className="h-4 w-4" /> Access change log
          </CardTitle>
        </CardHeader>
        <CardContent>
          {accessEvents.length === 0 ? (
            <p className="text-sm text-muted-foreground">
              No account changes recorded yet. Onboarding, role changes and revocations appear here.
            </p>
          ) : (
            <ul className="divide-y">
              {accessEvents.map((e) => (
                <li key={e.id} className="flex flex-wrap items-baseline gap-x-2 gap-y-1 py-2">
                  <span className="text-sm font-medium">
                    {ACTION_LABELS[e.action] ?? e.action}
                  </span>
                  <span className="text-sm text-muted-foreground">
                    {e.target_display_name || e.target_email || "unknown user"}
                    {e.role ? ` · ${e.role}` : ""}
                  </span>
                  <span className="ml-auto text-xs text-muted-foreground">
                    {fmtDateTime(e.created_at)}
                    {e.actor_email ? ` · by ${e.actor_email}` : ""}
                  </span>
                  {e.reason && (
                    <p className="w-full text-xs text-muted-foreground">{e.reason}</p>
                  )}
                </li>
              ))}
            </ul>
          )}
        </CardContent>
      </Card>

      <UnitAccessPanel staff={staff} />

      <BridgeSecurityPanel />


      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Onboard staff account</DialogTitle>
          </DialogHeader>
          <form
            onSubmit={(e) => {
              e.preventDefault();
              createMut.mutate();
            }}
            className="space-y-4"
          >
            <div className="space-y-1.5">
              <Label>Full name</Label>
              <Input value={displayName} onChange={(e) => setDisplayName(e.target.value)} required />
            </div>
            <div className="space-y-1.5">
              <Label>Job title (optional)</Label>
              <Input
                value={jobTitle}
                onChange={(e) => setJobTitle(e.target.value)}
                placeholder="e.g. ICU registrar"
              />
            </div>
            <div className="space-y-1.5">
              <Label>Email (username)</Label>
              <Input type="email" value={email} onChange={(e) => setEmail(e.target.value)} required />
            </div>
            <div className="space-y-1.5">
              <Label>Temporary password</Label>
              <div className="relative">
                <Input
                  type={showPassword ? "text" : "password"}
                  value={password}
                  onChange={(e) => setPassword(e.target.value)}
                  minLength={8}
                  required
                  autoComplete="new-password"
                  className="pr-10"
                />
                <button
                  type="button"
                  onClick={() => setShowPassword((s) => !s)}
                  className="absolute inset-y-0 right-0 flex items-center px-3 text-muted-foreground hover:text-foreground"
                  aria-label={showPassword ? "Hide password" : "Show password"}
                >
                  {showPassword ? <EyeOff className="h-4 w-4" /> : <Eye className="h-4 w-4" />}
                </button>
              </div>
              <p className="text-xs text-muted-foreground">
                Minimum 8 characters. Share securely with the staff member.
              </p>
            </div>
            <div className="space-y-1.5">
              <Label>Role</Label>
              <Select value={role} onValueChange={(v) => setRole2(v as "admin" | "clinician")}>
                <SelectTrigger>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="clinician">Clinician</SelectItem>
                  <SelectItem value="admin">Admin</SelectItem>
                </SelectContent>
              </Select>
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="onboard-reason">Reason (recorded in the access log)</Label>
              <Textarea
                id="onboard-reason"
                value={reason}
                onChange={(e) => setReason(e.target.value)}
                rows={2}
                required
                minLength={3}
                placeholder="e.g. New ICU registrar starting rotation on 01/09/2026"
              />
            </div>
            <div className="flex justify-end gap-2">
              <Button type="button" variant="outline" onClick={() => setOpen(false)}>
                Cancel
              </Button>
              <Button type="submit" disabled={createMut.isPending}>
                {createMut.isPending ? "Creating…" : "Create account"}
              </Button>
            </div>
          </form>
        </DialogContent>
      </Dialog>
    </div>
  );
}
