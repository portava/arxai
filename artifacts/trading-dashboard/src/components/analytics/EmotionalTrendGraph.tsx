import { LineChart, Line, XAxis, YAxis, CartesianGrid, Tooltip, ResponsiveContainer } from "recharts";

interface TrendPoint { idx: number; isCalm: number; followedPlan: number }

export function EmotionalTrendGraph({ trend }: { trend: TrendPoint[] }) {
  if (trend.length === 0) return <p className="rounded border border-dashed border-slate-700 p-3 text-center text-[11px] text-slate-500">No emotional data yet.</p>;
  return (
    <div className="rounded-lg border border-slate-700 bg-slate-900/40 p-3">
      <h3 className="mb-2 text-sm font-semibold text-slate-200">Emotional & Discipline Trend</h3>
      <div className="h-44">
        <ResponsiveContainer width="100%" height="100%">
          <LineChart data={trend} margin={{ top: 5, right: 10, left: -20, bottom: 0 }}>
            <CartesianGrid stroke="#1e293b" strokeDasharray="3 3" />
            <XAxis dataKey="idx" stroke="#64748b" fontSize={10} />
            <YAxis stroke="#64748b" fontSize={10} domain={[0, 1]} ticks={[0, 1]} />
            <Tooltip contentStyle={{ background: "#0f172a", border: "1px solid #334155", fontSize: 11 }} />
            <Line type="monotone" dataKey="isCalm"       name="Calm"       stroke="#38bdf8" strokeWidth={1.5} dot={false} />
            <Line type="monotone" dataKey="followedPlan" name="Plan kept"  stroke="#10b981" strokeWidth={1.5} dot={false} />
          </LineChart>
        </ResponsiveContainer>
      </div>
      <div className="mt-1 flex gap-3 text-[10px] text-slate-400">
        <span>● Calm post-trade</span><span className="text-emerald-400">● Followed plan</span>
      </div>
    </div>
  );
}
