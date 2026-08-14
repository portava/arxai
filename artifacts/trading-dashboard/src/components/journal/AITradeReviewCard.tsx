import type { RichJournalEntry } from "@workspace/api-client-react";
import { useGenerateRichJournalAIReview, getGetRichJournalEntryQueryKey } from "@workspace/api-client-react";
import { useQueryClient } from "@tanstack/react-query";

export function AITradeReviewCard({ entry }: { entry: RichJournalEntry }) {
  const qc = useQueryClient();
  const gen = useGenerateRichJournalAIReview({ mutation: {
    onSuccess: () => qc.invalidateQueries({ queryKey: getGetRichJournalEntryQueryKey(entry.id) }),
  } });
  const r = entry.aiReview;
  return (
    <div className="space-y-2 rounded-xl border border-zinc-800 bg-zinc-950/50 p-3">
      <div className="flex items-center justify-between">
        <div className="text-xs uppercase tracking-wide text-zinc-500">AI Trade Review</div>
        <button type="button" onClick={() => gen.mutate({ id: entry.id })} disabled={gen.isPending}
          className="rounded-md border border-zinc-700 bg-zinc-900 px-2 py-0.5 text-[11px] text-zinc-200 hover:bg-zinc-800 disabled:opacity-50">
          {r ? "Regenerate" : gen.isPending ? "Generating…" : "Generate"}
        </button>
      </div>
      {!r && <div className="text-xs text-zinc-500">No review yet.</div>}
      {r && (
        <>
          <p className="text-sm text-zinc-200">{r.summary}</p>
          <div className="grid gap-1.5 text-xs">
            <div><span className="text-zinc-500">Discipline · </span><span className="text-zinc-300">{r.discipline}</span></div>
            <div><span className="text-zinc-500">Execution · </span><span className="text-zinc-300">{r.execution}</span></div>
            <div><span className="text-zinc-500">Emotional · </span><span className="text-zinc-300">{r.emotional}</span></div>
          </div>
          {(r.suggestedFocus?.length ?? 0) > 0 && (
            <div className="rounded-md border border-amber-500/40 bg-amber-500/10 p-2 text-xs text-amber-200">
              Focus next: {(r.suggestedFocus ?? []).join(", ")}
            </div>
          )}
        </>
      )}
    </div>
  );
}
