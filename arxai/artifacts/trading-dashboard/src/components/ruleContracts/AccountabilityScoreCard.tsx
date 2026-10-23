export function AccountabilityScoreCard({ score, hardCount }: { score: number; hardCount: number }) {
  const tone = score >= 90 ? "from-emerald-600 to-emerald-400 text-emerald-100"
              : score >= 70 ? "from-amber-600 to-amber-400 text-amber-100"
              : "from-red-700 to-red-500 text-red-100";
  return (
    <div className="rounded-lg border border-slate-700 bg-slate-900/40 p-4">
      <div className="flex items-center justify-between">
        <h3 className="text-sm font-semibold text-slate-100">Accountability score</h3>
        <span className="text-[10px] uppercase tracking-wide text-slate-500">soft signal</span>
      </div>
      <div className={`mt-2 rounded-lg bg-gradient-to-br ${tone} p-4 text-center`}>
        <div className="text-4xl font-bold">{score}</div>
        <div className="text-[11px] opacity-80">of 100</div>
      </div>
      <p className="mt-2 text-[11px] text-slate-400">
        {hardCount > 0
          ? `${hardCount} hard rule violation${hardCount === 1 ? "" : "s"} today — review and reset.`
          : "Accountability is built rep by rep."}
      </p>
    </div>
  );
}
