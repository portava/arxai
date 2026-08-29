import { useQueryClient } from "@tanstack/react-query";
import {
  useGetLatestWeeklyReview, useGenerateWeeklyReview,
  getGetLatestWeeklyReviewQueryKey, getListWeeklyReviewsQueryKey,
} from "@workspace/api-client-react";
import { WeeklyPerformanceSummaryCard } from "./WeeklyPerformanceSummaryCard";
import { BestWorstTradeCards } from "./BestWorstTradeCards";
import { ScoreTrendCards } from "./ScoreTrendCards";
import { MistakeStrengthPatternCards } from "./MistakeStrengthPatternCards";
import { AIWeeklySummaryCard } from "./AIWeeklySummaryCard";
import { WeeklyGoalTracker } from "./WeeklyGoalTracker";

// Build J — top-level page panel composing every weekly-review card.
export function WeeklyReviewPanel() {
  const qc = useQueryClient();
  const { data, isLoading } = useGetLatestWeeklyReview({ query: { queryKey: getGetLatestWeeklyReviewQueryKey() } });
  const gen = useGenerateWeeklyReview({ mutation: {
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: getGetLatestWeeklyReviewQueryKey() });
      qc.invalidateQueries({ queryKey: getListWeeklyReviewsQueryKey() });
    },
  } });

  const review = data?.review;
  const goals = data?.goals ?? [];

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <h2 className="text-base font-semibold text-foreground">Weekly performance review</h2>
        <button type="button" disabled={gen.isPending}
          onClick={() => gen.mutate({ data: {} })}
          className="rounded-md border border-border bg-card px-3 py-1 text-xs text-foreground hover:bg-secondary disabled:opacity-50">
          {gen.isPending ? "Generating…" : "Generate / refresh this week"}
        </button>
      </div>

      {isLoading && <div className="text-xs text-txt-muted">Loading…</div>}
      {!isLoading && !review && (
        <div className="rounded-lg border border-border bg-background/50 p-6 text-center text-sm text-txt-secondary">
          No weekly review yet. Generate one to summarise this week.
        </div>
      )}
      {review && (
        <>
          <WeeklyPerformanceSummaryCard r={review} />
          <ScoreTrendCards r={review} />
          <BestWorstTradeCards r={review} />
          <MistakeStrengthPatternCards r={review} />
          <AIWeeklySummaryCard r={review} />
          <WeeklyGoalTracker goals={goals} />
        </>
      )}
    </div>
  );
}
