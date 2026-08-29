import type { EdgeReport } from "./types";

export function AiEdgeSummaryCard({ report }: { report: EdgeReport }) {
  return (
    <div className="rounded-lg border border-premium/40 bg-premium/20 p-3">
      <div className="mb-1 flex items-center justify-between">
        <h4 className="text-sm font-semibold text-premium">AI edge summary</h4>
        <span className="text-[10px] uppercase tracking-wide text-premium/80">historical, not predictive</span>
      </div>
      <p className="text-xs leading-relaxed text-foreground">{report.aiSummary}</p>
      <dl className="mt-2 grid grid-cols-3 gap-1 text-[10px] text-txt-secondary">
        <div><dt className="text-txt-muted">Discipline</dt><dd className="font-mono">{Math.round(report.disciplineScoreAvg)}</dd></div>
        <div><dt className="text-txt-muted">Execution</dt><dd className="font-mono">{Math.round(report.executionScoreAvg)}</dd></div>
        <div><dt className="text-txt-muted">Emotional</dt><dd className="font-mono">{Math.round(report.emotionalScoreAvg)}</dd></div>
      </dl>
    </div>
  );
}
