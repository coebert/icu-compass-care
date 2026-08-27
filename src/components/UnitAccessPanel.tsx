import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useServerFn } from "@tanstack/react-start";
import { toast } from "sonner";
import { Building2, Plus, Trash2 } from "lucide-react";
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
import {
  listUnits,
  listUnitAccess,
  grantUnitAccess,
  revokeUnitAccess,
} from "@/lib/units.functions";

type Unit = {
  id: string;
  name: string;
  code: string;
  hospitals: { name: string } | null;
};

type Grant = {
  id: string;
  user_id: string;
  unit_id: string;
  reason: string | null;
  created_at: string;
  icu_units: { name: string; code: string; hospitals: { name: string } | null } | null;
};

type StaffOption = { id: string; display_name: string; email: string | null };

/**
 * Hospital / ICU unit access administration.
 *
 * Patient data is scoped per unit in the database: a clinician sees only the
 * units listed for them here. Administrators see every unit regardless.
 */
export function UnitAccessPanel({ staff }: { staff: StaffOption[] }) {
  const qc = useQueryClient();
  const units = useServerFn(listUnits);
  const grants = useServerFn(listUnitAccess);
  const grant = useServerFn(grantUnitAccess);
  const revoke = useServerFn(revokeUnitAccess);

  const [userId, setUserId] = useState("");
  const [unitId, setUnitId] = useState("");
  const [reason, setReason] = useState("");

  const { data: unitList = [] } = useQuery({
    queryKey: ["icu-units"],
    queryFn: () => units() as Promise<Unit[]>,
    retry: false,
  });

  const { data: grantList = [] } = useQuery({
    queryKey: ["unit-access"],
    queryFn: () => grants() as Promise<Grant[]>,
    retry: false,
  });

  const refresh = () => qc.invalidateQueries({ queryKey: ["unit-access"] });

  const grantMut = useMutation({
    mutationFn: () => grant({ data: { user_id: userId, unit_id: unitId, reason } }),
    onSuccess: () => {
      toast.success("Unit access granted");
      setUserId("");
      setUnitId("");
      setReason("");
      refresh();
    },
    onError: (e: Error) => toast.error(e.message),
  });

  const revokeMut = useMutation({
    mutationFn: (g: Grant) => revoke({ data: { user_id: g.user_id, unit_id: g.unit_id } }),
    onSuccess: () => {
      toast.success("Unit access revoked");
      refresh();
    },
    onError: (e: Error) => toast.error(e.message),
  });

  const nameFor = (id: string) => {
    const s = staff.find((x) => x.id === id);
    return s ? (s.email ?? s.display_name) : id;
  };

  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2 text-base">
          <Building2 className="h-4 w-4" aria-hidden="true" /> Hospital and ICU unit access
        </CardTitle>
      </CardHeader>
      <CardContent className="space-y-6">
        <p className="text-sm text-muted-foreground">
          Clinicians can read and edit patient records only for the units listed below.
          Administrators can see every unit.
        </p>

        <div className="grid gap-3 sm:grid-cols-[1fr_1fr_1fr_auto] sm:items-end">
          <div className="space-y-1.5">
            <Label htmlFor="unit-access-staff">Staff member</Label>
            <Select value={userId} onValueChange={setUserId}>
              <SelectTrigger id="unit-access-staff">
                <SelectValue placeholder="Select staff" />
              </SelectTrigger>
              <SelectContent>
                {staff.map((s) => (
                  <SelectItem key={s.id} value={s.id}>
                    {s.email ?? s.display_name}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="unit-access-unit">ICU unit</Label>
            <Select value={unitId} onValueChange={setUnitId}>
              <SelectTrigger id="unit-access-unit">
                <SelectValue placeholder="Select unit" />
              </SelectTrigger>
              <SelectContent>
                {unitList.map((u) => (
                  <SelectItem key={u.id} value={u.id}>
                    {u.hospitals?.name ? `${u.hospitals.name} — ${u.name}` : u.name}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="unit-access-reason">Reason</Label>
            <Input
              id="unit-access-reason"
              value={reason}
              onChange={(e) => setReason(e.target.value)}
              placeholder="e.g. Rotating to Radnor ICU"
            />
          </div>
          <Button
            onClick={() => grantMut.mutate()}
            disabled={!userId || !unitId || reason.trim().length < 3 || grantMut.isPending}
          >
            <Plus className="mr-1 h-4 w-4" aria-hidden="true" /> Grant
          </Button>
        </div>

        <div className="space-y-2">
          {grantList.length === 0 ? (
            <p className="text-sm text-muted-foreground">No unit grants recorded yet.</p>
          ) : (
            grantList.map((g) => (
              <div
                key={g.id}
                className="flex flex-wrap items-center gap-3 rounded-md border p-3 text-sm"
              >
                <span className="font-medium">{nameFor(g.user_id)}</span>
                <Badge variant="secondary">
                  {g.icu_units?.hospitals?.name
                    ? `${g.icu_units.hospitals.name} — ${g.icu_units?.name}`
                    : (g.icu_units?.name ?? "Unknown unit")}
                </Badge>
                {g.reason ? (
                  <span className="text-muted-foreground">{g.reason}</span>
                ) : null}
                <Button
                  variant="ghost"
                  size="sm"
                  className="ml-auto text-destructive"
                  onClick={() => revokeMut.mutate(g)}
                  disabled={revokeMut.isPending}
                >
                  <Trash2 className="mr-1 h-4 w-4" aria-hidden="true" /> Revoke
                </Button>
              </div>
            ))
          )}
        </div>
      </CardContent>
    </Card>
  );
}
