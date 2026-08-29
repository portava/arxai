import { useQueryClient } from "@tanstack/react-query";
import {
  useListReviewSessions, useCreateWeeklyReview, useCreateMonthlyReview,
  getListReviewSessionsQueryKey,
} from "@workspace/api-client-react";

export function ReviewSummaryCard() {
  const qc = useQueryClient();
  const { data } = useListReviewSessions({ query: { queryKey: getListReviewSessionsQueryKey() } });
  const inv = () => qc.invalidateQueries({ queryKey: getListReviewSessionsQueryKey() });
  const wk = useCreateWeeklyReview({ mutation: { onSuccess: inv } });
  const mo = useCreateMonthlyReview({ mutation: { onSuccess: inv } });
  const sessions = data?.sessions ?? [];

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="text-xs uppercase tracking-wide text-txt-muted">Reviews</div>
        <div className="flex gap-2">
          <button type="button" disabled={wk.isPending} onClick={() => wk.mutate()}
            className="rounded-md border border-border bg-card px-2 py-1 text-[11px] text-foreground hover:bg-secondary disabled:opacity-50">
            {wk.isPending ? "…" : "Weekly review"}
          </button>
          <button type="button" disabled={mo.isPending} onClick={() => mo.mutate()}
            className="rounded-md border border-border bg-card px-2 py-1 text-[11px] text-foreground hover:bg-secondary disabled:opacity-50">
            {mo.isPending ? "…" : "Monthly review"}
          </button>
        </div>
      </div>
      {sessions.length === 0 && <div className="rounded-lg border border-border bg-background/50 p-3 text-xs text-txt-muted">No reviews yet.</div>}
      <ul className="space-y-2">
        {sessions.map((s) => (
          <li key={s.id} className="space-y-1.5 rounded-xl border border-border bg-background/50 p-3">
            <div className="flex items-center justify-between">
              <div className="text-sm font-medium text-foreground">{s.reviewType} · {s.totalTradesReviewed} trade{s.totalTradesReviewed === 1 ? "" : "s"}</div>
              <div className="text-[10px] text-txt-muted">{new Date(s.createdAtIso).toLocaleDateString()}</div>
            </div>
            {s.aiSummary && <p className="text-xs text-txt-secondary">{s.aiSummary}</p>}
            {s.actionPlan.length > 0 && (
              <ul className="ml-4 list-disc space-y-0.5 text-[11px] text-warning">
                {s.actionPlan.map((a, i) => <li key={i}>{a}</li>)}
              </ul>
            )}
          </li>
        ))}
      </ul>
    </div>
  );
}
