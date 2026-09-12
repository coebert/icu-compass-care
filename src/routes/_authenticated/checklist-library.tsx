import { createFileRoute, Link } from "@tanstack/react-router";
import { useMemo, useRef, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useServerFn } from "@tanstack/react-start";
import { toast } from "sonner";
import { Archive, ArrowLeft, Library, RotateCcw, Search, Upload } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";
import { ListSkeleton } from "@/components/LoadingSkeleton";
import {
  TemplateDialog,
  TemplateHistoryDialog,
  type TemplateDraftSeed,
} from "@/components/patient/checklists-tab";
import { listChecklistLibrary, setChecklistTemplateActive } from "@/lib/checklists.functions";
import { parseChecklistItems, formatTargetMinutes, roleLabel } from "@/lib/checklists";
import { fmtDateTime } from "@/lib/icu";

export const Route = createFileRoute("/_authenticated/checklist-library")({
  component: ChecklistLibraryPage,
  head: () => ({
    meta: [
      { title: "Checklist library — ICU Handover" },
      {
        name: "description",
        content:
          "Search, categorise, upload and review the version history of critical care management checklists.",
      },
      { property: "og:title", content: "Checklist library — ICU Handover" },
      {
        property: "og:description",
        content:
          "One place to keep unit checklists: search by name or item, group by specialty, upload your own and restore earlier versions.",
      },
      { property: "og:type", content: "website" },
      { name: "twitter:card", content: "summary" },
    ],
  }),
});

type LibraryRow = {
  id: string;
  key: string;
  name: string;
  description: string | null;
  specialty: string | null;
  items: unknown;
  is_active: boolean;
  is_builtin: boolean;
  created_at: string;
  updated_at: string;
};

const ALL = "__all__";
const UNCATEGORISED = "Uncategorised";

// Turn an uploaded plain-text, markdown or CSV checklist into the editor's
// line syntax: task | guidance | responsible | accountable | target | key
function parseUpload(fileName: string, text: string): TemplateDraftSeed {
  const raw = text.replace(/\r\n?/g, "\n").split("\n");
  let name = fileName.replace(/\.[^.]+$/, "").replace(/[_-]+/g, " ").trim();
  const lines: string[] = [];
  let headingUsed = false;
  for (const original of raw) {
    let line = original.trim();
    if (line === "") continue;
    if (line.startsWith("#")) {
      const heading = line.replace(/^#+\s*/, "").trim();
      if (!headingUsed && heading !== "") {
        name = heading;
        headingUsed = true;
      }
      continue;
    }
    // markdown bullets, tick boxes and numbering
    line = line
      .replace(/^[-*•]\s*/, "")
      .replace(/^\[[ xX]\]\s*/, "")
      .replace(/^\d+[.)]\s*/, "")
      .trim();
    if (line === "") continue;
    // CSV / tab separated columns map onto the same fields
    if (!line.includes("|") && (line.includes(",") || line.includes("\t"))) {
      const cols = line
        .split(/\t|,(?=(?:[^"]*"[^"]*")*[^"]*$)/)
        .map((c) => c.replace(/^"|"$/g, "").trim());
      if (/^(task|item|checklist item)$/i.test(cols[0] ?? "")) continue; // header row
      line = cols.filter((c, i) => i === 0 || c !== "").join(" | ");
    }
    lines.push(line);
  }
  return { name, lines: lines.join("\n") };
}

function ChecklistLibraryPage() {
  const qc = useQueryClient();
  const listFn = useServerFn(listChecklistLibrary);
  const setActiveFn = useServerFn(setChecklistTemplateActive);
  const [q, setQ] = useState("");
  const [category, setCategory] = useState<string>(ALL);
  const [showArchived, setShowArchived] = useState(false);
  const [seed, setSeed] = useState<TemplateDraftSeed | null>(null);
  const [seedOpen, setSeedOpen] = useState(false);
  const fileRef = useRef<HTMLInputElement | null>(null);

  const rowsQ = useQuery({
    queryKey: ["checklist-templates", "library"],
    queryFn: () => listFn() as Promise<LibraryRow[]>,
  });

  const activeM = useMutation({
    mutationFn: (v: { id: string; active: boolean }) => setActiveFn({ data: v }),
    onSuccess: (_r, v) => {
      void qc.invalidateQueries({ queryKey: ["checklist-templates"] });
      toast.success(v.active ? "Checklist restored" : "Checklist archived");
    },
    onError: (e: Error) => toast.error(e.message || "Could not change the checklist"),
  });

  const rows = rowsQ.data ?? [];

  const categories = useMemo(() => {
    const set = new Set<string>();
    for (const r of rows) set.add(r.specialty?.trim() || UNCATEGORISED);
    return Array.from(set).sort((a, b) =>
      a === UNCATEGORISED ? 1 : b === UNCATEGORISED ? -1 : a.localeCompare(b),
    );
  }, [rows]);

  const filtered = useMemo(() => {
    const needle = q.trim().toLowerCase();
    return rows.filter((r) => {
      if (!showArchived && !r.is_active) return false;
      if (category !== ALL && (r.specialty?.trim() || UNCATEGORISED) !== category) return false;
      if (needle === "") return true;
      const haystack = [
        r.name,
        r.description ?? "",
        r.specialty ?? "",
        ...parseChecklistItems(r.items).map((i) => `${i.label} ${i.hint ?? ""}`),
      ]
        .join(" ")
        .toLowerCase();
      return haystack.includes(needle);
    });
  }, [rows, q, category, showArchived]);

  const onFiles = async (files: FileList | null) => {
    const file = files?.[0];
    if (!file) return;
    try {
      const text = await file.text();
      const parsed = parseUpload(file.name, text);
      if (!parsed.lines || parsed.lines.trim() === "") {
        toast.error("No checklist items found in that file");
        return;
      }
      setSeed(parsed);
      setSeedOpen(true);
    } catch {
      toast.error("Could not read that file");
    } finally {
      if (fileRef.current) fileRef.current.value = "";
    }
  };

  return (
    <div className="mx-auto w-full max-w-5xl space-y-4 p-3 sm:p-4">
      <div className="flex flex-wrap items-center gap-2">
        <Button asChild variant="ghost" size="sm">
          <Link to="/">
            <ArrowLeft className="mr-1.5 h-4 w-4" /> Back
          </Link>
        </Button>
        <h1 className="flex items-center gap-2 text-lg font-semibold">
          <Library className="h-5 w-5" /> Checklist library
        </h1>
        <div className="ml-auto flex flex-wrap items-center gap-2">
          <input
            ref={fileRef}
            type="file"
            accept=".txt,.md,.csv,.tsv,text/plain,text/csv,text/markdown"
            className="hidden"
            onChange={(e) => void onFiles(e.target.files)}
          />
          <Button variant="outline" onClick={() => fileRef.current?.click()}>
            <Upload className="mr-1.5 h-4 w-4" /> Upload checklist
          </Button>
          <TemplateDialog />
        </div>
      </div>

      <p className="text-sm text-muted-foreground">
        Every checklist available to your units. Upload your own from a text, markdown or CSV file
        (one item per line), give it a category, and open the history of any checklist to see or
        restore an earlier version. Changes made by clinical staff go to an administrator for
        approval before they reach patient checklist tabs.
      </p>

      <div className="flex flex-col gap-2 sm:flex-row sm:items-center">
        <div className="relative min-w-0 flex-1">
          <Search className="pointer-events-none absolute left-2.5 top-2.5 h-4 w-4 text-muted-foreground" />
          <Input
            className="pl-8"
            placeholder="Search checklists and items"
            value={q}
            onChange={(e) => setQ(e.target.value)}
          />
        </div>
        <Button
          variant={showArchived ? "secondary" : "outline"}
          onClick={() => setShowArchived((v) => !v)}
        >
          <Archive className="mr-1.5 h-4 w-4" />
          {showArchived ? "Showing archived" : "Show archived"}
        </Button>
      </div>

      <div className="flex flex-wrap gap-1.5">
        <Button
          size="sm"
          variant={category === ALL ? "secondary" : "outline"}
          onClick={() => setCategory(ALL)}
        >
          All categories
        </Button>
        {categories.map((c) => (
          <Button
            key={c}
            size="sm"
            variant={category === c ? "secondary" : "outline"}
            onClick={() => setCategory(c)}
          >
            {c}
          </Button>
        ))}
      </div>

      {rowsQ.isLoading ? (
        <ListSkeleton rows={4} />
      ) : filtered.length === 0 ? (
        <Card>
          <CardContent className="p-6 text-sm text-muted-foreground">
            No checklists match that search.
          </CardContent>
        </Card>
      ) : (
        <div className="space-y-3">
          {filtered.map((t) => {
            const items = parseChecklistItems(t.items);
            return (
              <Card key={t.id} className={t.is_active ? undefined : "opacity-70"}>
                <CardHeader className="pb-2">
                  <div className="flex flex-wrap items-start gap-2">
                    <CardTitle className="min-w-0 text-base">{t.name}</CardTitle>
                    <Badge variant="outline">{t.specialty?.trim() || UNCATEGORISED}</Badge>
                    {t.is_builtin ? <Badge variant="secondary">Standard</Badge> : null}
                    {t.is_active ? null : <Badge variant="destructive">Archived</Badge>}
                    <span className="text-xs text-muted-foreground">
                      {items.length} item{items.length === 1 ? "" : "s"} · updated{" "}
                      {fmtDateTime(t.updated_at)}
                    </span>
                    <div className="ml-auto flex flex-wrap gap-1.5">
                      <TemplateDialog template={t} />
                      <TemplateHistoryDialog template={t} />
                      <Button
                        variant="ghost"
                        onClick={() => activeM.mutate({ id: t.id, active: !t.is_active })}
                        disabled={activeM.isPending}
                      >
                        {t.is_active ? (
                          <>
                            <Archive className="mr-1.5 h-4 w-4" /> Archive
                          </>
                        ) : (
                          <>
                            <RotateCcw className="mr-1.5 h-4 w-4" /> Restore
                          </>
                        )}
                      </Button>
                    </div>
                  </div>
                  {t.description ? (
                    <p className="text-sm text-muted-foreground">{t.description}</p>
                  ) : null}
                </CardHeader>
                <CardContent className="pt-0">
                  <ul className="space-y-1 text-sm">
                    {items.map((i) => (
                      <li key={i.key} className="flex flex-wrap items-baseline gap-x-2">
                        <span>{i.label}</span>
                        {i.hint ? (
                          <span className="text-xs text-muted-foreground">{i.hint}</span>
                        ) : null}
                        {i.responsible ? (
                          <Badge variant="outline" className="text-[10px]">
                            {roleLabel(i.responsible)}
                          </Badge>
                        ) : null}
                        {i.target_minutes ? (
                          <Badge variant="outline" className="text-[10px]">
                            {formatTargetMinutes(i.target_minutes)}
                          </Badge>
                        ) : null}
                        {i.critical ? (
                          <Badge variant="destructive" className="text-[10px]">
                            key
                          </Badge>
                        ) : null}
                      </li>
                    ))}
                  </ul>
                </CardContent>
              </Card>
            );
          })}
        </div>
      )}

      {seed ? (
        <TemplateDialog
          key={`${seed.name}-${seed.lines?.length ?? 0}`}
          seed={seed}
          showTrigger={false}
          open={seedOpen}
          onOpenChange={(o) => {
            setSeedOpen(o);
            if (!o) setSeed(null);
          }}
        />
      ) : null}
    </div>
  );
}
