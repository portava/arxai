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
        <div className="text-xs uppercase tracking-wide text-zinc-500">Reviews</div>
        <div className="flex gap-2">
          <button type="button" disabled={wk.isPending} onClick={() => wk.mutate()}
            className="rounded-md border border-zinc-700 bg-zinc-900 px-2 py-1 text-[11px] text-zinc-200 hover:bg-zinc-800 disabled:opacity-50">
            {wk.isPending ? "…" : "Weekly review"}
          </button>
          <button type="button" disabled={mo.isPending} onClick={() => mo.mutate()}
            className="rounded-md border border-zinc-700 bg-zinc-900 px-2 py-1 text-[11px] text-zinc-200 hover:bg-zinc-800 disabled:opacity-50">
            {mo.isPending ? "…" : "Monthly review"}
          </button>
        </div>
      </div>
      {sessions.length === 0 && <div className="rounded-lg border border-zinc-800 bg-zinc-950/50 p-3 text-xs text-zinc-500">No reviews yet.</div>}
      <ul className="space-y-2">
        {sessions.map((s) => (
          <li key={s.id} className="space-y-1.5 rounded-xl border border-zinc-800 bg-zinc-950/50 p-3">
            <div className="flex items-center justify-between">
              <div className="text-sm font-medium text-zinc-100">{s.reviewType} · {s.totalTradesReviewed} trade{s.totalTradesReviewed === 1 ? "" : "s"}</div>
              <div className="text-[10px] text-zinc-500">{new Date(s.createdAtIso).toLocaleDateString()}</div>
            </div>
            {s.aiSummary && <p className="text-xs text-zinc-300">{s.aiSummary}</p>}
            {s.actionPlan.length > 0 && (
              <ul className="ml-4 list-disc space-y-0.5 text-[11px] text-amber-200">
                {s.actionPlan.map((a, i) => <li key={i}>{a}</li>)}
              </ul>
            )}
          </li>
        ))}
      </ul>
    </div>
  );
}
