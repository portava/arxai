import { EdgeConfidenceMeter } from "./EdgeConfidenceMeter";
import { STATUS_TONE, type EdgeReport } from "./types";

export function StrongestEdgeCard({ report }: { report: EdgeReport }) {
  return (
    <div className={`rounded-lg border p-3 ${STATUS_TONE[report.status]}`}>
      <div className="mb-1 flex items-center justify-between">
        <h3 className="text-sm font-semibold">{report.edgeName}</h3>
        <span className="rounded bg-muted/70 px-1.5 py-0.5 text-[9px] font-bold uppercase tracking-wide">{report.status.replace("_"," ")}</span>
      </div>
      <p className="mb-2 text-[11px] leading-relaxed">{report.aiSummary}</p>
      <dl className="mb-2 grid grid-cols-3 gap-1 text-[10px]">
        <div><dt className="text-txt-secondary">Win rate</dt><dd className="font-mono">{(report.winRate * 100).toFixed(0)}%</dd></div>
        <div><dt className="text-txt-secondary">Profit factor</dt><dd className="font-mono">{report.profitFactor.toFixed(2)}</dd></div>
        <div><dt className="text-txt-secondary">Expectancy</dt><dd className="font-mono">{report.expectancy.toFixed(2)}</dd></div>
      </dl>
      <EdgeConfidenceMeter score={report.confidenceScore} sampleSize={report.sampleSize} />
    </div>
  );
}
