import { useState } from "react";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Fingerprint, LogOut } from "lucide-react";
import { toast } from "sonner";
import { unlockWithPasskey } from "@/lib/passkeys-client";

export function PasskeyLockScreen({
  displayName,
  onUnlocked,
  onSignOut,
}: {
  displayName?: string | null;
  onUnlocked: () => void;
  onSignOut: () => void;
}) {
  const [loading, setLoading] = useState(false);

  async function unlock() {
    setLoading(true);
    try {
      await unlockWithPasskey();
      onUnlocked();
    } catch (e) {
      toast.error("Unlock failed", {
        description: e instanceof Error ? e.message : "Try again",
      });
    } finally {
      setLoading(false);
    }
  }

  return (
    <div className="flex min-h-screen items-center justify-center bg-muted/40 px-4">
      <Card className="w-full max-w-sm text-center">
        <CardHeader className="space-y-2">
          <div className="mx-auto flex h-14 w-14 items-center justify-center rounded-full bg-primary/10 text-primary">
            <Fingerprint className="h-7 w-7" />
          </div>
          <CardTitle className="text-xl">Locked</CardTitle>
          <CardDescription>
            {displayName ? `Welcome back, ${displayName}. ` : ""}
            Use your device passkey to unlock ICU Handover.
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-3">
          <Button className="w-full gap-2" onClick={unlock} disabled={loading} autoFocus>
            <Fingerprint className="h-4 w-4" />
            {loading ? "Verifying…" : "Unlock with passkey"}
          </Button>
          <Button variant="ghost" size="sm" className="w-full gap-2" onClick={onSignOut}>
            <LogOut className="h-4 w-4" />
            Sign out instead
          </Button>
        </CardContent>
      </Card>
    </div>
  );
}
