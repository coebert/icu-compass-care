import {
  createFileRoute,
  Outlet,
  redirect,
  Link,
  useNavigate,
  useRouterState,
} from "@tanstack/react-router";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useServerFn } from "@tanstack/react-start";
import { useCallback, useEffect, useState } from "react";
import { toast } from "sonner";
import { supabase } from "@/integrations/supabase/client";
import { getMe } from "@/lib/me.functions";
import { claimFirstAdmin } from "@/lib/admin.functions";
import { Button } from "@/components/ui/button";
import { HeartPulse, LogOut, Users, Shield, ShieldCheck, User, RefreshCw, BedDouble, Lock, LayoutDashboard, History, Command as CommandIcon, Menu } from "lucide-react";
import {
  Sheet,
  SheetContent,
  SheetHeader,
  SheetTitle,
  SheetTrigger,
} from "@/components/ui/sheet";
import { SyncStatusPanel } from "@/components/SyncStatusPanel";
import { PasskeyLockScreen } from "@/components/PasskeyLockScreen";
import { CommandMenu } from "@/components/CommandMenu";
import { deviceHasPasskey, isSessionUnlocked, markSessionUnlocked, lockSession } from "@/lib/passkeys-client";
import { useInactivityTimeout } from "@/hooks/use-inactivity-timeout";


// Automatically end a session after this much inactivity, warning shortly
// before. Clinical data must not stay editable on an unattended workstation.
const INACTIVITY_TIMEOUT_MS = 15 * 60 * 1000;
const INACTIVITY_WARN_MS = 60 * 1000;

export const Route = createFileRoute("/_authenticated")({
  ssr: false,
  beforeLoad: async () => {
    const { data, error } = await supabase.auth.getUser();
    if (error || !data.user) throw redirect({ to: "/auth" });
    return { user: data.user };
  },
  component: AuthenticatedLayout,
});

function AuthenticatedLayout() {
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const me = useServerFn(getMe);
  const claim = useServerFn(claimFirstAdmin);
  const pathname = useRouterState({ select: (s) => s.location.pathname });
  const [hydrated, setHydrated] = useState(false);
  const [unlocked, setUnlocked] = useState(false);

  useEffect(() => {
    setHydrated(true);
    setUnlocked(isSessionUnlocked());
  }, []);

  // Bootstrap: if there is no admin yet, promote the first signed-in user.
  useEffect(() => {
    claim()
      .then((r) => {
        if (r.ok) queryClient.invalidateQueries({ queryKey: ["me"] });
      })
      .catch(() => {});
  }, [claim, queryClient]);

  const signOut = useCallback(
    async (reason?: string) => {
      await queryClient.cancelQueries();
      queryClient.clear();
      lockSession();
      await supabase.auth.signOut();
      navigate({ to: "/auth", replace: true });
      if (reason) toast.info(reason);
    },
    [queryClient, navigate],
  );

  // 1) Idle auto sign-out: after INACTIVITY_TIMEOUT_MS with no interaction,
  //    end the session and bounce to /auth so no further patient editing is
  //    possible until re-authentication. A warning fires one minute earlier.
  useInactivityTimeout({
    timeoutMs: INACTIVITY_TIMEOUT_MS,
    warnMs: INACTIVITY_WARN_MS,
    enabled: hydrated,
    onWarn: () =>
      toast.warning("You'll be signed out soon", {
        description: "Move the mouse or press a key to stay signed in.",
      }),
    onTimeout: () =>
      void signOut("Signed out after inactivity. Please sign in again."),
  });

  // 2) Session-expiry guard: if the Supabase session lapses (e.g. the device
  //    slept past the refresh window), redirect to /auth on the next tick.
  useEffect(() => {
    if (!hydrated) return;
    const check = async () => {
      const { data } = await supabase.auth.getSession();
      const expiresAt = data.session?.expires_at;
      if (!data.session || (expiresAt && expiresAt * 1000 <= Date.now())) {
        void signOut("Your session expired. Please sign in again.");
      }
    };
    const id = window.setInterval(check, 30_000);
    return () => window.clearInterval(id);
  }, [hydrated, signOut]);

  const { data: profile } = useQuery({ queryKey: ["me"], queryFn: () => me() });

  const deviceEnrolled = !!profile?.userId && deviceHasPasskey(profile.userId);
  const locked = deviceEnrolled && !unlocked;

  function lockNow() {
    lockSession();
    setUnlocked(false);
  }



  const navItems = [
    { to: "/patients", label: "Patients", icon: Users },
    { to: "/patients/history", label: "History", icon: History },
    { to: "/unit", label: "Unit", icon: LayoutDashboard },
    ...(profile?.isAdmin
      ? [
          { to: "/admin", label: "Staff", icon: Shield },
          { to: "/beds", label: "Beds", icon: BedDouble },
          { to: "/reconcile", label: "Sync", icon: RefreshCw },
        ]
      : []),
    { to: "/security-faq", label: "Security", icon: ShieldCheck },
    { to: "/settings", label: "My profile", icon: User },
  ];

  if (!hydrated) return null;

  if (locked) {
    return (
      <PasskeyLockScreen
        displayName={profile?.profile?.display_name ?? profile?.email}
        onUnlocked={() => {
          markSessionUnlocked();
          setUnlocked(true);
        }}
        onSignOut={() => void signOut()}
      />
    );
  }



  return (
    <div className="min-h-screen bg-muted/30">
      <header className="sticky top-0 z-30 border-b bg-background/95 backdrop-blur">
        <div className="mx-auto flex h-14 max-w-7xl items-center gap-3 px-4">
          <Link to="/patients" className="flex shrink-0 items-center gap-2 font-semibold">
            <HeartPulse className="h-5 w-5 text-primary" />
            <span className="hidden whitespace-nowrap sm:inline">ICU Handover</span>
          </Link>
          <nav className="flex min-w-0 flex-1 items-center gap-1 overflow-x-auto">
            {navItems.map((item) => {
              // Pick the most specific matching nav item so e.g. /patients/history
              // highlights "History" rather than also lighting up "Patients".
              const matches = navItems.filter(
                (n) => pathname === n.to || pathname.startsWith(n.to + "/"),
              );
              const best = matches.reduce(
                (a, b) => (b.to.length > a.to.length ? b : a),
                { to: "" } as { to: string },
              );
              const active = best.to === item.to;
              return (
                <Link key={item.to} to={item.to}>
                  <Button
                    variant={active ? "secondary" : "ghost"}
                    size="sm"
                    aria-label={item.label}
                    className="h-11 shrink-0 gap-1.5 sm:h-9"
                  >
                    <item.icon className="h-4 w-4 shrink-0" />
                    <span className="hidden whitespace-nowrap lg:inline">{item.label}</span>
                  </Button>
                </Link>

              );
            })}
          </nav>

          <div className="ml-auto flex shrink-0 items-center gap-2">
            <SyncStatusPanel
              className="hidden sm:inline-flex"
              isAdmin={profile?.isAdmin ?? false}
            />
            <span className="hidden max-w-[10rem] truncate whitespace-nowrap text-sm text-muted-foreground xl:inline">
              {profile?.profile?.display_name ?? profile?.email}
            </span>
            {deviceEnrolled && (
              <Button variant="outline" size="sm" onClick={lockNow} className="shrink-0 gap-1.5" aria-label="Lock session">
                <Lock className="h-4 w-4" />
                <span className="hidden whitespace-nowrap lg:inline">Lock now</span>
              </Button>
            )}
            <Button variant="outline" size="sm" onClick={() => void signOut()} className="shrink-0 gap-1.5" aria-label="Sign out">
              <LogOut className="h-4 w-4" />
              <span className="hidden whitespace-nowrap lg:inline">Sign out</span>
            </Button>
          </div>
        </div>
      </header>
      <main className="mx-auto max-w-7xl px-4 py-6">

        <Outlet />
      </main>
      <CommandMenu />
      {/* Discoverability hint for the command palette on ≥md viewports. */}
      <div
        aria-hidden="true"
        className="pointer-events-none fixed bottom-3 right-3 hidden items-center gap-1.5 rounded-md border bg-background/90 px-2 py-1 text-xs text-muted-foreground shadow-sm backdrop-blur md:inline-flex"
      >
        <CommandIcon className="h-3 w-3" />
        <span>K to jump</span>
      </div>
    </div>

  );
}
