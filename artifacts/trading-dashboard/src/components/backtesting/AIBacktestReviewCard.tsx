// (P) Diagnostic summary card for a backtest run.
//
// The paragraph is backtestDiagnosticSummary(run), a deterministic template
// computed from the run's recorded metrics. No AI model is consulted, and the
// server's POST /ai-review only rewrites a stored aiSummary that the read
// projection discards, so a "refresh" could never change what is shown here.
// The card is therefore labelled as a diagnostic summary and offers no
// refresh. (Export name kept for existing imports.)

import { useQuery } from "@tanstack/react-query";
import { backtestDiagnosticSummary, type BacktestSummaryInput } from "@workspace/domain/backtest";

export function AIBacktestReviewCard({ runId }: { runId: number | null }) {
  const { data, isLoading, isError } = useQuery<BacktestSummaryInput>({
    queryKey: ["backtest-run", runId],
    queryFn: async () => {
      const r = await fetch(`/api/backtest-runs/${runId}`);
      if (!r.ok) throw new Error("failed");
      return r.json();
    },
    enabled: runId != null,
  });
  if (!runId) return null;
  return (
    <div className="space-y-2 rounded-lg border border-slate-700 bg-slate-900/40 p-4">
      <header>
        <h3 className="text-sm font-semibold text-slate-100">Diagnostic summary</h3>
        <p className="text-[10px] text-slate-500">Generated from this run's recorded metrics by a fixed template; no AI model is consulted.</p>
      </header>
      <p className="rounded border border-slate-800 bg-slate-950/40 p-3 text-xs text-slate-300">
        {isLoading ? "Loading diagnostic summary…" : isError || !data ? "Diagnostic summary unavailable." : backtestDiagnosticSummary(data)}
      </p>
      <p className="text-[10px] text-slate-500">Past performance does not guarantee future results.</p>
    </div>
  );
}
