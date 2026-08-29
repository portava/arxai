interface Day { tradeDate: string; dailyProfitLoss: number; tradesTaken: number; dailyLossPercent: number; rulesViolated?: string }
export function PropChallengeCalendar({ days }: { days: Day[] }) {
  return (
    <div className="rounded-lg border border-border bg-muted/40 p-4">
      <h3 className="mb-2 text-sm font-semibold text-foreground">Challenge calendar ({days.length} days)</h3>
      {days.length === 0
        ? <p className="text-xs text-txt-muted">No trading days recorded yet.</p>
        : <div className="grid grid-cols-3 gap-2 sm:grid-cols-5 lg:grid-cols-7">
            {days.map((d) => {
              const tone = d.dailyProfitLoss > 0 ? "border-success/40 bg-success/30"
                : d.dailyProfitLoss < 0 ? "border-danger/40 bg-danger/30"
                : "border-border bg-background/30";
              return (
                <div key={d.tradeDate} className={`rounded border p-2 text-[10px] ${tone}`}>
                  <div className="font-mono text-txt-secondary">{d.tradeDate.slice(5)}</div>
                  <div className={`font-mono font-semibold ${d.dailyProfitLoss>=0?"text-success":"text-danger"}`}>
                    {d.dailyProfitLoss>=0?"+":""}{d.dailyProfitLoss.toFixed(2)}
                  </div>
                  <div className="text-txt-muted">{d.tradesTaken} trades</div>
                </div>
              );
            })}
          </div>}
    </div>
  );
}
