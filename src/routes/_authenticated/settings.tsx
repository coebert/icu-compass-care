import { createFileRoute } from "@tanstack/react-router";
import { useEffect, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useServerFn } from "@tanstack/react-start";
import { getMe, updateMyProfile } from "@/lib/me.functions";
import { listPasskeys, deletePasskey } from "@/lib/passkeys.functions";
import {
  registerPasskey,
  clearDevicePasskey,
  passkeysSupported,
} from "@/lib/passkeys-client";
import { supabase } from "@/integrations/supabase/client";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Fingerprint, Trash2 } from "lucide-react";
import { toast } from "sonner";

export const Route = createFileRoute("/_authenticated/settings")({
  component: SettingsPage,
});

function SettingsPage() {
  const qc = useQueryClient();
  const me = useServerFn(getMe);
  const updateProfile = useServerFn(updateMyProfile);
  const { data } = useQuery({ queryKey: ["me"], queryFn: () => me() });

  const [name, setName] = useState("");
  const [pw, setPw] = useState("");

  useEffect(() => {
    if (data?.profile?.display_name) setName(data.profile.display_name);
  }, [data]);

  const nameMut = useMutation({
    mutationFn: () => updateProfile({ data: { display_name: name } }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["me"] });
      toast.success("Profile updated");
    },
    onError: (e: Error) => toast.error("Failed", { description: e.message }),
  });

  const pwMut = useMutation({
    mutationFn: async () => {
      const { error } = await supabase.auth.updateUser({ password: pw });
      if (error) throw error;
    },
    onSuccess: () => {
      setPw("");
      toast.success("Password changed");
    },
    onError: (e: Error) => toast.error("Failed", { description: e.message }),
  });

  const passkeysList = useServerFn(listPasskeys);
  const removePasskey = useServerFn(deletePasskey);
  const [label, setLabel] = useState("");
  const supported = passkeysSupported();

  const { data: passkeys } = useQuery({
    queryKey: ["passkeys"],
    queryFn: () => passkeysList(),
  });

  const registerMut = useMutation({
    mutationFn: async () => {
      if (!data?.userId) throw new Error("Not signed in");
      await registerPasskey(data.userId, label.trim() || undefined);
    },
    onSuccess: () => {
      setLabel("");
      qc.invalidateQueries({ queryKey: ["passkeys"] });
      toast.success("Passkey added", {
        description: "You can now unlock with your fingerprint or Face ID.",
      });
    },
    onError: (e: Error) => toast.error("Could not add passkey", { description: e.message }),
  });

  const deleteMut = useMutation({
    mutationFn: async (id: string) => {
      await removePasskey({ data: { id } });
      return id;
    },
    onSuccess: (_id, _vars, _ctx) => {
      // If no passkeys remain, this device no longer needs unlocking.
      const remaining = (passkeys ?? []).length - 1;
      if (remaining <= 0 && data?.userId) clearDevicePasskey(data.userId);
      qc.invalidateQueries({ queryKey: ["passkeys"] });
      toast.success("Passkey removed");
    },
    onError: (e: Error) => toast.error("Failed", { description: e.message }),
  });


  return (
    <div className="max-w-md space-y-6">
      <h1 className="text-2xl font-bold">My profile</h1>
      <Card>
        <CardHeader><CardTitle className="text-base">Details</CardTitle></CardHeader>
        <CardContent className="space-y-4">
          <div className="space-y-1.5">
            <Label>Email</Label>
            <Input value={data?.email ?? ""} disabled />
          </div>
          <div className="space-y-1.5">
            <Label>Display name</Label>
            <Input value={name} onChange={(e) => setName(e.target.value)} />
          </div>
          <Button onClick={() => nameMut.mutate()} disabled={nameMut.isPending}>
            {nameMut.isPending ? "Saving…" : "Save name"}
          </Button>
        </CardContent>
      </Card>
      <Card>
        <CardHeader><CardTitle className="text-base">Change password</CardTitle></CardHeader>
        <CardContent className="space-y-4">
          <div className="space-y-1.5">
            <Label>New password</Label>
            <Input type="password" value={pw} onChange={(e) => setPw(e.target.value)} minLength={8} />
          </div>
          <Button onClick={() => pwMut.mutate()} disabled={pwMut.isPending || pw.length < 8}>
            {pwMut.isPending ? "Saving…" : "Update password"}
          </Button>
        </CardContent>
      </Card>
      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2 text-base">
            <Fingerprint className="h-4 w-4" /> Biometric access (passkeys)
          </CardTitle>
          <CardDescription>
            Add this device's fingerprint or Face ID to unlock ICU Handover quickly and securely.
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          {!supported ? (
            <p className="text-sm text-muted-foreground">
              This device or browser does not support passkeys.
            </p>
          ) : (
            <>
              <div className="space-y-1.5">
                <Label>Device name (optional)</Label>
                <Input
                  value={label}
                  onChange={(e) => setLabel(e.target.value)}
                  placeholder="e.g. My iPhone"
                />
              </div>
              <Button
                className="gap-2"
                onClick={() => registerMut.mutate()}
                disabled={registerMut.isPending}
              >
                <Fingerprint className="h-4 w-4" />
                {registerMut.isPending ? "Waiting for device…" : "Add passkey on this device"}
              </Button>

              {(passkeys ?? []).length > 0 && (
                <ul className="divide-y rounded-md border">
                  {(passkeys ?? []).map((p) => (
                    <li key={p.id} className="flex items-center justify-between gap-3 px-3 py-2">
                      <div className="min-w-0">
                        <p className="truncate text-sm font-medium">
                          {p.device_label || "Passkey"}
                        </p>
                        <p className="text-xs text-muted-foreground">
                          Added {new Date(p.created_at).toLocaleDateString("en-GB")}
                          {p.last_used_at
                            ? ` · last used ${new Date(p.last_used_at).toLocaleDateString("en-GB")}`
                            : ""}
                        </p>
                      </div>
                      <Button
                        variant="ghost"
                        size="icon"
                        onClick={() => deleteMut.mutate(p.id)}
                        disabled={deleteMut.isPending}
                        aria-label="Remove passkey"
                      >
                        <Trash2 className="h-4 w-4 text-destructive" />
                      </Button>
                    </li>
                  ))}
                </ul>
              )}
            </>
          )}
        </CardContent>
      </Card>
    </div>

  );
}
