import type { EdgeReport } from "./types";

const TONE: Record<string, string> = {
  STRONG_EDGE: "text-emerald-300", DEVELOPING_EDGE: "text-sky-300",
  WEAK_EDGE: "text-amber-300", NO_EDGE: "text-red-300",
  INSUFFICIENT_DATA: "text-slate-400",
};

export function EdgeBreakdownTable({ reports, onSelect }:
  { reports: EdgeReport[]; onSelect?: (r: EdgeReport) => void }) {
  if (reports.length === 0) {
    return <p className="rounded border border-dashed border-slate-700 p-6 text-center text-xs text-slate-500">No reports yet — generate one above.</p>;
  }
  return (
    <div className="overflow-x-auto rounded-lg border border-slate-700">
      <table className="w-full text-left text-xs">
        <thead className="bg-slate-900/60 text-[10px] uppercase tracking-wide text-slate-400">
          <tr>
            <th className="px-2 py-1.5">Slice</th>
            <th className="px-2 py-1.5">Status</th>
            <th className="px-2 py-1.5 text-right">n</th>
            <th className="px-2 py-1.5 text-right">WR</th>
            <th className="px-2 py-1.5 text-right">PF</th>
            <th className="px-2 py-1.5 text-right">Exp</th>
            <th className="px-2 py-1.5 text-right">Conf</th>
          </tr>
        </thead>
        <tbody>
          {reports.map((r) => (
            <tr key={r.id} className="cursor-pointer border-t border-slate-800 hover:bg-slate-900/40" onClick={() => onSelect?.(r)}>
              <td className="px-2 py-1.5 text-slate-100">{r.edgeName}</td>
              <td className={`px-2 py-1.5 font-bold ${TONE[r.status] ?? ""}`}>{r.status.replace("_"," ")}</td>
              <td className="px-2 py-1.5 text-right font-mono">{r.sampleSize}</td>
              <td className="px-2 py-1.5 text-right font-mono">{(r.winRate*100).toFixed(0)}%</td>
              <td className="px-2 py-1.5 text-right font-mono">{r.profitFactor.toFixed(2)}</td>
              <td className="px-2 py-1.5 text-right font-mono">{r.expectancy.toFixed(2)}</td>
              <td className="px-2 py-1.5 text-right font-mono">{Math.round(r.confidenceScore)}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
