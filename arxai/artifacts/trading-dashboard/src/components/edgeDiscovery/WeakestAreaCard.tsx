import { STATUS_TONE, type EdgeReport } from "./types";

export function WeakestAreaCard({ report }: { report: EdgeReport }) {
  return (
    <div className={`rounded-lg border p-2.5 text-xs ${STATUS_TONE[report.status]}`}>
      <div className="mb-1 flex items-center justify-between">
        <h4 className="text-sm font-semibold">{report.edgeName}</h4>
        <span className="rounded bg-slate-800/70 px-1.5 py-0.5 text-[9px] font-bold uppercase tracking-wide">{report.status.replace("_"," ")}</span>
      </div>
      <p className="mb-1 text-[11px] leading-relaxed">{report.aiSummary}</p>
      <div className="flex gap-3 text-[10px] text-slate-300">
        <span>n={report.sampleSize}</span>
        <span>PF {report.profitFactor.toFixed(2)}</span>
        <span>exp {report.expectancy.toFixed(2)}</span>
      </div>
    </div>
  );
}
