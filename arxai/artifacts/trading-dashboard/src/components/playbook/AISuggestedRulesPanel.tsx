import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import type { AISuggestion } from "./types";

interface Props { playbookId: number }

export function AISuggestedRulesPanel({ playbookId }: Props) {
  const qc = useQueryClient();
  const sug = useQuery<{ suggestions: AISuggestion[]; counts?: Record<string, number> }>({
    queryKey: ["playbook-suggest", playbookId],
    queryFn: async () =>
      (await fetch(`/api/playbooks/${playbookId}/suggest`, { method: "POST" })).json(),
  });
  const accept = useMutation({
    mutationFn: async (s: AISuggestion) => {
      const r = await fetch("/api/playbook-entries", {
        method: "POST", headers: { "content-type": "application/json" },
        body: JSON.stringify({
          playbookId, entryType: s.entryType, title: s.title,
          description: s.description, confidenceScore: s.confidenceScore, source: "AI",
        }),
      });
      if (!r.ok) throw new Error((await r.json()).error || "failed");
      return r.json();
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["playbook-entries", playbookId] });
      qc.invalidateQueries({ queryKey: ["playbook-suggest", playbookId] });
    },
  });

  return (
    <div className="rounded-lg border border-violet-700 bg-violet-950/20 p-3">
      <div className="mb-2 flex items-center justify-between">
        <h3 className="text-sm font-semibold text-violet-200">AI-suggested rules</h3>
        <button onClick={() => sug.refetch()} disabled={sug.isFetching}
          className="rounded bg-violet-700 px-2 py-0.5 text-[11px] font-semibold text-white hover:bg-violet-600 disabled:opacity-40">
          {sug.isFetching ? "Mining…" : "Re-mine"}
        </button>
      </div>
      <p className="mb-2 text-[10px] italic text-violet-300/80">
        Heuristic patterns mined from your journal, debriefs, and weekly reviews. Guidance, not certainty.
      </p>
      {sug.data?.counts && (
        <p className="mb-2 text-[10px] text-slate-400">
          Searched {sug.data.counts["journals"]} journals · {sug.data.counts["debriefs"]} debriefs · {sug.data.counts["reviews"]} reviews
        </p>
      )}
      {sug.data && sug.data.suggestions.length === 0 && (
        <p className="text-xs text-slate-400">No recurring patterns found yet — log more debriefs and reviews.</p>
      )}
      <ul className="space-y-1.5">
        {(sug.data?.suggestions ?? []).map((s, i) => (
          <li key={i} className="rounded border border-violet-800 bg-slate-950/40 p-2">
            <div className="flex items-start justify-between gap-2">
              <div className="flex-1">
                <div className="mb-0.5 flex items-center gap-1.5">
                  <span className="rounded bg-slate-800 px-1.5 py-0.5 text-[9px] font-bold uppercase tracking-wide text-violet-300">
                    {s.entryType.replaceAll("_", " ")}
                  </span>
                  <span className="text-[10px] text-slate-500">conf {Math.round(s.confidenceScore)}</span>
                </div>
                <p className="text-xs font-semibold text-slate-100">{s.title}</p>
                <p className="mt-0.5 text-[10px] text-slate-400">{s.description}</p>
              </div>
              <button onClick={() => accept.mutate(s)} disabled={accept.isPending}
                className="rounded bg-emerald-700 px-2 py-0.5 text-[10px] font-bold text-white hover:bg-emerald-600 disabled:opacity-40">
                + Add
              </button>
            </div>
          </li>
        ))}
      </ul>
    </div>
  );
}
