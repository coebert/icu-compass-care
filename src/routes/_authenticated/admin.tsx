import { createFileRoute, Link } from "@tanstack/react-router";
import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useServerFn } from "@tanstack/react-start";
import { listStaff, createStaff, setStaffRole, deleteStaff } from "@/lib/admin.functions";
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
import { Plus, Trash2, Shield, ShieldOff, Eye, EyeOff, Share2 } from "lucide-react";
import { toast } from "sonner";
import { BridgeSecurityPanel } from "@/components/BridgeSecurityPanel";

export const Route = createFileRoute("/_authenticated/admin")({
  component: AdminPage,
});

type Staff = { id: string; display_name: string; email: string | null; roles: string[] };

function AdminPage() {
  const qc = useQueryClient();
  const list = useServerFn(listStaff);
  const create = useServerFn(createStaff);
  const setRole = useServerFn(setStaffRole);
  const remove = useServerFn(deleteStaff);

  const [open, setOpen] = useState(false);
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [showPassword, setShowPassword] = useState(false);
  const [displayName, setDisplayName] = useState("");
  const [role, setRole2] = useState<"admin" | "clinician">("clinician");

  const { data: staff = [], isLoading, error } = useQuery({
    queryKey: ["staff"],
    queryFn: () => list() as Promise<Staff[]>,
    retry: false,
  });

  const createMut = useMutation({
    mutationFn: () => create({ data: { email, password, display_name: displayName, role } }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["staff"] });
      setOpen(false);
      setEmail("");
      setPassword("");
      setDisplayName("");
      setRole2("clinician");
      toast.success("Account created");
    },
    onError: (e: Error) => toast.error("Could not create account", { description: e.message }),
  });

  const roleMut = useMutation({
    mutationFn: (v: { user_id: string; role: "admin" | "clinician" }) => setRole({ data: v }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["staff"] });
      toast.success("Role updated");
    },
    onError: (e: Error) => toast.error("Failed", { description: e.message }),
  });

  const removeMut = useMutation({
    mutationFn: (user_id: string) => remove({ data: { user_id } }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["staff"] });
      toast.success("Account deleted");
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
          <p className="text-sm text-muted-foreground">Create and manage who can access the handover.</p>
        </div>
        <div className="ml-auto flex flex-wrap gap-2">
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
        <p className="text-sm text-muted-foreground">Loading…</p>
      ) : (
        <div className="grid gap-3">
          {staff.map((s) => {
            const isAdmin = s.roles.includes("admin");
            return (
              <Card key={s.id}>
                <CardContent className="flex flex-wrap items-center gap-3 p-4">
                  <div className="min-w-0">
                    <p className="truncate font-medium">{s.display_name}</p>
                    <p className="truncate text-xs text-muted-foreground">{s.email}</p>

                  </div>
                  <Badge variant={isAdmin ? "default" : "secondary"}>{isAdmin ? "Admin" : "Clinician"}</Badge>
                  <div className="ml-auto flex gap-2">
                    <Button
                      variant="outline"
                      size="sm"
                      className="gap-1.5"
                      onClick={() =>
                        roleMut.mutate({ user_id: s.id, role: isAdmin ? "clinician" : "admin" })
                      }
                    >
                      {isAdmin ? <ShieldOff className="h-4 w-4" /> : <Shield className="h-4 w-4" />}
                      {isAdmin ? "Make clinician" : "Make admin"}
                    </Button>
                    <AlertDialog>
                      <AlertDialogTrigger asChild>
                        <Button variant="ghost" size="icon" className="text-destructive">
                          <Trash2 className="h-4 w-4" />
                        </Button>
                      </AlertDialogTrigger>
                      <AlertDialogContent>
                        <AlertDialogHeader>
                          <AlertDialogTitle>Delete this account?</AlertDialogTitle>
                          <AlertDialogDescription>
                            {s.display_name} will no longer be able to sign in. Patient records they
                            created are retained.
                          </AlertDialogDescription>
                        </AlertDialogHeader>
                        <AlertDialogFooter>
                          <AlertDialogCancel>Cancel</AlertDialogCancel>
                          <AlertDialogAction onClick={() => removeMut.mutate(s.id)}>Delete</AlertDialogAction>
                        </AlertDialogFooter>
                      </AlertDialogContent>
                    </AlertDialog>
                  </div>
                </CardContent>
              </Card>
            );
          })}
        </div>
      )}

      <BridgeSecurityPanel />


      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent>
          <DialogHeader><DialogTitle>Create staff account</DialogTitle></DialogHeader>
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
              <p className="text-xs text-muted-foreground">Minimum 8 characters. Share securely with the staff member.</p>
            </div>
            <div className="space-y-1.5">
              <Label>Role</Label>
              <Select value={role} onValueChange={(v) => setRole2(v as "admin" | "clinician")}>
                <SelectTrigger><SelectValue /></SelectTrigger>
                <SelectContent>
                  <SelectItem value="clinician">Clinician</SelectItem>
                  <SelectItem value="admin">Admin</SelectItem>
                </SelectContent>
              </Select>
            </div>
            <div className="flex justify-end gap-2">
              <Button type="button" variant="outline" onClick={() => setOpen(false)}>Cancel</Button>
              <Button type="submit" disabled={createMut.isPending}>{createMut.isPending ? "Creating…" : "Create"}</Button>
            </div>
          </form>
        </DialogContent>
      </Dialog>
    </div>
  );
}
