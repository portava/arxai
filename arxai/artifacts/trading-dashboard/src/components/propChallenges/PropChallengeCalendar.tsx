interface Day { tradeDate: string; dailyProfitLoss: number; tradesTaken: number; dailyLossPercent: number; rulesViolated?: string }
export function PropChallengeCalendar({ days }: { days: Day[] }) {
  return (
    <div className="rounded-lg border border-slate-700 bg-slate-900/40 p-4">
      <h3 className="mb-2 text-sm font-semibold text-slate-100">Challenge calendar ({days.length} days)</h3>
      {days.length === 0
        ? <p className="text-xs text-slate-500">No trading days recorded yet.</p>
        : <div className="grid grid-cols-3 gap-2 sm:grid-cols-5 lg:grid-cols-7">
            {days.map((d) => {
              const tone = d.dailyProfitLoss > 0 ? "border-emerald-700 bg-emerald-950/30"
                : d.dailyProfitLoss < 0 ? "border-red-700 bg-red-950/30"
                : "border-slate-700 bg-slate-950/30";
              return (
                <div key={d.tradeDate} className={`rounded border p-2 text-[10px] ${tone}`}>
                  <div className="font-mono text-slate-300">{d.tradeDate.slice(5)}</div>
                  <div className={`font-mono font-semibold ${d.dailyProfitLoss>=0?"text-emerald-300":"text-red-300"}`}>
                    {d.dailyProfitLoss>=0?"+":""}{d.dailyProfitLoss.toFixed(2)}
                  </div>
                  <div className="text-slate-500">{d.tradesTaken} trades</div>
                </div>
              );
            })}
          </div>}
    </div>
  );
}
