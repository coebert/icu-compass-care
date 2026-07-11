import { createFileRoute, useNavigate, redirect } from "@tanstack/react-router";
import { useState } from "react";
import { useServerFn } from "@tanstack/react-start";
import { setupStatus, bootstrapAdmin } from "@/lib/setup.functions";
import { supabase } from "@/integrations/supabase/client";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { toast } from "sonner";
import { ShieldCheck } from "lucide-react";

export const Route = createFileRoute("/setup")({
  ssr: false,
  loader: async () => {
    const status = await setupStatus();
    if (!status.needsSetup) throw redirect({ to: "/auth" });
    return status;
  },
  component: SetupPage,
});

function SetupPage() {
  const navigate = useNavigate();
  const boot = useServerFn(bootstrapAdmin);
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [name, setName] = useState("");
  const [loading, setLoading] = useState(false);

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setLoading(true);
    try {
      await boot({ data: { email: email.trim(), password, display_name: name } });
      await supabase.auth.signInWithPassword({ email: email.trim(), password });
      toast.success("Administrator account created");
      navigate({ to: "/patients" });
    } catch (err) {
      toast.error("Setup failed", { description: (err as Error).message });
    } finally {
      setLoading(false);
    }
  }

  return (
    <div className="flex min-h-screen items-center justify-center bg-muted/40 px-4">
      <Card className="w-full max-w-md">
        <CardHeader className="space-y-2 text-center">
          <div className="mx-auto flex h-12 w-12 items-center justify-center rounded-full bg-primary/10 text-primary">
            <ShieldCheck className="h-6 w-6" />
          </div>
          <CardTitle className="text-2xl">First-run setup</CardTitle>
          <CardDescription>
            Create the first administrator account for the ICU Handover. This page disables itself
            once an account exists.
          </CardDescription>
        </CardHeader>
        <CardContent>
          <form onSubmit={handleSubmit} className="space-y-4">
            <div className="space-y-2">
              <Label htmlFor="name">Full name</Label>
              <Input id="name" required value={name} onChange={(e) => setName(e.target.value)} />
            </div>
            <div className="space-y-2">
              <Label htmlFor="email">Email (username)</Label>
              <Input id="email" type="email" required value={email} onChange={(e) => setEmail(e.target.value)} />
            </div>
            <div className="space-y-2">
              <Label htmlFor="password">Password</Label>
              <Input
                id="password"
                type="password"
                required
                minLength={12}
                pattern="(?=.*[a-z])(?=.*[A-Z])(?=.*[0-9])(?=.*[^A-Za-z0-9]).{12,}"
                title="At least 12 characters, including an uppercase letter, a lowercase letter, a number, and a symbol"
                value={password}
                onChange={(e) => setPassword(e.target.value)}
              />
              <p className="text-xs text-muted-foreground">
                Minimum 12 characters with uppercase, lowercase, number, and symbol.
              </p>
            </div>
            <Button type="submit" className="w-full" disabled={loading}>
              {loading ? "Creating…" : "Create administrator"}
            </Button>
          </form>
        </CardContent>
      </Card>
    </div>
  );
}
