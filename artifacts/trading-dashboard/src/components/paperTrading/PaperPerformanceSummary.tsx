import { useQuery } from "@tanstack/react-query";

interface Hist { closedCount: number; wins: number; losses: number; winRate: number; netPnl: number; }

function Stat({ label, value, tone }: { label: string; value: string; tone?: "good"|"bad" }) {
  return (
    <div className="rounded-md border border-border bg-background/40 p-2">
      <div className="text-[10px] uppercase tracking-wide text-txt-muted">{label}</div>
      <div className={`text-sm font-semibold ${tone==="good"?"text-success":tone==="bad"?"text-danger":"text-foreground"}`}>{value}</div>
    </div>
  );
}

export function PaperPerformanceSummary({ accountId }: { accountId: number | null }) {
  const { data, isError } = useQuery<Hist>({
    queryKey: ["paper-history", accountId],
    queryFn: async () => {
      const r = await fetch(`/api/paper/history?accountId=${accountId}`);
      if (!r.ok) throw new Error("failed");
      return r.json();
    },
    enabled: accountId != null,
    refetchInterval: 6000,
  });
  // `?? 0` rendered a confident "Closed 0 / Win rate 0.0% / Net P&L 0.00"
  // while the history read was still in flight and permanently after it
  // failed — a failed read looked identical to a genuinely empty demo
  // account, and the 0.0% win rate wore the danger colour. An absent read
  // renders "—" with no tone; a failed one says so.
  const d = data ?? null;
  return (
    <div className="rounded-lg border border-border bg-muted/40 p-4">
      <h3 className="mb-2 text-sm font-semibold text-foreground">Demo performance</h3>
      <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
        <Stat label="Closed" value={d ? `${d.closedCount}` : "—"} />
        <Stat label="Wins" value={d ? `${d.wins}` : "—"} tone={d ? "good" : undefined} />
        <Stat label="Losses" value={d ? `${d.losses}` : "—"} tone={d ? "bad" : undefined} />
        <Stat label="Win rate" value={d ? `${(d.winRate*100).toFixed(1)}%` : "—"} tone={d ? (d.winRate>=0.5?"good":"bad") : undefined} />
        <Stat label="Net P&L" value={d ? d.netPnl.toFixed(2) : "—"} tone={d ? (d.netPnl>=0?"good":"bad") : undefined} />
      </div>
      {isError && d == null && (
        <p className="mt-2 text-[11px] text-danger">Demo performance unavailable — the history read failed. These are not zeros.</p>
      )}
      <p className="mt-2 rounded border border-warning/40 bg-warning/30 p-2 text-[11px] text-warning">
        ⚠ Simulated — demo trading does not guarantee live results. Practice scores never affect live trading stats.
      </p>
    </div>
  );
}
