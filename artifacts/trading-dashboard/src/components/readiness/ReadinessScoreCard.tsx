type Status = "READY"|"CAUTION"|"NOT_READY"|"LOCKED";
const grad: Record<Status, string> = {
  READY:     "from-emerald-600 to-emerald-400 text-emerald-50",
  CAUTION:   "from-amber-600 to-amber-400 text-amber-50",
  NOT_READY: "from-orange-700 to-orange-500 text-orange-50",
  LOCKED:    "from-red-800 to-red-600 text-red-50",
};
export function ReadinessScoreCard({ score, status }: { score: number; status: Status }) {
  return (
    <div className="rounded-lg border border-slate-700 bg-slate-900/40 p-4">
      <div className="flex items-center justify-between">
        <h3 className="text-sm font-semibold text-slate-100">Readiness score</h3>
        <span className="text-[10px] uppercase tracking-wide text-slate-500">advisory</span>
      </div>
      <div className={`mt-2 rounded-lg bg-gradient-to-br p-4 text-center ${grad[status]}`}>
        <div className="text-4xl font-bold">{score}</div>
        <div className="text-[11px] opacity-90">of 100 — {status}</div>
      </div>
    </div>
  );
}
