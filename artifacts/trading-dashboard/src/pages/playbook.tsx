import { useEffect, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  AISuggestedRulesPanel, BestSetupsSection, AvoidSetupsSection,
  PersonalRulesSection,
} from "@/components/playbook";
import type { PlaybookEntry } from "@/components/playbook";

interface Playbook { id: number; title: string; description: string; isActive: number }

const ENTRY_TYPES = [
  "RULE","ENTRY_RULE","EXIT_RULE","RISK_RULE","MARKET_CONDITION","SESSION_NOTE",
  "BEST_SETUP","AVOID_SETUP","STRENGTH_PATTERN","MISTAKE_PATTERN",
] as const;

export default function PlaybookPage() {
  const qc = useQueryClient();
  const [draft, setDraft] = useState<{ title: string; description: string; entryType: typeof ENTRY_TYPES[number] }>({
    title: "", description: "", entryType: "RULE",
  });

  const active = useQuery<{ playbook: Playbook | null }>({
    queryKey: ["playbook-active"],
    queryFn: async () => (await fetch("/api/playbooks/active")).json(),
  });

  const createPb = useMutation({
    mutationFn: async () => {
      const r = await fetch("/api/playbooks", {
        method: "POST", headers: { "content-type": "application/json" },
        body: JSON.stringify({ title: "My Trading Playbook", description: "Living document of my best setups, rules, and patterns." }),
      });
      return r.json();
    },
    onSuccess: () => qc.invalidateQueries({ queryKey: ["playbook-active"] }),
  });

  // Auto-create the first playbook the very first time you visit the page.
  useEffect(() => {
    if (active.isSuccess && active.data?.playbook == null && !createPb.isPending) {
      createPb.mutate();
    }
  }, [active.isSuccess, active.data?.playbook, createPb]);

  const playbookId = active.data?.playbook?.id;
  const entries = useQuery<{ entries: PlaybookEntry[] }>({
    queryKey: ["playbook-entries", playbookId],
    enabled: !!playbookId,
    queryFn: async () => (await fetch(`/api/playbook-entries?playbookId=${playbookId}`)).json(),
  });

  const addEntry = useMutation({
    mutationFn: async () => {
      if (!playbookId) throw new Error("no playbook");
      const r = await fetch("/api/playbook-entries", {
        method: "POST", headers: { "content-type": "application/json" },
        body: JSON.stringify({ playbookId, entryType: draft.entryType, title: draft.title, description: draft.description, source: "MANUAL" }),
      });
      if (!r.ok) throw new Error((await r.json()).error || "failed");
      return r.json();
    },
    onSuccess: () => {
      setDraft({ title: "", description: "", entryType: "RULE" });
      qc.invalidateQueries({ queryKey: ["playbook-entries", playbookId] });
    },
  });

  const toggleEntry = useMutation({
    mutationFn: async ({ id, next }: { id: number; next: boolean }) => {
      const r = await fetch(`/api/playbook-entries/${id}`, {
        method: "PATCH", headers: { "content-type": "application/json" },
        body: JSON.stringify({ isActive: next }),
      });
      return r.json();
    },
    onSuccess: () => qc.invalidateQueries({ queryKey: ["playbook-entries", playbookId] }),
  });

  const all = entries.data?.entries ?? [];
  const activeCount = all.filter((e) => e.isActive).length;

  return (
    <div className="space-y-4 p-4">
      <header>
        <h1 className="text-xl font-semibold text-foreground">Personal trading playbook</h1>
        <p className="text-xs text-txt-secondary">
          A living document derived from your own trading data. Guidance, not certainty.
          {playbookId && <> · {activeCount} active rule(s)</>}
        </p>
      </header>

      {!playbookId ? (
        <div className="rounded border border-dashed border-border p-6 text-center text-xs text-txt-secondary">
          Setting up your first playbook…
        </div>
      ) : (
        <>
          <div className="rounded-lg border border-border bg-card p-3">
            <h2 className="mb-2 text-sm font-semibold text-foreground">Add a rule manually</h2>
            <div className="grid grid-cols-1 gap-2 sm:grid-cols-[1fr,1fr,auto]">
              <select value={draft.entryType}
                onChange={(e) => setDraft({ ...draft, entryType: e.target.value as typeof ENTRY_TYPES[number] })}
                className="rounded border border-border bg-background/40 px-2 py-1 text-xs text-foreground">
                {ENTRY_TYPES.map((t) => <option key={t} value={t}>{t.replaceAll("_", " ")}</option>)}
              </select>
              <input value={draft.title} onChange={(e) => setDraft({ ...draft, title: e.target.value })}
                placeholder="Short title (e.g. 'No trading first 15 min after news')"
                className="rounded border border-border bg-background/40 px-2 py-1 text-xs text-foreground" />
              <button onClick={() => addEntry.mutate()} disabled={!draft.title || addEntry.isPending}
                className="rounded bg-success px-3 py-1 text-xs font-semibold text-foreground hover:bg-success disabled:opacity-40">
                Add
              </button>
            </div>
            <textarea value={draft.description} onChange={(e) => setDraft({ ...draft, description: e.target.value })}
              rows={2} placeholder="(optional) Why this rule matters, conditions, exceptions…"
              className="mt-2 w-full rounded border border-border bg-background/40 px-2 py-1 text-xs text-foreground" />
          </div>

          <div className="grid grid-cols-1 gap-3 lg:grid-cols-3">
            <div className="space-y-3 lg:col-span-2">
              <BestSetupsSection entries={all} onToggle={(id, next) => toggleEntry.mutate({ id, next })} />
              <AvoidSetupsSection entries={all} onToggle={(id, next) => toggleEntry.mutate({ id, next })} />
              <PersonalRulesSection entries={all} onToggle={(id, next) => toggleEntry.mutate({ id, next })} />
            </div>
            <div className="lg:col-span-1">
              <AISuggestedRulesPanel playbookId={playbookId} />
            </div>
          </div>
        </>
      )}
    </div>
  );
}
