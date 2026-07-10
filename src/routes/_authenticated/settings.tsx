import { createFileRoute } from "@tanstack/react-router";
import { useEffect, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useServerFn } from "@tanstack/react-start";
import { getMe, updateMyProfile } from "@/lib/me.functions";
import { supabase } from "@/integrations/supabase/client";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
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
    </div>
  );
}
