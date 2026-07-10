import { createFileRoute, Outlet, redirect, Link, useNavigate, useRouterState } from "@tanstack/react-router";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useServerFn } from "@tanstack/react-start";
import { useEffect, useState } from "react";
import { supabase } from "@/integrations/supabase/client";
import { getMe } from "@/lib/me.functions";
import { claimFirstAdmin } from "@/lib/admin.functions";
import { Button } from "@/components/ui/button";
import { HeartPulse, LogOut, Users, Shield, User, RefreshCw } from "lucide-react";
import { SyncStatusPanel } from "@/components/SyncStatusPanel";

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

  useEffect(() => {
    setHydrated(true);
  }, []);

  // Bootstrap: if there is no admin yet, promote the first signed-in user.
  useEffect(() => {
    claim().then((r) => {
      if (r.ok) queryClient.invalidateQueries({ queryKey: ["me"] });
    }).catch(() => {});
  }, [claim, queryClient]);

  async function signOut() {
    await queryClient.cancelQueries();
    queryClient.clear();
    await supabase.auth.signOut();
    navigate({ to: "/auth", replace: true });
  }

  const { data: profile } = useQuery({ queryKey: ["me"], queryFn: () => me() });

  const navItems = [
    { to: "/patients", label: "Patients", icon: Users },
    ...(profile?.isAdmin
      ? [
          { to: "/admin", label: "Staff", icon: Shield },
          { to: "/reconcile", label: "Sync", icon: RefreshCw },
        ]
      : []),
    { to: "/settings", label: "My profile", icon: User },
  ];

  if (!hydrated) return null;

  return (
    <div className="min-h-screen bg-muted/30">
      <header className="sticky top-0 z-30 border-b bg-background/95 backdrop-blur">
        <div className="mx-auto flex h-14 max-w-6xl items-center gap-4 px-4">
          <Link to="/patients" className="flex items-center gap-2 font-semibold">
            <HeartPulse className="h-5 w-5 text-primary" />
            <span className="hidden sm:inline">ICU Handover</span>
          </Link>
          <nav className="flex items-center gap-1">
            {navItems.map((item) => {
              const active = pathname.startsWith(item.to);
              return (
                <Link key={item.to} to={item.to}>
                  <Button variant={active ? "secondary" : "ghost"} size="sm" className="gap-1.5">
                    <item.icon className="h-4 w-4" />
                    <span className="hidden sm:inline">{item.label}</span>
                  </Button>
                </Link>
              );
            })}
          </nav>
          <div className="ml-auto flex items-center gap-3">
            <SyncStatusPanel className="hidden sm:inline-flex" isAdmin={profile?.isAdmin ?? false} />
            <span className="hidden text-sm text-muted-foreground md:inline">
              {profile?.profile?.display_name ?? profile?.email}
            </span>
            <Button variant="outline" size="sm" onClick={signOut} className="gap-1.5">
              <LogOut className="h-4 w-4" />
              <span className="hidden sm:inline">Sign out</span>
            </Button>
          </div>

        </div>
      </header>
      <main className="mx-auto max-w-6xl px-4 py-6">
        <Outlet />
      </main>
    </div>
  );
}
