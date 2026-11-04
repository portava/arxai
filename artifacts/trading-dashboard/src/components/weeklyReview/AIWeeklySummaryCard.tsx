import type { WeeklyReview } from "@workspace/api-client-react";

// The paragraph is assembled by fixed rules from closed trades (counted by
// close time) and journal tags — it is not written by an AI model, so it is
// not labelled as one.
//
// The server reads trades only from the source it names in performanceSource.
// Today that is the legacy simulated-trade record, which is closed to new rows
// and does not hold the user's paper, demo or live trades, so the basis line
// names that record instead of claiming "the trades you closed this week".
function summaryBasis(source: WeeklyReview["performanceSource"]): string {
  if (source === "LEGACY_TRADES_RECORD") {
    return (
      "Assembled by fixed rules from trades closed this week in the legacy simulated-trade record, plus your journal tags. " +
      "Your paper, demo and live trades are not in that record and are not reflected here."
    );
  }
  return "Assembled by fixed rules from a trade record and your journal tags. Which trades that record holds was not reported.";
}

export function AIWeeklySummaryCard({ r }: { r: WeeklyReview }) {
  return (
    <div className="space-y-2 rounded-xl border border-zinc-800 bg-zinc-950/50 p-3">
      <div className="text-xs uppercase tracking-wide text-zinc-500" data-testid="weekly-summary-title">Weekly summary</div>
      <p className="text-[11px] text-zinc-500" data-testid="weekly-summary-basis">
        {summaryBasis(r.performanceSource)}
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
