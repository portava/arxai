import { useState } from "react";

interface Props {
  initial?: Partial<{
    contractName: string; maxTradesPerDay: number; maxDailyLossPercent: number;
    maxRiskPerTradePercent: number; allowedSessions: string; allowedSymbols: string;
    requiredRrMinimum: number; cooldownAfterLosses: number; noTradeConditions: string;
  }>;
  onSubmit: (body: Record<string, unknown>) => void;
  saving?: boolean;
}

export function RuleContractBuilder({ initial, onSubmit, saving }: Props) {
  const [name, setName] = useState(initial?.contractName ?? "My Rules");
  const [maxTrades, setMaxTrades] = useState(initial?.maxTradesPerDay ?? 3);
  const [maxLoss, setMaxLoss] = useState((initial?.maxDailyLossPercent ?? 0.03) * 100);
  const [maxRisk, setMaxRisk] = useState((initial?.maxRiskPerTradePercent ?? 0.01) * 100);
  const [sessions, setSessions] = useState(initial?.allowedSessions ?? "LONDON,NEWYORK");
  const [symbols, setSymbols] = useState(initial?.allowedSymbols ?? "");
  const [rrMin, setRrMin] = useState(initial?.requiredRrMinimum ?? 2);
  const [cooldown, setCooldown] = useState(initial?.cooldownAfterLosses ?? 2);
  const [noTrade, setNoTrade] = useState(initial?.noTradeConditions ?? "high-impact news,after risk lock");

  return (
    <div className="rounded-lg border border-border bg-muted/40 p-4 space-y-3">
      <h3 className="text-sm font-semibold text-foreground">Rule contract builder</h3>
      <p className="text-[11px] text-txt-secondary">Define your personal trading rules. Soft warnings, not hard locks.</p>
      <div className="grid grid-cols-1 gap-2 text-xs sm:grid-cols-2">
        <label className="space-y-1">
          <span className="text-txt-secondary">Contract name</span>
          <input value={name} onChange={(e)=>setName(e.target.value)} className="w-full rounded border border-border bg-background px-2 py-1 text-foreground" />
        </label>
        <label className="space-y-1">
          <span className="text-txt-secondary">Max trades / day</span>
          <input type="number" value={maxTrades} onChange={(e)=>setMaxTrades(Number(e.target.value))} className="w-full rounded border border-border bg-background px-2 py-1 text-foreground" />
        </label>
        <label className="space-y-1">
          <span className="text-txt-secondary">Max daily loss %</span>
          <input type="number" step="0.1" value={maxLoss} onChange={(e)=>setMaxLoss(Number(e.target.value))} className="w-full rounded border border-border bg-background px-2 py-1 text-foreground" />
        </label>
        <label className="space-y-1">
          <span className="text-txt-secondary">Max risk / trade %</span>
          <input type="number" step="0.1" value={maxRisk} onChange={(e)=>setMaxRisk(Number(e.target.value))} className="w-full rounded border border-border bg-background px-2 py-1 text-foreground" />
        </label>
        <label className="space-y-1">
          <span className="text-txt-secondary">Allowed sessions (CSV)</span>
          <input value={sessions} onChange={(e)=>setSessions(e.target.value)} placeholder="ASIA,LONDON,NEWYORK" className="w-full rounded border border-border bg-background px-2 py-1 text-foreground" />
        </label>
        <label className="space-y-1">
          <span className="text-txt-secondary">Allowed symbols (CSV, blank = any)</span>
          <input value={symbols} onChange={(e)=>setSymbols(e.target.value)} placeholder="EURUSD,XAUUSD" className="w-full rounded border border-border bg-background px-2 py-1 text-foreground" />
        </label>
        <label className="space-y-1">
          <span className="text-txt-secondary">Required min R:R</span>
          <input type="number" step="0.1" value={rrMin} onChange={(e)=>setRrMin(Number(e.target.value))} className="w-full rounded border border-border bg-background px-2 py-1 text-foreground" />
        </label>
        <label className="space-y-1">
          <span className="text-txt-secondary">Cooldown after N losses</span>
          <input type="number" value={cooldown} onChange={(e)=>setCooldown(Number(e.target.value))} className="w-full rounded border border-border bg-background px-2 py-1 text-foreground" />
        </label>
        <label className="space-y-1 sm:col-span-2">
          <span className="text-txt-secondary">No-trade conditions (CSV checklist)</span>
          <input value={noTrade} onChange={(e)=>setNoTrade(e.target.value)} className="w-full rounded border border-border bg-background px-2 py-1 text-foreground" />
        </label>
      </div>
      <button
        onClick={() => onSubmit({
          contractName: name,
          maxTradesPerDay: maxTrades,
          maxDailyLossPercent: maxLoss / 100,
          maxRiskPerTradePercent: maxRisk / 100,
          allowedSessions: sessions,
          allowedSymbols: symbols,
          requiredRrMinimum: rrMin,
          cooldownAfterLosses: cooldown,
          noTradeConditions: noTrade,
          isActive: true,
        })}
        disabled={saving}
        className="rounded bg-success px-3 py-1.5 text-xs font-semibold text-white hover:bg-success disabled:opacity-50"
      >{saving ? "Saving…" : "Save & activate contract"}</button>
    </div>
  );
}
