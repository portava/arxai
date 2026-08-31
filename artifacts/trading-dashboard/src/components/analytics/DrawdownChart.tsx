import { AreaChart, Area, XAxis, YAxis, CartesianGrid, Tooltip, ResponsiveContainer } from "recharts";
import type { EquityPoint } from "./types";

export function DrawdownChart({ points, maxDrawdown }: { points: EquityPoint[]; maxDrawdown: number }) {
  if (points.length === 0) return null;
  return (
    <div className="rounded-lg border border-danger/50 bg-danger/20 p-3">
      <div className="mb-2 flex items-baseline justify-between">
        <h3 className="text-sm font-semibold text-danger">Drawdown</h3>
        {/* Synthetic units ((exit − entry) × lots × 100), not account currency. */}
        <span className="text-[11px] text-danger">Peak-to-trough: {maxDrawdown.toFixed(2)} units</span>
      </div>
      <div className="h-44">
        <ResponsiveContainer width="100%" height="100%">
          <AreaChart data={points} margin={{ top: 5, right: 10, left: -10, bottom: 0 }}>
            <CartesianGrid stroke="#1e293b" strokeDasharray="3 3" />
            <XAxis dataKey="tradeId" stroke="#64748b" fontSize={10} />
            <YAxis stroke="#64748b" fontSize={10} />
            <Tooltip contentStyle={{ background: "#0f172a", border: "1px solid #334155", fontSize: 11 }} />
            <Area type="monotone" dataKey="drawdown" stroke="#ef4444" fill="#7f1d1d" fillOpacity={0.4} />
          </AreaChart>
        </ResponsiveContainer>
      </div>
    </div>
  );
}
