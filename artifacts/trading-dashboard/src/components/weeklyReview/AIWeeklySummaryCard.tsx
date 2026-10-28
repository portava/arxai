import type { WeeklyReview } from "@workspace/api-client-react";

// The paragraph is assembled by fixed rules from this week's closed trades
// (counted by close time) and journal tags — it is not written by an AI
// model, so it is not labelled as one.
export function AIWeeklySummaryCard({ r }: { r: WeeklyReview }) {
  return (
    <div className="space-y-2 rounded-xl border border-zinc-800 bg-zinc-950/50 p-3">
      <div className="text-xs uppercase tracking-wide text-zinc-500" data-testid="weekly-summary-title">Weekly summary</div>
      <p className="text-[11px] text-zinc-500" data-testid="weekly-summary-basis">
        Built from the trades you closed this week and your journal tags.
      </p>
      <p className="text-sm text-zinc-200">{r.aiSummary ?? "No summary available."}</p>
      {r.nextWeekFocus && (
        <div className="rounded-md border border-amber-500/40 bg-amber-500/10 p-2 text-xs text-amber-200">
          <span className="font-semibold">Focus next week: </span>{r.nextWeekFocus}
        </div>
      )}
    </div>
  );
}
