import { createFileRoute } from "@tanstack/react-router";
import {
  Accordion,
  AccordionContent,
  AccordionItem,
  AccordionTrigger,
} from "@/components/ui/accordion";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { ShieldCheck, Info, AlertTriangle, BedDouble, Clock } from "lucide-react";


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

            <AccordionItem value="initials">
              <AccordionTrigger>
                Does the app store patient names?
              </AccordionTrigger>
              <AccordionContent className="space-y-2 text-muted-foreground">
                <p>
                  No. Patients are identified by <strong>initials and hospital
                  number only</strong>. The initials field accepts a maximum of 10
                  characters and rejects anything that looks like a word, and the
                  same rule is enforced by the database itself — so a full name
                  cannot be saved, from this app or from the partner app across the
                  bridge. Names arriving from the partner system are reduced to
                  initials before they are stored.
                </p>
                <p>
                  Date of birth and NHS number are not held anywhere in this app.
                </p>
              </AccordionContent>
            </AccordionItem>

            <AccordionItem value="encryption">
              <AccordionTrigger>
                Are clinical notes and identifiers encrypted?
              </AccordionTrigger>
              <AccordionContent className="space-y-2 text-muted-foreground">
                <p>
                  Yes. Every free-text clinical field (current admission,
                  management plan, past medical history, the system-by-system
                  entries, TEP/DNACPR detail, and the nursing, physiotherapy and
                  SALT handovers) plus every identifier (initials, hospital
                  number and next-of-kin details) is encrypted with{" "}
                  <strong>AES-256-GCM</strong> before it is written to the
                  database. Each value gets its own random nonce and an
                  authentication tag, so a stored value cannot be altered
                  without detection.
                </p>
                <p>
                  Anyone looking directly at the database — including a database
                  backup or export — sees only ciphertext such as{" "}
                  <code>enc:v1:…</code>. The keys are held in the application
                  server environment, never in the database and never in the
                  browser.
                </p>
                <p>
                  To still allow lookups (for example matching a scanned chart
                  sticker to a patient, or spotting a previous admission), the
                  app stores a <strong>keyed hash</strong> (HMAC-SHA256) of the
                  hospital number and initials alongside the ciphertext. A hash
                  can be compared for an exact match but cannot be reversed back
                  into the original value, and without the key it cannot be
                  guessed by trying candidate numbers.
                </p>
                <p>
                  Saved handover versions are stored the same way: the whole
                  snapshot and its search index are encrypted, and searching
                  happens inside the application after decryption rather than in
                  readable database text. The audit trail also stores changed
                  values encrypted, so the history never becomes a readable copy
                  of the record.
                </p>
              </AccordionContent>
            </AccordionItem>



            <AccordionItem value="ai">
              <AccordionTrigger>
                Is any patient data sent to an AI model?
              </AccordionTrigger>
              <AccordionContent className="space-y-2 text-muted-foreground">
                <p>
                  Only when a clinician scans a paper 24-hour chart. Before any
                  image leaves the device, the app <strong>requires</strong> the
                  identity sticker to be blurred and the clinician to confirm that
                  the name, date of birth and hospital number are all covered. The
                  blur is baked into the image in the browser, so the redacted copy
                  is the only version that exists beyond the device.
                </p>
                <p>
                  The model is therefore only ever given the clinical grid, and is
                  instructed never to return an identifier. Any identifier it
                  returns anyway is discarded by the server before the values reach
                  the review screen — the clinician types the hospital number and
                  initials in themselves. Chart images are never written to storage,
                  never logged and are discarded as soon as the values are read.
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
                  snapshot with a timestamp. This table is readable by admins.
                </p>
                <p>
                  Key identifier and demographic field changes are also captured
                  in <code>patient_field_changes</code>, which is readable by
                  clinical staff, so the history view can show exactly who
                  changed a value and when.
                </p>
                <p>
                  Audit tables are append-only: SELECT policies let authorised
                  staff read them, but there are no UPDATE or DELETE policies,
                  so history cannot be altered or erased through the app.
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

            <AccordionItem value="legend">
              <AccordionTrigger id="clinical-colour-legend">
                What do the badge colours mean?
              </AccordionTrigger>
              <AccordionContent className="space-y-3 text-sm text-muted-foreground">
                <p>
                  Badges across the app use a shared colour system so the same
                  colour always signals the same kind of clinical importance.
                </p>
                <div className="grid gap-2">
                  <div className="flex items-start gap-3 rounded-md border p-3">
                    <Badge variant="outline" className="gap-1 border-rose-400 text-rose-700 dark:text-rose-300">
                      <AlertTriangle className="h-3 w-3" /> Rose
                    </Badge>
                    <div>
                      <p className="font-medium text-foreground">Safety-critical</p>
                      <p>Allergies, DNACPR, and other flags that must be seen before acting on the patient.</p>
                    </div>
                  </div>
                  <div className="flex items-start gap-3 rounded-md border p-3">
                    <Badge variant="outline" className="gap-1 border-amber-300 text-amber-700 dark:text-amber-300">
                      <BedDouble className="h-3 w-3" /> Amber
                    </Badge>
                    <div>
                      <p className="font-medium text-foreground">Attention needed</p>
                      <p>Isolation, deteriorating trend, side-room placement, or data outside the typical range.</p>
                    </div>
                  </div>
                  <div className="flex items-start gap-3 rounded-md border p-3">
                    <Badge variant="secondary">Neutral</Badge>
                    <div>
                      <p className="font-medium text-foreground">Neutral state</p>
                      <p>TEP, admission status, and other informational labels that don't require immediate action.</p>
                    </div>
                  </div>
                  <div className="flex items-start gap-3 rounded-md border p-3">
                    <Badge variant="outline" className="gap-1 border-muted-foreground/40 text-muted-foreground">
                      <Clock className="h-3 w-3" /> Muted
                    </Badge>
                    <div>
                      <p className="font-medium text-foreground">Stale / historical</p>
                      <p>Data that has not been updated recently, or timestamps from earlier admissions.</p>
                    </div>
                  </div>
                </div>
              </AccordionContent>
            </AccordionItem>

          </Accordion>
        </CardContent>
      </Card>
    </div>
  );
}
