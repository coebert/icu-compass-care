import { createFileRoute, useNavigate, redirect } from "@tanstack/react-router";
import { useEffect, useState } from "react";
import { supabase } from "@/integrations/supabase/client";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { toast } from "sonner";
import { HeartPulse, ShieldCheck, AlertCircle } from "lucide-react";

export const Route = createFileRoute("/auth")({
  ssr: false,
  beforeLoad: async () => {
    const { data } = await supabase.auth.getSession();
    if (data.session) throw redirect({ to: "/patients" });
  },
  loader: async () => {
    const { setupStatus } = await import("@/lib/setup.functions");
    const status = await setupStatus();
    if (status.needsSetup) throw redirect({ to: "/setup" });
  },
  component: AuthPage,
});

function AuthPage() {
  const navigate = useNavigate();
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [info, setInfo] = useState<string | null>(null);
  const [hydrated, setHydrated] = useState(false);

  useEffect(() => {
    setHydrated(true);
  }, []);

  useEffect(() => {
    supabase.auth.getSession().then(({ data }) => {
      if (data.session) navigate({ to: "/patients" });
    });
  }, [navigate]);

  if (!hydrated) return null;

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setLoading(true);
    setError(null);
    setInfo(null);
    const { error } = await supabase.auth.signInWithPassword({ email: email.trim(), password });
    setLoading(false);
    if (error) {
      // Keep the error visible in-page (screen-reader announced) rather than
      // relying on a toast that may auto-dismiss before staff can read it.
      setError(error.message || "Sign in failed. Please try again.");
      return;
    }
    toast.success("Signed in");
    navigate({ to: "/patients" });
  }

  async function handleForgotPassword() {
    const target = email.trim();
    setError(null);
    setInfo(null);
    if (!target) {
      setError("Enter your email address above, then tap “Forgot password”.");
      return;
    }
    setLoading(true);
    const { error } = await supabase.auth.resetPasswordForEmail(target, {
      redirectTo: `${window.location.origin}/auth`,
    });
    setLoading(false);
    if (error) {
      setError(error.message || "Could not send reset email.");
      return;
    }
    setInfo(
      `If an account exists for ${target}, a password-reset email has been sent. Check your inbox and spam folder.`,
    );
  }

  return (
    <div className="flex min-h-screen items-center justify-center bg-muted/40 px-4">
      <Card className="w-full max-w-md">
        <CardHeader className="space-y-2 text-center">
          <div className="mx-auto flex h-12 w-12 items-center justify-center rounded-full bg-primary/10 text-primary">
            <HeartPulse className="h-6 w-6" />
          </div>
          <CardTitle className="text-2xl">ICU Handover</CardTitle>
          <CardDescription>Salisbury District Hospital · Critical Care</CardDescription>
        </CardHeader>
        <CardContent>
          <form onSubmit={handleSubmit} className="space-y-4" noValidate>
            <div className="space-y-2">
              <Label htmlFor="email">Username (email)</Label>
              <Input
                id="email"
                type="email"
                autoComplete="username"
                required
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                placeholder="name@nhs.net"
                aria-invalid={!!error || undefined}
                aria-describedby={error ? "auth-error" : info ? "auth-info" : undefined}
              />
            </div>
            <div className="space-y-2">
              <div className="flex items-center justify-between">
                <Label htmlFor="password">Password</Label>
                <button
                  type="button"
                  onClick={handleForgotPassword}
                  disabled={loading}
                  className="text-xs font-medium text-primary underline-offset-4 hover:underline disabled:opacity-50"
                >
                  Forgot password?
                </button>
              </div>
              <Input
                id="password"
                type="password"
                autoComplete="current-password"
                required
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                aria-invalid={!!error || undefined}
                aria-describedby={error ? "auth-error" : undefined}
              />
            </div>

            {/* Persistent, screen-reader-announced status region. */}
            <div aria-live="polite" role="status" className="min-h-[1.25rem]">
              {error && (
                <p
                  id="auth-error"
                  className="flex items-start gap-1.5 rounded-md border border-destructive/40 bg-destructive/10 px-2.5 py-2 text-sm text-destructive"
                >
                  <AlertCircle className="mt-0.5 h-4 w-4 shrink-0" />
                  <span>{error}</span>
                </p>
              )}
              {info && !error && (
                <p
                  id="auth-info"
                  className="rounded-md border bg-muted/60 px-2.5 py-2 text-sm text-muted-foreground"
                >
                  {info}
                </p>
              )}
            </div>

            <Button type="submit" className="w-full" disabled={loading}>
              {loading ? "Signing in…" : "Sign in"}
            </Button>
          </form>
          <p className="mt-6 flex items-center justify-center gap-1.5 text-center text-xs text-muted-foreground">
            <ShieldCheck className="h-3.5 w-3.5" />
            Accounts are created by an administrator. Contact your ICU admin for access.
          </p>
        </CardContent>
      </Card>
    </div>
  );
}
