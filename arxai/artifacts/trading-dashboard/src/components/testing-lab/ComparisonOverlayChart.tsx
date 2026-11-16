// Diagnostic curves: keep each unit on its own scale. No cross-unit magnitude comparison.

import { LineChart, Line, XAxis, YAxis, CartesianGrid, Tooltip, Legend, ResponsiveContainer } from "recharts";

export interface OverlaySeries {
  key: string;
  label: string;
  unit: "$" | "R" | "price units";
  color: string;
  // Value is growth from the plotting origin, in the explicitly named unit.
  points: { tradeId: number; value: number }[];
}

const EMPTY_HINT = "Select at least one series to overlay.";

export function ComparisonOverlayChart({ series }: { series: OverlaySeries[] }) {
  const nonEmpty = series.filter((s) => s.points.length > 0);
  if (nonEmpty.length === 0) {
    return (
      <p className="rounded border border-dashed border-slate-700 p-6 text-center text-xs text-slate-500">
        {EMPTY_HINT}
      </p>
    );
  }

  const units = Array.from(new Set(nonEmpty.map((s) => s.unit)));
  if (units.length > 1) {
    return <div className="space-y-3">
      <p className="text-xs text-slate-400">Different units use separate charts; their magnitudes cannot be compared.</p>
      {units.map((unit) => <ComparisonOverlayChart key={unit} series={nonEmpty.filter((s) => s.unit === unit)} />)}
    </div>;
  }

  // Merge by tradeId into a single row set; each series writes its own keyed field.
  const maxLen = Math.max(...nonEmpty.map((s) => s.points.length));
  const rows: Record<string, number>[] = [];
  for (let i = 0; i < maxLen; i++) {
    const row: Record<string, number> = { tradeId: i };
    for (const s of nonEmpty) {
      const p = s.points[i];
      if (p) row[s.key] = p.value;
    }
    rows.push(row);
  }

  const yNote = `Growth from start (${units[0]})`;

  return (
    <div className="rounded-lg border border-slate-700 bg-slate-900/40 p-3">
      <h3 className="mb-1 text-sm font-semibold text-slate-200">Equity overlay</h3>
      <p className="mb-2 text-[10px] text-slate-500">{yNote}</p>
      <div className="h-64">
        <ResponsiveContainer width="100%" height="100%">
          <LineChart data={rows} margin={{ top: 5, right: 10, left: -10, bottom: 0 }}>
            <CartesianGrid stroke="#1e293b" strokeDasharray="3 3" />
            <XAxis dataKey="tradeId" stroke="#64748b" fontSize={10}
              label={{ value: "closed trade #", position: "insideBottom", offset: -2, fontSize: 9, fill: "#64748b" }} />
            <YAxis stroke="#64748b" fontSize={10} />
            <Tooltip contentStyle={{ background: "#0f172a", border: "1px solid #334155", fontSize: 11 }} />
            <Legend wrapperStyle={{ fontSize: 11 }} />
            {nonEmpty.map((s) => (
              <Line key={s.key} type="linear" dataKey={s.key} name={`${s.label} (${s.unit})`}
                stroke={s.color} strokeWidth={2} dot={false} />
            ))}
          </LineChart>
        </ResponsiveContainer>
      </div>
    </div>
  );
}
