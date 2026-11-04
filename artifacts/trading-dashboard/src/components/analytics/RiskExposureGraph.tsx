import type { AnalyticsFigures } from "./types";

export function RiskExposureGraph({ snapshot }: { snapshot: AnalyticsFigures }) {
  // null = not measured: "—" and no bar (a 0-width bar read as a measured 0).
  const pf = snapshot.profitFactor, rr = snapshot.averageRr, wr = snapshot.winRate, dd = snapshot.maxDrawdown;
  const items: Array<{ label: string; value: number | null; max: number; tone: string; suffix: string }> = [
    { label: "Profit factor", value: pf == null ? null : Math.min(pf, 3), max: 3, tone: "bg-emerald-500", suffix: pf == null ? "—" : pf.toFixed(2) },
    { label: "Avg R-multiple", value: rr == null ? null : Math.max(0, Math.min(rr, 3)), max: 3, tone: "bg-sky-500", suffix: rr == null ? "—" : rr.toFixed(2) + "R" },
    { label: "Win rate",       value: wr == null ? null : wr * 100, max: 100, tone: "bg-violet-500", suffix: wr == null ? "—" : (wr * 100).toFixed(1) + "%" },
    { label: "Max drawdown $", value: dd == null ? null : Math.min(dd, 1000), max: 1000, tone: "bg-red-500", suffix: dd == null ? "—" : "$" + dd.toFixed(0) },
  ];
  return (
    <div className="rounded-lg border border-slate-700 bg-slate-900/40 p-3">
      <h3 className="mb-2 text-sm font-semibold text-slate-200">Risk Exposure</h3>
      <ul className="space-y-1.5">
        {items.map((it) => (
          <li key={it.label} data-testid={`risk-exposure-${it.label}`}>
            <div className="mb-0.5 flex items-baseline justify-between text-[11px]">
              <span className="text-slate-300">{it.label}</span>
              <span className="font-semibold text-slate-100">{it.suffix}</span>
            </div>
            <div className="h-1.5 overflow-hidden rounded bg-slate-800">
              {it.value == null ? null : <div className={`h-full ${it.tone}`} style={{ width: `${Math.min(100, (it.value / it.max) * 100)}%` }} />}
            </div>
          </li>
        ))}
      </ul>
    </div>
  );
}
