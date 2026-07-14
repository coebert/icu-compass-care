import { createFileRoute } from "@tanstack/react-router";
import {
  Accordion,
  AccordionContent,
  AccordionItem,
  AccordionTrigger,
} from "@/components/ui/accordion";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { ShieldCheck, Info } from "lucide-react";

export const Route = createFileRoute("/_authenticated/security-faq")({
  head: () => ({
    meta: [
      { title: "Security FAQ — ICU Handover" },
      {
        name: "description",
        content:
          "Answers for clinical staff about how ICU Handover protects patient data, controls access, and records an audit trail.",
      },
      {
        property: "og:title",
        content: "Security FAQ — ICU Handover",
      },
      {
        property: "og:description",
        content:
          "Answers for clinical staff about how ICU Handover protects patient data, controls access, and records an audit trail.",
      },
      { property: "og:type", content: "website" },
      { name: "twitter:card", content: "summary" },
    ],
  }),
  component: SecurityFaqPage,
});

function SecurityFaqPage() {
  return (
    <div className="mx-auto max-w-3xl space-y-6">
      <div className="space-y-1">
        <h1 className="flex items-center gap-2 text-2xl font-bold">
          <ShieldCheck className="h-6 w-6 text-primary" />
          Security FAQ
        </h1>
        <p className="text-sm text-muted-foreground">
          How ICU Handover keeps patient information safe and accountable.
        </p>
      </div>

      <Alert>
        <Info className="h-4 w-4" />
        <AlertTitle>App-owned information</AlertTitle>
        <AlertDescription>
          This page is maintained by Salisbury District Hospital ICU to answer
          common security questions about ICU Handover. It describes the
          controls that are visible in the app and its backend today. It is not
          an independent security certification or audit report.
        </AlertDescription>
      </Alert>

      <Card>
        <CardHeader>
          <CardTitle>Frequently asked questions</CardTitle>
        </CardHeader>
        <CardContent>
          <Accordion type="single" collapsible defaultValue="rls">
            <AccordionItem value="rls">
              <AccordionTrigger>
                What does “fail-closed” RLS mean?
              </AccordionTrigger>
              <AccordionContent className="space-y-2 text-muted-foreground">
                <p>
                  The database uses Postgres Row Level Security (RLS). Once RLS
                  is enabled on a table, any operation without an explicit
                  matching policy is denied by default.
                </p>
                <p>
                  That means <strong>not writing a policy is itself a security
                  control</strong>. For example, audit tables such as{" "}
                  <code>patient_field_changes</code> and <code>record_audit</code>{" "}
                  have no UPDATE or DELETE policies, so no signed-in user can
                  alter or erase an audit row through the app. Corrections are
                  added as new rows, just like countersigned paper notes.
                </p>
              </AccordionContent>
            </AccordionItem>

            <AccordionItem value="protected">
              <AccordionTrigger>
                What patient data is protected?
              </AccordionTrigger>
              <AccordionContent className="space-y-2 text-muted-foreground">
                <p>
                  All clinical records are protected by RLS, including:
                </p>
                <ul className="ml-5 list-disc space-y-1">
                  <li>Patient demographics and identifiers</li>
                  <li>Current admission, management, and escalation plans</li>
                  <li>Investigations, microbiology, and referrals</li>
                  <li>Bed bookings, patient lines, tasks, and reviews</li>
                  <li>Handover versions and audit trails</li>
                </ul>
                <p>
                  Records are retained after discharge or death. Hard deletes are
                  never relied on for clinical history.
                </p>
              </AccordionContent>
            </AccordionItem>

            <AccordionItem value="access">
              <AccordionTrigger>
                Who can access what?
              </AccordionTrigger>
              <AccordionContent className="space-y-2 text-muted-foreground">
                <p>
                  Access is controlled by roles stored in a separate{" "}
                  <code>user_roles</code> table. Roles are never stored on user
                  profiles.
                </p>
                <ul className="ml-5 list-disc space-y-1">
                  <li>
                    <strong>Clinicians and admins</strong> can read and write
                    shared patient data needed for handover.
                  </li>
                  <li>
                    <strong>Admins</strong> can manage staff accounts, beds, and
                    partner-sharing settings.
                  </li>
                  <li>
                    <strong>All signed-in staff</strong> share full read/write
                    access to patients and investigations because the ICU team
                    works from a single shared record.
                  </li>
                </ul>
                <p>
                  Role checks live in a private database schema that cannot be
                  called from the public API, so they can only be used inside
                  policies and trusted server code.
                </p>
              </AccordionContent>
            </AccordionItem>

            <AccordionItem value="audited">
              <AccordionTrigger>
                How is access and editing audited?
              </AccordionTrigger>
              <AccordionContent className="space-y-2 text-muted-foreground">
                <p>
                  Every insert, update, and delete on patients, investigations,
                  referrals, and microbiology is written to{" "}
                  <code>record_audit</code>. Each row stores the actor, their
                  role, the action, which fields changed, and a before/after
                  snapshot with a timestamp.
                </p>
                <p>
                  Key field changes — including identifiers, demographics, and
                  clinical fields — are also captured in{" "}
                  <code>patient_field_changes</code> so the history view can show
                  exactly who changed a value and when.
                </p>
                <p>
                  Audit tables are append-only: they have INSERT and SELECT
                  policies, but no UPDATE or DELETE policies, so history cannot
                  be rewritten from the app.
                </p>
              </AccordionContent>
            </AccordionItem>

            <AccordionItem value="partner">
              <AccordionTrigger>
                What is partner sharing?
              </AccordionTrigger>
              <AccordionContent className="space-y-2 text-muted-foreground">
                <p>
                  A per-patient flag controls whether a patient’s record is
                  exposed to the partner (bridge) application. Only admins can
                  toggle this flag.
                </p>
                <p>
                  A database trigger records the time and the admin who changed
                  the flag, so every opt-in decision is attributable. Bridge
                  security events are also logged for review.
                </p>
              </AccordionContent>
            </AccordionItem>

            <AccordionItem value="session">
              <AccordionTrigger>
                How are sessions protected?
              </AccordionTrigger>
              <AccordionContent className="space-y-2 text-muted-foreground">
                <p>
                  Sign-in is required for every page. Accounts are created by
                  admins; there is no public registration.
                </p>
                <p>
                  For extra protection on shared workstations, sessions sign
                  out automatically after a period of inactivity. Staff can also
                  lock the session immediately with a passkey or password.
                </p>
              </AccordionContent>
            </AccordionItem>

            <AccordionItem value="shared">
              <AccordionTrigger>
                What is the ICU responsible for?
              </AccordionTrigger>
              <AccordionContent className="space-y-2 text-muted-foreground">
                <p>
                  The hosting platform provides encrypted storage, TLS in
                  transit, authentication services, and the RLS engine. The ICU
                  is responsible for the operational controls inside the app:
                </p>
                <ul className="ml-5 list-disc space-y-1">
                  <li>Creating and removing staff accounts</li>
                  <li>Assigning admin or clinician roles</li>
                  <li>Deciding which patients are shared with partner systems</li>
                  <li>Enforcing workstation and passkey policies</li>
                  <li>Reviewing audit logs and security events</li>
                </ul>
              </AccordionContent>
            </AccordionItem>
          </Accordion>
        </CardContent>
      </Card>
    </div>
  );
}
