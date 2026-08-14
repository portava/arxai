import { useGetLatestWeeklyReview, getGetLatestWeeklyReviewQueryKey } from "@workspace/api-client-react";

// Build J — small dashboard card. Shows current goal, focus, and the
// pre-trade warning (biggest mistake pattern). Compact, dashboard-friendly.
export function WeeklyFocusDashboardCard() {
  const { data } = useGetLatestWeeklyReview({ query: {
    queryKey: getGetLatestWeeklyReviewQueryKey(),
    refetchInterval: 60_000,
  } });
  const r = data?.review;
  const goals = data?.goals ?? [];
  const active = goals.find((g) => g.status === "ACTIVE");
  const completed = goals.filter((g) => g.status === "COMPLETED").length;
  const total = goals.length;

  if (!r) {
    return (
      <div className="rounded-xl border border-zinc-800 bg-zinc-950/50 p-3">
        <div className="text-xs uppercase tracking-wide text-zinc-500">Weekly focus</div>
        <div className="mt-1 text-xs text-zinc-400">Run a weekly review to see your focus here.</div>
      </div>
    );
  }
  return (
    <div className="space-y-2 rounded-xl border border-zinc-800 bg-zinc-950/50 p-3">
      <div className="flex items-center justify-between">
        <div className="text-xs uppercase tracking-wide text-zinc-500">Weekly focus</div>
        <div className="text-[10px] text-zinc-500">{completed}/{total} goals complete</div>
      </div>
      {active && <div className="text-sm font-medium text-zinc-100">{active.goalTitle}</div>}
      {r.nextWeekFocus && <div className="text-[11px] text-amber-200">{r.nextWeekFocus}</div>}
      {r.biggestMistakePattern && (
        <div className="text-[11px] text-rose-300">
          ⚠ Watch for: {humanize(r.biggestMistakePattern)}
        </div>
      )}
    </div>
  );
}
function humanize(t: string) {
  return t.toLowerCase().split("_").map((s) => s.charAt(0).toUpperCase() + s.slice(1)).join(" ");
}
