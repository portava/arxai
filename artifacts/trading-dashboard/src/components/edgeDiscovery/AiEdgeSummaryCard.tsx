import type { EdgeReport } from "./types";

export function AiEdgeSummaryCard({ report }: { report: EdgeReport }) {
  return (
    <div className="rounded-lg border border-violet-700 bg-violet-950/20 p-3">
      <div className="mb-1 flex items-center justify-between">
        <h4 className="text-sm font-semibold text-violet-200">AI edge summary</h4>
        <span className="text-[10px] uppercase tracking-wide text-violet-400/80">historical, not predictive</span>
      </div>
      <p className="text-xs leading-relaxed text-slate-100">{report.aiSummary}</p>
      <dl className="mt-2 grid grid-cols-3 gap-1 text-[10px] text-slate-300">
        <div><dt className="text-slate-500">Discipline</dt><dd className="font-mono">{Math.round(report.disciplineScoreAvg)}</dd></div>
        <div><dt className="text-slate-500">Execution</dt><dd className="font-mono">{Math.round(report.executionScoreAvg)}</dd></div>
        <div><dt className="text-slate-500">Emotional</dt><dd className="font-mono">{Math.round(report.emotionalScoreAvg)}</dd></div>
      </dl>
    </div>
  );
}
