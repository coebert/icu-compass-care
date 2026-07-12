import { createFileRoute, Link } from "@tanstack/react-router";
import { useMemo, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useServerFn } from "@tanstack/react-start";
import {
  listAntimicrobialLibrary,
  addAntimicrobialName,
  renameAntimicrobialName,
  deleteAntimicrobialName,
  type AntimicrobialLibraryRow,
} from "@/lib/antimicrobials.functions";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Card, CardContent } from "@/components/ui/card";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { ArrowLeft, Plus, Pencil, Trash2, Search, Check, X } from "lucide-react";
import { toast } from "sonner";

export const Route = createFileRoute("/_authenticated/antimicrobials")({
  component: AntimicrobialLibrary,
});

function AntimicrobialLibrary() {
  const qc = useQueryClient();
  const list = useServerFn(listAntimicrobialLibrary);
  const add = useServerFn(addAntimicrobialName);
  const rename = useServerFn(renameAntimicrobialName);
  const remove = useServerFn(deleteAntimicrobialName);

  const [search, setSearch] = useState("");
  const [letter, setLetter] = useState<string>("all");
  const [newName, setNewName] = useState("");
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editName, setEditName] = useState("");
  const [pendingDelete, setPendingDelete] = useState<AntimicrobialLibraryRow | null>(null);

  const { data: names = [], isLoading } = useQuery({
    queryKey: ["antimicrobial-library"],
    queryFn: () => list() as Promise<AntimicrobialLibraryRow[]>,
  });

  const invalidate = () => {
    qc.invalidateQueries({ queryKey: ["antimicrobial-library"] });
    qc.invalidateQueries({ queryKey: ["antimicrobial-names"] });
  };

  const addMut = useMutation({
    mutationFn: (name: string) => add({ data: { name } }),
    onSuccess: () => {
      invalidate();
      setNewName("");
      toast.success("Added to library");
    },
    onError: (e: Error) => toast.error("Could not add name", { description: e.message }),
  });

  const renameMut = useMutation({
    mutationFn: (v: { id: string; name: string }) => rename({ data: v }),
    onSuccess: () => {
      invalidate();
      setEditingId(null);
      toast.success("Name updated");
    },
    onError: (e: Error) => toast.error("Could not rename", { description: e.message }),
  });

  const deleteMut = useMutation({
    mutationFn: (id: string) => remove({ data: { id } }),
    onSuccess: () => {
      invalidate();
      setPendingDelete(null);
      toast.success("Removed from library");
    },
    onError: (e: Error) => toast.error("Could not remove", { description: e.message }),
  });

  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase();
    if (!q) return names;
    return names.filter((n) => n.name.toLowerCase().includes(q));
  }, [names, search]);

  function startEdit(row: AntimicrobialLibraryRow) {
    setEditingId(row.id);
    setEditName(row.name);
  }

  return (
    <div className="space-y-4">
      <Button asChild variant="outline" size="sm" className="gap-1.5">
        <Link to="/admin">
          <ArrowLeft className="h-4 w-4" /> Back to admin
        </Link>
      </Button>

      <div className="min-w-0">
        <h1 className="text-2xl font-bold">Antimicrobial library</h1>
        <p className="text-sm text-muted-foreground">
          Manage the shared list of antimicrobial agent names. These names appear as
          suggestions when recording antimicrobials on a patient.
        </p>
      </div>

      <Card>
        <CardContent className="p-3">
          <form
            className="flex flex-wrap items-center gap-2"
            onSubmit={(e) => {
              e.preventDefault();
              const trimmed = newName.trim();
              if (trimmed) addMut.mutate(trimmed);
            }}
          >
            <Input
              value={newName}
              onChange={(e) => setNewName(e.target.value)}
              placeholder="Add an antimicrobial name…"
              className="flex-1 min-w-[12rem]"
            />
            <Button type="submit" className="gap-1.5" disabled={addMut.isPending || !newName.trim()}>
              <Plus className="h-4 w-4" /> Add
            </Button>
          </form>
        </CardContent>
      </Card>

      <div className="relative">
        <Search className="absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
        <Input
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          placeholder="Search names"
          className="pl-9"
        />
      </div>

      {isLoading ? (
        <p className="text-sm text-muted-foreground">Loading…</p>
      ) : filtered.length === 0 ? (
        <p className="text-sm text-muted-foreground">
          {names.length === 0 ? "No names yet. Add your first antimicrobial above." : "No names match your search."}
        </p>
      ) : (
        <div className="grid gap-2">
          {filtered.map((row) => (
            <Card key={row.id}>
              <CardContent className="flex flex-wrap items-center gap-3 p-3">
                {editingId === row.id ? (
                  <>
                    <Input
                      autoFocus
                      value={editName}
                      onChange={(e) => setEditName(e.target.value)}
                      onKeyDown={(e) => {
                        if (e.key === "Enter" && editName.trim()) {
                          e.preventDefault();
                          renameMut.mutate({ id: row.id, name: editName.trim() });
                        } else if (e.key === "Escape") {
                          setEditingId(null);
                        }
                      }}
                      className="flex-1 min-w-[10rem]"
                    />
                    <div className="ml-auto flex gap-2">
                      <Button
                        size="sm"
                        className="gap-1.5"
                        disabled={renameMut.isPending || !editName.trim()}
                        onClick={() => renameMut.mutate({ id: row.id, name: editName.trim() })}
                      >
                        <Check className="h-4 w-4" /> Save
                      </Button>
                      <Button size="sm" variant="outline" className="gap-1.5" onClick={() => setEditingId(null)}>
                        <X className="h-4 w-4" /> Cancel
                      </Button>
                    </div>
                  </>
                ) : (
                  <>
                    <span className="min-w-0 truncate font-medium">{row.name}</span>
                    <div className="ml-auto flex gap-2">
                      <Button size="sm" variant="outline" className="gap-1.5" onClick={() => startEdit(row)}>
                        <Pencil className="h-4 w-4" /> Edit
                      </Button>
                      <Button
                        size="sm"
                        variant="outline"
                        className="gap-1.5 text-destructive"
                        onClick={() => setPendingDelete(row)}
                      >
                        <Trash2 className="h-4 w-4" /> Remove
                      </Button>
                    </div>
                  </>
                )}
              </CardContent>
            </Card>
          ))}
        </div>
      )}

      <AlertDialog open={!!pendingDelete} onOpenChange={(o) => !o && setPendingDelete(null)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Remove "{pendingDelete?.name}"?</AlertDialogTitle>
            <AlertDialogDescription>
              This removes the name from the shared library and its suggestions. Antimicrobials
              already recorded on patients are not affected.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction
              disabled={deleteMut.isPending}
              onClick={() => pendingDelete && deleteMut.mutate(pendingDelete.id)}
            >
              Remove
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}
