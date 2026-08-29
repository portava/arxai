// Testing Lab — comparison overlay chart (Task #763). DISPLAY-ONLY.
//
// Overlays two (or more) equity curves on one chart, each as its own line with
// an explicit legend label that names its source AND its native unit. Backtest
// equity is account currency ($), forward equity is realised R — these are NOT
// silently merged: every line carries its unit in the legend and the Y-axis note
// states both, so the reader compares trajectory/shape, never a fabricated
// common magnitude. X-axis is the closed-trade sequence (each series rebased so
// trade #1 is its first outcome) because the two tests span different clocks.

import { LineChart, Line, XAxis, YAxis, CartesianGrid, Tooltip, Legend, ResponsiveContainer } from "recharts";

export interface OverlaySeries {
  key: string;
  label: string;
  unit: "$" | "R";
  color: string;
  // value = growth-from-start: backtest $ delta from initial, forward cumulative R.
  points: { tradeId: number; value: number }[];
}

const EMPTY_HINT = "Select at least one series to overlay.";

export function ComparisonOverlayChart({ series }: { series: OverlaySeries[] }) {
  const nonEmpty = series.filter((s) => s.points.length > 0);
  if (nonEmpty.length === 0) {
    return (
      <p className="rounded border border-dashed border-border p-6 text-center text-xs text-txt-muted">
        {EMPTY_HINT}
      </p>
    );
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

  const units = Array.from(new Set(nonEmpty.map((s) => s.unit)));
  const yNote = units.length > 1
    ? "Growth from start — units differ per curve (see legend); compare trajectory, not magnitude."
    : units[0] === "$" ? "Growth from start ($)" : "Growth from start (R)";

  return (
    <div className="rounded-lg border border-border bg-muted/40 p-3">
      <h3 className="mb-1 text-sm font-semibold text-foreground">Equity overlay</h3>
      <p className="mb-2 text-[10px] text-txt-muted">{yNote}</p>
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
              <Line key={s.key} type="monotone" dataKey={s.key} name={`${s.label} (${s.unit})`}
                stroke={s.color} strokeWidth={2} dot={false} connectNulls />
            ))}
          </LineChart>
        </ResponsiveContainer>
      </div>
    </div>
  );
}
