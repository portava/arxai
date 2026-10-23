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
    <div className="rounded-lg border border-slate-700 bg-slate-900/40 p-4 space-y-3">
      <h3 className="text-sm font-semibold text-slate-100">Rule contract builder</h3>
      <p className="text-[11px] text-slate-400">Define your personal trading rules. Soft warnings, not hard locks.</p>
      <div className="grid grid-cols-1 gap-2 text-xs sm:grid-cols-2">
        <label className="space-y-1">
          <span className="text-slate-400">Contract name</span>
          <input value={name} onChange={(e)=>setName(e.target.value)} className="w-full rounded border border-slate-700 bg-slate-950 px-2 py-1 text-slate-100" />
        </label>
        <label className="space-y-1">
          <span className="text-slate-400">Max trades / day</span>
          <input type="number" value={maxTrades} onChange={(e)=>setMaxTrades(Number(e.target.value))} className="w-full rounded border border-slate-700 bg-slate-950 px-2 py-1 text-slate-100" />
        </label>
        <label className="space-y-1">
          <span className="text-slate-400">Max daily loss %</span>
          <input type="number" step="0.1" value={maxLoss} onChange={(e)=>setMaxLoss(Number(e.target.value))} className="w-full rounded border border-slate-700 bg-slate-950 px-2 py-1 text-slate-100" />
        </label>
        <label className="space-y-1">
          <span className="text-slate-400">Max risk / trade %</span>
          <input type="number" step="0.1" value={maxRisk} onChange={(e)=>setMaxRisk(Number(e.target.value))} className="w-full rounded border border-slate-700 bg-slate-950 px-2 py-1 text-slate-100" />
        </label>
        <label className="space-y-1">
          <span className="text-slate-400">Allowed sessions (CSV)</span>
          <input value={sessions} onChange={(e)=>setSessions(e.target.value)} placeholder="ASIA,LONDON,NEWYORK" className="w-full rounded border border-slate-700 bg-slate-950 px-2 py-1 text-slate-100" />
        </label>
        <label className="space-y-1">
          <span className="text-slate-400">Allowed symbols (CSV, blank = any)</span>
          <input value={symbols} onChange={(e)=>setSymbols(e.target.value)} placeholder="EURUSD,XAUUSD" className="w-full rounded border border-slate-700 bg-slate-950 px-2 py-1 text-slate-100" />
        </label>
        <label className="space-y-1">
          <span className="text-slate-400">Required min R:R</span>
          <input type="number" step="0.1" value={rrMin} onChange={(e)=>setRrMin(Number(e.target.value))} className="w-full rounded border border-slate-700 bg-slate-950 px-2 py-1 text-slate-100" />
        </label>
        <label className="space-y-1">
          <span className="text-slate-400">Cooldown after N losses</span>
          <input type="number" value={cooldown} onChange={(e)=>setCooldown(Number(e.target.value))} className="w-full rounded border border-slate-700 bg-slate-950 px-2 py-1 text-slate-100" />
        </label>
        <label className="space-y-1 sm:col-span-2">
          <span className="text-slate-400">No-trade conditions (CSV checklist)</span>
          <input value={noTrade} onChange={(e)=>setNoTrade(e.target.value)} className="w-full rounded border border-slate-700 bg-slate-950 px-2 py-1 text-slate-100" />
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
        className="rounded bg-emerald-600 px-3 py-1.5 text-xs font-semibold text-white hover:bg-emerald-500 disabled:opacity-50"
      >{saving ? "Saving…" : "Save & activate contract"}</button>
    </div>
  );
}
