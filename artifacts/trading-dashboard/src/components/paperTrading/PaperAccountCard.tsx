import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";

/** How the server valued the account (lib/tradeEngine/paperVenue.ts describePaperValuation). Older servers omit it. */
interface PaperValuation {
  priceSource: "SIMULATOR" | "MARKET_QUOTE" | "MIXED" | "NO_OPEN_ORDERS";
  openOrders: number; openPricedBySimulator: number; closedSimulatorPriced: number; closedMonitorSizedUsd?: number;
  units: "SIMULATOR_UNITS"; pnlMultiplier: number; marginPerLot: number; note: string;
}
interface PaperAccount {
  id: number; accountName: string;
  startingBalance: number; currentBalance: number; equity: number; marginUsed: number;
  isActive: number; createdAt: string;
  valuation?: PaperValuation;
}

/**
 * Always true of this sandbox, whatever the server sends: P&L is price move ×
 * lots × 100 for every symbol and margin is lots × 1,000 (paperVenue.ts).
 */
const UNITS_NOTE = "Figures are simulator units, not money: P&L is price move × lots × 100 for every symbol (a 1-lot, 50-pip EURUSD move counts 0.50), not the instrument's contract size or an account currency. Margin is lots × 1,000, not a broker margin.";

/** Plain-English line for where the account's prices came from. */
export function paperPriceSourceLine(v: PaperValuation | undefined): string {
  if (!v) return "Price source not reported by the server. Orders opened without a market quote are valued at the simulator's synthetic price, not a market quote.";
  const open = v.priceSource === "SIMULATOR"
    ? "Prices: simulator (synthetic, generated — not a market quote). Stops and targets are settled against it."
    : v.priceSource === "MIXED"
    ? `Prices: ${v.openPricedBySimulator} of ${v.openOrders} open orders at the simulator's synthetic price (not a market quote), the rest at a market quote.`
    : v.priceSource === "MARKET_QUOTE"
    ? "Prices: open orders valued at a current market quote."
    : "No open orders.";
  const closed = v.closedSimulatorPriced > 0
    ? ` ${v.closedSimulatorPriced} closed order${v.closedSimulatorPriced === 1 ? " was" : "s were"} priced by the simulator, so the balance includes synthetic results.`
    : "";
  return open + closed;
}

/** The units line; names the exits sized in USD when the balance mixes the two scales. */
export function paperUnitsLine(v: PaperValuation | undefined): string {
  const n = v?.closedMonitorSizedUsd ?? 0;
  return n > 0
    ? `${UNITS_NOTE} ${n} stop/target exit${n === 1 ? " was" : "s were"} sized in USD by the paper execution monitor instead, so the balance mixes the two scales.`
    : UNITS_NOTE;
}

export function PaperAccountCard({ onActive }: { onActive?: (id: number) => void }) {
  const qc = useQueryClient();
  const [name, setName] = useState("Practice");
  const [bal, setBal] = useState(10000);
  const { data, isLoading, isError, error } = useQuery<{ account: PaperAccount }>({
    queryKey: ["paper-active"],
    queryFn: async () => {
      const r = await fetch("/api/paper/accounts/active");
      if (r.status === 404) return { account: null as unknown as PaperAccount };
      if (!r.ok) {
        const j = await r.json().catch(() => null) as { error?: unknown } | null;
        throw new Error(typeof j?.error === "string" && j.error ? j.error : `HTTP ${r.status}`);
      }
      const j = await r.json();
      onActive?.(j.account?.id);
      return j;
    },
    refetchInterval: 5000,
  });
  const create = useMutation({
    mutationFn: async () => {
      const r = await fetch("/api/paper/accounts", {
        method: "POST", headers: { "content-type": "application/json" },
        body: JSON.stringify({ accountName: name, startingBalance: bal }),
      });
      if (!r.ok) throw new Error("failed");
      return r.json();
    },
    onSuccess: () => qc.invalidateQueries({ queryKey: ["paper-active"] }),
  });
  const acc = data?.account;
  return (
    <div className="rounded-lg border border-amber-700 bg-amber-950/20 p-4">
      <header className="mb-2 flex items-center justify-between">
        <h3 className="text-sm font-semibold text-slate-100">Demo account</h3>
        <span className="rounded bg-amber-700 px-2 py-0.5 text-[10px] font-bold text-white">SIMULATED</span>
      </header>
      {isError ? (
        <p className="text-xs text-amber-300" data-testid="paper-account-unavailable">
          Demo account could not be loaded{error instanceof Error && error.message ? `: ${error.message}` : ""}. Balance, equity and margin are not shown.
        </p>
      ) : isLoading ? (
        <p className="text-xs text-slate-400">Loading demo account…</p>
      ) : acc ? (
        <div className="space-y-2">
          <p className="text-xs text-slate-300">{acc.accountName}</p>
          <div className="grid grid-cols-2 gap-2 text-xs">
            <div><span className="text-slate-500">Balance</span><div className="font-mono text-slate-100">{acc.currentBalance.toFixed(2)}</div></div>
            <div><span className="text-slate-500">Equity</span><div className="font-mono text-slate-100">{acc.equity.toFixed(2)}</div></div>
            <div><span className="text-slate-500">Margin</span><div className="font-mono text-slate-100">{acc.marginUsed.toFixed(2)}</div></div>
            <div><span className="text-slate-500">P&L vs start</span>
              <div className={`font-mono ${acc.equity - acc.startingBalance >= 0 ? "text-green-400" : "text-red-400"}`}>
                {(acc.equity - acc.startingBalance).toFixed(2)}
              </div>
            </div>
          </div>
          <p className="text-[10px] text-amber-300" data-testid="paper-account-price-source">{paperPriceSourceLine(acc.valuation)}</p>
          <p className="text-[10px] text-slate-400" data-testid="paper-account-units">{paperUnitsLine(acc.valuation)}</p>
        </div>
      ) : (
        <div className="space-y-2">
          <p className="text-xs text-slate-400">No active account.</p>
          <input value={name} onChange={(e) => setName(e.target.value)} placeholder="Name"
            className="w-full rounded border border-slate-700 bg-slate-950 px-2 py-1 text-xs text-slate-100" />
          <input type="number" value={bal} onChange={(e) => setBal(Number(e.target.value))}
            className="w-full rounded border border-slate-700 bg-slate-950 px-2 py-1 text-xs text-slate-100" />
          <button onClick={() => create.mutate()} disabled={create.isPending}
            className="w-full rounded bg-amber-600 px-3 py-1.5 text-xs font-semibold text-white hover:bg-amber-500 disabled:opacity-50">
            {create.isPending ? "Creating…" : "Create demo account"}
          </button>
        </div>
      )}
      <p className="mt-2 text-[10px] text-amber-300">Simulated — demo trading does not guarantee live results.</p>
    </div>
  );
}
