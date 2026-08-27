import { createFileRoute, Link } from "@tanstack/react-router";
import { useMemo, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useServerFn } from "@tanstack/react-start";
import { toast } from "sonner";
import {
  Ban,
  Building2,
  Eye,
  EyeOff,
  Plus,
  RotateCcw,
  Shield,
  Trash2,
  UserPlus,
  Users,
} from "lucide-react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { ListSkeleton } from "@/components/LoadingSkeleton";
import { AccessReasonDialog } from "@/components/AccessReasonDialog";
import { RoleChanger } from "@/components/RoleChanger";
import { useClinicalAccess } from "@/hooks/use-clinical-access";
import { listStaff, createStaff, setStaffRole, setStaffSuspended } from "@/lib/admin.functions";
import { listUnits, grantUnitAccess, revokeUnitAccess } from "@/lib/units.functions";
import { ROLE_DESCRIPTIONS, ROLE_LABELS, ROLE_ORDER, primaryRoleLabel, type UiRole } from "@/lib/roles";
import { fmtDateTime } from "@/lib/icu";

export const Route = createFileRoute("/_authenticated/access")({
  component: AccessAdminPage,
  head: () => ({
    meta: [
      { title: "Hospital & ICU unit access — ICU Handover" },
      {
        name: "description",
        content:
          "Add staff accounts, assign roles and grant or revoke access for each hospital and ICU unit.",
      },
      { property: "og:title", content: "Hospital & ICU unit access — ICU Handover" },
      {
        property: "og:description",
        content:
          "Per-hospital and per-unit account administration: add users, assign roles, revoke access immediately.",
      },
      { property: "og:type", content: "website" },
      { name: "twitter:card", content: "summary" },
    ],
  }),
});

type Unit = {
  id: string;
  name: string;
  code: string;
  bed_capacity: number | null;
  hospital_id: string;
  hospitals: { id: string; name: string; code: string } | null;
};

type Staff = {
  id: string;
  display_name: string;
  email: string | null;
  job_title: string | null;
  roles: string[];
  suspended: boolean;
  last_sign_in_at: string | null;
  units: { unit_id: string; label: string | null }[];
};

function roleOf(roles: string[]): UiRole {
  return (ROLE_ORDER.find((r) => roles.includes(r)) ??
    (roles.includes("admin") ? "trust_admin" : "clinician")) as UiRole;
}

function AccessAdminPage() {
  const qc = useQueryClient();
  const staffFn = useServerFn(listStaff);
  const unitsFn = useServerFn(listUnits);
  const createFn = useServerFn(createStaff);
  const roleFn = useServerFn(setStaffRole);
  const suspendFn = useServerFn(setStaffSuspended);
  const grantFn = useServerFn(grantUnitAccess);
  const revokeFn = useServerFn(revokeUnitAccess);

  const { profile: me } = useClinicalAccess();
  const isTrustAdmin = Boolean(me?.isTrustAdmin);
  // Only a Trust administrator may hand out Trust-wide or auditor roles.
  const assignable: readonly UiRole[] = isTrustAdmin
    ? ROLE_ORDER
    : (["clinician", "unit_admin"] as const);
  const myUnits = me?.unitIds ?? [];
  const canAdminUnit = (unitId: string) => isTrustAdmin || myUnits.includes(unitId);

  const {
    data: staff = [],
    isLoading,
    error,
  } = useQuery({
    queryKey: ["staff"],
    queryFn: () => staffFn() as Promise<Staff[]>,
    retry: false,
  });

  const { data: units = [] } = useQuery({
    queryKey: ["icu-units"],
    queryFn: () => unitsFn() as Promise<Unit[]>,
    retry: false,
    enabled: !error,
  });

  const refresh = () => {
    qc.invalidateQueries({ queryKey: ["staff"] });
    qc.invalidateQueries({ queryKey: ["unit-access"] });
    qc.invalidateQueries({ queryKey: ["access-events"] });
  };

  const roleMut = useMutation({
    mutationFn: (v: { user_id: string; role: UiRole; reason: string }) => roleFn({ data: v }),
    onSuccess: () => {
      refresh();
      toast.success("Role updated");
    },
    onError: (e: Error) => toast.error("Failed", { description: e.message }),
  });

  const suspendMut = useMutation({
    mutationFn: (v: { user_id: string; suspended: boolean; reason: string }) =>
      suspendFn({ data: v }),
    onSuccess: (_d, v) => {
      refresh();
      toast.success(v.suspended ? "Access revoked immediately" : "Access reinstated");
    },
    onError: (e: Error) => toast.error("Failed", { description: e.message }),
  });

  const grantMut = useMutation({
    mutationFn: (v: { user_id: string; unit_id: string; reason: string }) =>
      grantFn({ data: v }),
    onSuccess: () => {
      refresh();
      toast.success("Added to unit");
    },
    onError: (e: Error) => toast.error("Could not add to unit", { description: e.message }),
  });

  const revokeMut = useMutation({
    mutationFn: (v: { user_id: string; unit_id: string }) => revokeFn({ data: v }),
    onSuccess: () => {
      refresh();
      toast.success("Removed from unit");
    },
    onError: (e: Error) => toast.error("Failed", { description: e.message }),
  });

  const createMut = useMutation({
    mutationFn: (v: {
      email: string;
      password: string;
      display_name: string;
      job_title?: string;
      role: UiRole;
      unit_ids: string[];
      reason: string;
    }) => createFn({ data: v }),
    onSuccess: () => {
      refresh();
      toast.success("Account created", { description: "Share the temporary password securely." });
    },
    onError: (e: Error) => toast.error("Could not create account", { description: e.message }),
  });

  // Hospitals, each with its ICU units and the staff attached to those units.
  const hospitals = useMemo(() => {
    const byHospital = new Map<
      string,
      { id: string; name: string; code: string; units: Unit[] }
    >();
    for (const u of units) {
      const key = u.hospitals?.id ?? u.hospital_id;
      const entry = byHospital.get(key) ?? {
        id: key,
        name: u.hospitals?.name ?? "Hospital",
        code: u.hospitals?.code ?? "",
        units: [],
      };
      entry.units.push(u);
      byHospital.set(key, entry);
    }
    return [...byHospital.values()].sort((a, b) => a.name.localeCompare(b.name));
  }, [units]);

  const membersOf = (unitId: string) =>
    staff.filter((s) => s.units.some((u) => u.unit_id === unitId));

  // Trust administrators and auditors work across the estate, so they hold no
  // unit membership; clinicians without one cannot reach any patient record.
  const unattached = staff.filter((s) => s.units.length === 0);

  if (error) {
    return (
      <Card>
        <CardContent className="py-12 text-center text-muted-foreground">
          You do not have permission to manage access for hospitals and ICU units.
        </CardContent>
      </Card>
    );
  }

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-start gap-3">
        <div className="min-w-0">
          <h1 className="text-2xl font-bold">Hospital &amp; ICU unit access</h1>
          <p className="max-w-3xl text-sm text-muted-foreground">
            Patient records are scoped to ICU units. Add a member to a unit to let them work
            there, change their role to change what they can do, or revoke access the moment
            someone leaves. Every change records a reason in the access change log.
          </p>
        </div>
        <div className="ml-auto flex flex-wrap gap-2">
          <Button asChild variant="outline" className="h-11 gap-1.5 sm:h-10">
            <Link to="/admin">
              <Users className="h-4 w-4" aria-hidden="true" /> All staff accounts
            </Link>
          </Button>
        </div>
      </div>

      {!isTrustAdmin && (
        <p className="rounded-md border border-dashed p-3 text-sm text-muted-foreground">
          You administer {myUnits.length} unit{myUnits.length === 1 ? "" : "s"}. Units outside your
          scope are shown read-only.
        </p>
      )}

      {isLoading ? (
        <ListSkeleton rows={5} />
      ) : hospitals.length === 0 ? (
        <Card>
          <CardContent className="py-10 text-center text-sm text-muted-foreground">
            No hospitals or ICU units have been set up yet.
          </CardContent>
        </Card>
      ) : (
        hospitals.map((h) => (
          <section key={h.id} className="space-y-3">
            <h2 className="flex items-center gap-2 text-lg font-semibold">
              <Building2 className="h-4 w-4 text-muted-foreground" aria-hidden="true" />
              {h.name}
              {h.code ? <Badge variant="outline">{h.code}</Badge> : null}
            </h2>

            {h.units.map((u) => {
              const members = membersOf(u.id);
              const editable = canAdminUnit(u.id);
              return (
                <Card key={u.id}>
                  <CardHeader className="flex flex-row flex-wrap items-center gap-2 space-y-0">
                    <CardTitle className="text-base">{u.name}</CardTitle>
                    <Badge variant="secondary">{u.code}</Badge>
                    <span className="text-xs text-muted-foreground">
                      {members.length} member{members.length === 1 ? "" : "s"}
                      {u.bed_capacity ? ` · ${u.bed_capacity} beds` : ""}
                    </span>
                    {editable ? (
                      <div className="ml-auto flex flex-wrap gap-2">
                        <AddMemberDialog
                          unitLabel={`${h.name} — ${u.name}`}
                          candidates={staff.filter(
                            (s) => !s.units.some((x) => x.unit_id === u.id),
                          )}
                          pending={grantMut.isPending}
                          onAdd={(userId, reason) =>
                            void grantMut.mutate({ user_id: userId, unit_id: u.id, reason })
                          }
                        />
                        <NewAccountDialog
                          unitLabel={`${h.name} — ${u.name}`}
                          assignable={assignable}
                          pending={createMut.isPending}
                          onCreate={(v) => createMut.mutate({ ...v, unit_ids: [u.id] })}
                        />
                      </div>
                    ) : (
                      <Badge variant="outline" className="ml-auto">
                        Read-only
                      </Badge>
                    )}
                  </CardHeader>
                  <CardContent className="space-y-2">
                    {members.length === 0 ? (
                      <p className="text-sm text-muted-foreground">
                        No one is assigned to this unit yet.
                      </p>
                    ) : (
                      members.map((s) => {
                        const who = s.display_name || s.email || "this user";
                        const current = roleOf(s.roles);
                        const manageable =
                          editable && (isTrustAdmin || !s.roles.includes("trust_admin"));
                        return (
                          <div
                            key={s.id}
                            className={`flex flex-wrap items-center gap-3 rounded-md border p-3 text-sm ${
                              s.suspended ? "border-destructive/40" : ""
                            }`}
                          >
                            <div className="min-w-0">
                              <p className="truncate font-medium">{s.display_name}</p>
                              <p className="truncate text-xs text-muted-foreground">
                                {s.email}
                                {s.job_title ? ` · ${s.job_title}` : ""}
                              </p>
                            </div>
                            {s.suspended ? (
                              <Badge variant="destructive">Access suspended</Badge>
                            ) : (
                              <Badge
                                variant={
                                  current === "trust_admin" || current === "unit_admin"
                                    ? "default"
                                    : "secondary"
                                }
                                title={ROLE_DESCRIPTIONS[current]}
                              >
                                {primaryRoleLabel(s.roles)}
                              </Badge>
                            )}
                            <span className="hidden text-xs text-muted-foreground sm:inline">
                              {s.last_sign_in_at
                                ? `Last signed in ${fmtDateTime(s.last_sign_in_at)}`
                                : "Never signed in"}
                            </span>

                            {manageable && (
                              <div className="ml-auto flex flex-wrap gap-2">
                                {!s.suspended && (
                                  <RoleChanger
                                    who={who}
                                    current={current}
                                    options={assignable}
                                    pending={roleMut.isPending}
                                    onChange={(next, reason) =>
                                      void roleMut.mutate({
                                        user_id: s.id,
                                        role: next,
                                        reason,
                                      })
                                    }
                                  />
                                )}

                                {s.suspended ? (
                                  <AccessReasonDialog
                                    title="Reinstate access?"
                                    description={`${who} will be able to sign in again with their existing role.`}
                                    confirmLabel="Reinstate access"
                                    pending={suspendMut.isPending}
                                    onConfirm={(r) =>
                                      void suspendMut.mutate({
                                        user_id: s.id,
                                        suspended: false,
                                        reason: r,
                                      })
                                    }
                                  >
                                    <Button variant="outline" size="sm" className="gap-1.5">
                                      <RotateCcw className="h-4 w-4" aria-hidden="true" />{" "}
                                      Reinstate
                                    </Button>
                                  </AccessReasonDialog>
                                ) : (
                                  <AccessReasonDialog
                                    title="Disable this account now?"
                                    description={`${who} will be signed out and blocked from signing in anywhere, in every unit, straight away. Their entries stay in the record.`}
                                    confirmLabel="Disable account"
                                    destructive
                                    pending={suspendMut.isPending}
                                    onConfirm={(r) =>
                                      void suspendMut.mutate({
                                        user_id: s.id,
                                        suspended: true,
                                        reason: r,
                                      })
                                    }
                                  >
                                    <Button variant="outline" size="sm" className="gap-1.5">
                                      <Ban className="h-4 w-4" aria-hidden="true" /> Disable
                                    </Button>
                                  </AccessReasonDialog>
                                )}

                                <AccessReasonDialog
                                  title={`Remove ${who} from ${u.name}?`}
                                  description="They keep their account and any other units, but lose access to every patient record in this unit immediately."
                                  confirmLabel="Remove from unit"
                                  destructive
                                  pending={revokeMut.isPending}
                                  onConfirm={() =>
                                    void revokeMut.mutate({ user_id: s.id, unit_id: u.id })
                                  }
                                >
                                  <Button
                                    variant="ghost"
                                    size="sm"
                                    className="gap-1.5 text-destructive"
                                  >
                                    <Trash2 className="h-4 w-4" aria-hidden="true" /> Remove
                                  </Button>
                                </AccessReasonDialog>
                              </div>
                            )}
                          </div>
                        );
                      })
                    )}
                  </CardContent>
                </Card>
              );
            })}
          </section>
        ))
      )}

      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2 text-base">
            <Shield className="h-4 w-4" aria-hidden="true" /> Accounts with no unit
          </CardTitle>
        </CardHeader>
        <CardContent className="space-y-2">
          <p className="text-sm text-muted-foreground">
            Trust administrators and auditors work across the whole estate and need no unit. A
            clinician listed here cannot open any patient record until they are added to a unit
            above.
          </p>
          {unattached.length === 0 ? (
            <p className="text-sm text-muted-foreground">Every account belongs to a unit.</p>
          ) : (
            unattached.map((s) => (
              <div
                key={s.id}
                className="flex flex-wrap items-center gap-3 rounded-md border p-3 text-sm"
              >
                <div className="min-w-0">
                  <p className="truncate font-medium">{s.display_name}</p>
                  <p className="truncate text-xs text-muted-foreground">{s.email}</p>
                </div>
                <Badge variant="secondary">{primaryRoleLabel(s.roles)}</Badge>
                {s.suspended ? <Badge variant="destructive">Access suspended</Badge> : null}
                {roleOf(s.roles) === "clinician" && !s.suspended ? (
                  <Badge variant="outline" className="text-destructive">
                    No unit access
                  </Badge>
                ) : null}
              </div>
            ))
          )}
        </CardContent>
      </Card>
    </div>
  );
}

// Add an existing account to this ICU unit.
function AddMemberDialog({
  unitLabel,
  candidates,
  pending,
  onAdd,
}: {
  unitLabel: string;
  candidates: { id: string; display_name: string; email: string | null }[];
  pending: boolean;
  onAdd: (userId: string, reason: string) => void;
}) {
  const [userId, setUserId] = useState("");
  return (
    <AccessReasonDialog
      title={`Add someone to ${unitLabel}?`}
      description="They will be able to read and record patient information in this unit as soon as you confirm."
      confirmLabel="Add to unit"
      pending={pending}
      extra={
        <div className="space-y-1.5">
          <Label htmlFor={`add-${unitLabel}`}>Staff member</Label>
          <Select value={userId} onValueChange={setUserId}>
            <SelectTrigger id={`add-${unitLabel}`}>
              <SelectValue placeholder="Select an account" />
            </SelectTrigger>
            <SelectContent>
              {candidates.map((c) => (
                <SelectItem key={c.id} value={c.id}>
                  {c.email ?? c.display_name}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
      }
      onConfirm={(reason) => {
        if (!userId) {
          toast.error("Choose a staff member");
          return false;
        }
        onAdd(userId, reason);
        setUserId("");
        return true;
      }}
    >
      <Button variant="outline" size="sm" className="gap-1.5">
        <Plus className="h-4 w-4" aria-hidden="true" /> Add member
      </Button>
    </AccessReasonDialog>
  );
}

// Create a brand-new account straight into this ICU unit with a role.
function NewAccountDialog({
  unitLabel,
  assignable,
  pending,
  onCreate,
}: {
  unitLabel: string;
  assignable: readonly UiRole[];
  pending: boolean;
  onCreate: (v: {
    email: string;
    password: string;
    display_name: string;
    job_title?: string;
    role: UiRole;
    reason: string;
  }) => void;
}) {
  const [open, setOpen] = useState(false);
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [showPassword, setShowPassword] = useState(false);
  const [displayName, setDisplayName] = useState("");
  const [jobTitle, setJobTitle] = useState("");
  const [role, setRole] = useState<UiRole>("clinician");
  const [reason, setReason] = useState("");

  const valid =
    /\S+@\S+\.\S+/.test(email) &&
    password.length >= 8 &&
    displayName.trim().length >= 2 &&
    reason.trim().length >= 3;

  function submit() {
    onCreate({
      email: email.trim(),
      password,
      display_name: displayName.trim(),
      job_title: jobTitle.trim() || undefined,
      role,
      reason: reason.trim(),
    });
    setOpen(false);
    setEmail("");
    setPassword("");
    setDisplayName("");
    setJobTitle("");
    setReason("");
    setRole("clinician");
  }

  return (
    <>
      <Button size="sm" className="gap-1.5" onClick={() => setOpen(true)}>
        <UserPlus className="h-4 w-4" aria-hidden="true" /> New account
      </Button>
      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>New account for {unitLabel}</DialogTitle>
          </DialogHeader>
          <div className="space-y-3">
            <div className="space-y-1.5">
              <Label htmlFor="na-email">Work email</Label>
              <Input
                id="na-email"
                type="email"
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                autoComplete="off"
              />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="na-name">Name shown in the app</Label>
              <Input
                id="na-name"
                value={displayName}
                onChange={(e) => setDisplayName(e.target.value)}
              />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="na-job">Job title (optional)</Label>
              <Input
                id="na-job"
                value={jobTitle}
                onChange={(e) => setJobTitle(e.target.value)}
                placeholder="e.g. ICU registrar"
              />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="na-password">Temporary password</Label>
              <div className="flex gap-2">
                <Input
                  id="na-password"
                  type={showPassword ? "text" : "password"}
                  value={password}
                  onChange={(e) => setPassword(e.target.value)}
                  minLength={8}
                  autoComplete="new-password"
                />
                <Button
                  type="button"
                  variant="outline"
                  size="icon"
                  aria-label={showPassword ? "Hide password" : "Show password"}
                  onClick={() => setShowPassword((v) => !v)}
                >
                  {showPassword ? (
                    <EyeOff className="h-4 w-4" aria-hidden="true" />
                  ) : (
                    <Eye className="h-4 w-4" aria-hidden="true" />
                  )}
                </Button>
              </div>
              <p className="text-xs text-muted-foreground">
                Minimum 8 characters. Share it securely and ask them to change it.
              </p>
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="na-role">Role</Label>
              <Select value={role} onValueChange={(v) => setRole(v as UiRole)}>
                <SelectTrigger id="na-role">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {assignable.map((r) => (
                    <SelectItem key={r} value={r}>
                      {ROLE_LABELS[r]}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
              <p className="text-xs text-muted-foreground">{ROLE_DESCRIPTIONS[role]}</p>
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="na-reason">Reason (recorded in the access log)</Label>
              <Input
                id="na-reason"
                value={reason}
                onChange={(e) => setReason(e.target.value)}
                placeholder="e.g. New registrar starting rotation 01/09/2026"
              />
            </div>
          </div>
          <div className="flex justify-end gap-2">
            <Button variant="outline" onClick={() => setOpen(false)}>
              Cancel
            </Button>
            <Button disabled={!valid || pending} onClick={submit}>
              Create account
            </Button>
          </div>
        </DialogContent>
      </Dialog>
    </>
  );
}
