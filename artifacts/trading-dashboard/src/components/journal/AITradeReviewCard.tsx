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
    <div className="space-y-2 rounded-xl border border-border bg-background/50 p-3">
      <div className="flex items-center justify-between">
        <div className="text-xs uppercase tracking-wide text-txt-muted">AI Trade Review</div>
        <button type="button" onClick={() => gen.mutate({ id: entry.id })} disabled={gen.isPending}
          className="rounded-md border border-border bg-card px-2 py-0.5 text-[11px] text-foreground hover:bg-secondary disabled:opacity-50">
          {r ? "Regenerate" : gen.isPending ? "Generating…" : "Generate"}
        </button>
      </div>
      {!r && <div className="text-xs text-txt-muted">No review yet.</div>}
      {r && (
        <>
          <p className="text-sm text-foreground">{r.summary}</p>
          <div className="grid gap-1.5 text-xs">
            <div><span className="text-txt-muted">Discipline · </span><span className="text-txt-secondary">{r.discipline}</span></div>
            <div><span className="text-txt-muted">Execution · </span><span className="text-txt-secondary">{r.execution}</span></div>
            <div><span className="text-txt-muted">Emotional · </span><span className="text-txt-secondary">{r.emotional}</span></div>
          </div>
          {(r.suggestedFocus?.length ?? 0) > 0 && (
            <div className="rounded-md border border-warning/40 bg-warning/10 p-2 text-xs text-warning">
              Focus next: {(r.suggestedFocus ?? []).join(", ")}
            </div>
          )}
        </>
      )}
    </div>
  );
}
