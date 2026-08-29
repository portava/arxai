import type { WeeklyReview } from "@workspace/api-client-react";

export function AIWeeklySummaryCard({ r }: { r: WeeklyReview }) {
  return (
    <div className="space-y-2 rounded-xl border border-border bg-background/50 p-3">
      <div className="text-xs uppercase tracking-wide text-txt-muted">AI weekly summary</div>
      <p className="text-sm text-foreground">{r.aiSummary ?? "No summary available."}</p>
      {r.nextWeekFocus && (
        <div className="rounded-md border border-warning/40 bg-warning/10 p-2 text-xs text-warning">
          <span className="font-semibold">Focus next week: </span>{r.nextWeekFocus}
        </div>
      )}
    </div>
  );
}
