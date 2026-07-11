import { Card, CardContent } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Link } from "@tanstack/react-router";
import { ArrowLeft, ShieldAlert } from "lucide-react";

// Shown in place of clinical history views when the signed-in user lacks
// clinical access (not an admin or clinician). This mirrors the RLS/server-side
// enforcement so the UI never presents a view the backend would reject.
//
// This is the single, canonical gated-screen layout. Full-page history views
// pass `backTo`/`backLabel` to render the shared back-button + spacing wrapper
// consistently; inline sections (e.g. a card within a larger page) omit them to
// render just the notice card.
export function ClinicalAccessRequired({
  title = "Clinical access required",
  description = "You need clinical access (clinician or admin) to view this information. Ask an administrator if you believe this is a mistake.",
  backTo,
  backLabel = "Back",
}: {
  title?: string;
  description?: string;
  backTo?: string;
  backLabel?: string;
}) {
  const card = (
    <Card>
      <CardContent className="flex flex-col items-center gap-3 py-10 text-center">
        <ShieldAlert className="h-8 w-8 text-muted-foreground" />
        <p className="text-sm font-semibold">{title}</p>
        <p className="max-w-md text-sm text-muted-foreground">{description}</p>
      </CardContent>
    </Card>
  );

  if (!backTo) return card;

  return (
    <div className="space-y-4">
      <Button asChild variant="outline" size="sm" className="gap-1.5">
        <Link to={backTo}>
          <ArrowLeft className="h-4 w-4" /> {backLabel}
        </Link>
      </Button>
      {card}
    </div>
  );
}
