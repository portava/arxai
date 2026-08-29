// (P) AI review card for a backtest run. Refresh button regenerates summary.

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";

export function AIBacktestReviewCard({ runId }: { runId: number | null }) {
  const qc = useQueryClient();
  const { data } = useQuery<{ aiSummary: string | null; isVerified?: string; status?: string }>({
    queryKey: ["backtest-run", runId],
    queryFn: async () => {
      const r = await fetch(`/api/backtest-runs/${runId}`);
      if (!r.ok) throw new Error("failed");
      return r.json();
    },
    enabled: runId != null,
  });
  const review = useMutation({
    mutationFn: async () => {
      const r = await fetch(`/api/backtest-runs/${runId}/ai-review`, { method: "POST" });
      if (!r.ok) throw new Error("failed");
      return r.json();
    },
    onSuccess: () => qc.invalidateQueries({ queryKey: ["backtest-run", runId] }),
  });
  if (!runId) return null;
  return (
    <div className="space-y-2 rounded-lg border border-border bg-muted/40 p-4">
      <header className="flex items-center justify-between">
        <h3 className="text-sm font-semibold text-foreground">AI review</h3>
        <button onClick={() => review.mutate()} disabled={review.isPending}
          className="rounded bg-primary px-2 py-1 text-[11px] font-semibold text-white hover:bg-primary disabled:opacity-50">
          {review.isPending ? "Reviewing…" : "Refresh review"}
        </button>
      </header>
      <p className="rounded border border-border bg-background/40 p-3 text-xs text-txt-secondary">
        {data?.aiSummary ?? "No review yet — click \"Refresh review\"."}
      </p>
      <p className="text-[10px] text-txt-muted">Past performance does not guarantee future results.</p>
    </div>
  );
}
