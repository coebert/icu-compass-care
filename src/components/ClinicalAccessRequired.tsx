import { Card, CardContent } from "@/components/ui/card";
import { ShieldAlert } from "lucide-react";

// Shown in place of clinical history views when the signed-in user lacks
// clinical access (not an admin or clinician). This mirrors the RLS/server-side
// enforcement so the UI never presents a view the backend would reject.
export function ClinicalAccessRequired({
  title = "Clinical access required",
  description = "You need clinical access (clinician or admin) to view this information. Ask an administrator if you believe this is a mistake.",
}: {
  title?: string;
  description?: string;
}) {
  return (
    <Card>
      <CardContent className="flex flex-col items-center gap-3 py-10 text-center">
        <ShieldAlert className="h-8 w-8 text-muted-foreground" />
        <p className="text-sm font-semibold">{title}</p>
        <p className="max-w-md text-sm text-muted-foreground">{description}</p>
      </CardContent>
    </Card>
  );
}
