import { LineChart, Line, XAxis, YAxis, CartesianGrid, Tooltip, ResponsiveContainer } from "recharts";
import type { EquityPoint } from "./types";

export function EquityCurveChart({ points }: { points: EquityPoint[] }) {
  if (points.length === 0) {
    return <p className="rounded border border-dashed border-border p-6 text-center text-xs text-txt-muted">No closed trades yet.</p>;
  }
  return (
    <div className="rounded-lg border border-border bg-muted/40 p-3">
      <h3 className="mb-2 text-sm font-semibold text-foreground">Equity Curve</h3>
      <div className="h-56">
        <ResponsiveContainer width="100%" height="100%">
          <LineChart data={points} margin={{ top: 5, right: 10, left: -10, bottom: 0 }}>
            <CartesianGrid stroke="#1e293b" strokeDasharray="3 3" />
            <XAxis dataKey="tradeId" stroke="#64748b" fontSize={10} />
            <YAxis stroke="#64748b" fontSize={10} />
            <Tooltip contentStyle={{ background: "#0f172a", border: "1px solid #334155", fontSize: 11 }} />
            <Line type="monotone" dataKey="equity" stroke="#10b981" strokeWidth={2} dot={false} />
            <Line type="monotone" dataKey="peak"   stroke="#64748b" strokeWidth={1} dot={false} strokeDasharray="3 3" />
          </LineChart>
        </ResponsiveContainer>
      </div>
    </div>
  );
}
