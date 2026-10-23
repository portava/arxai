// (P) Backtest form — pick strategy + symbol + candle count, run a backtest.

import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { SYMBOL_REGISTRY } from "@/lib/symbolRegistry";
import { TESTING_STRATEGIES } from "@/lib/testingStrategies";

const STRATEGIES = TESTING_STRATEGIES;
// Focus-Lock (Task #570): the symbol picker is derived ENTIRELY from the
// approved ARX Focus registry, so only an approved market can ever be
// backtested. The value is the canonical routing key; the label is the
// display name.
const SYMBOLS = SYMBOL_REGISTRY.map((e) => ({
  value: e.canonicalSymbol,
  label: e.displayName,
}));

export function StrategyBacktestForm({
  onCreated,
  strategyId: controlledStrategy,
  onStrategyChange,
}: {
  onCreated?: (runId: number) => void;
  strategyId?: string;
  onStrategyChange?: (s: string) => void;
}) {
  const qc = useQueryClient();
  const [internalStrategy, setInternalStrategy] = useState<string>(STRATEGIES[0]);
  const strategyId = controlledStrategy ?? internalStrategy;
  const setStrategyId = (s: string) => {
    onStrategyChange?.(s);
    if (controlledStrategy === undefined) setInternalStrategy(s);
  };
  const [symbol, setSymbol] = useState(SYMBOLS[0]?.value ?? "");
  const [timeframe, setTimeframe] = useState("M1");
  const [candleCount, setCandleCount] = useState(500);
  const [initialBalance, setInitialBalance] = useState(10000);
  const [minConfidence, setMinConfidence] = useState(60);
  // Task #797 — optional REAL-history window. When both dates are set the run
  // uses real broker candles inside the range ONLY (honest INSUFFICIENT_DATA
  // if the history is too thin — never a synthetic fallback).
  const [startDate, setStartDate] = useState("");
  const [endDate, setEndDate] = useState("");
  const rangeIncomplete = (startDate !== "") !== (endDate !== "");
  const rangeInverted = startDate !== "" && endDate !== "" && startDate >= endDate;

  const create = useMutation({
    mutationFn: async () => {
      const range = startDate && endDate
        ? {
            startTime: new Date(`${startDate}T00:00:00Z`).toISOString(),
            endTime: new Date(`${endDate}T23:59:59Z`).toISOString(),
          }
        : {};
      const r = await fetch("/api/backtest-runs", {
        method: "POST", headers: { "content-type": "application/json" },
        body: JSON.stringify({ strategyId, symbol, timeframe, candleCount, initialBalance, minConfidence, ...range }),
      });
      if (!r.ok) throw new Error("backtest failed");
      return r.json();
    },
    onSuccess: (data: { id: number }) => {
      qc.invalidateQueries({ queryKey: ["backtest-runs"] });
      onCreated?.(data.id);
    },
  });

  return (
    <div className="space-y-3 rounded-lg border border-slate-700 bg-slate-900/40 p-4">
      <h3 className="text-sm font-semibold text-slate-100">Run a backtest</h3>
      <div className="grid grid-cols-2 gap-3 text-xs">
        <label className="space-y-1">
          <span className="text-slate-400">Strategy</span>
          <select value={strategyId} onChange={(e) => setStrategyId(e.target.value)}
            className="w-full rounded border border-slate-700 bg-slate-950 px-2 py-1 text-slate-100">
            {STRATEGIES.map((s) => <option key={s} value={s}>{s}</option>)}
          </select>
        </label>
        <label className="space-y-1">
          <span className="text-slate-400">Symbol</span>
          <select value={symbol} onChange={(e) => setSymbol(e.target.value)}
            className="w-full rounded border border-slate-700 bg-slate-950 px-2 py-1 text-slate-100">
            {SYMBOLS.map((s) => <option key={s.value} value={s.value}>{s.label}</option>)}
          </select>
        </label>
        <label className="space-y-1">
          <span className="text-slate-400">Timeframe</span>
          <select value={timeframe} onChange={(e) => setTimeframe(e.target.value)}
            className="w-full rounded border border-slate-700 bg-slate-950 px-2 py-1 text-slate-100">
            {["M1","M5","M15","H1","H4","D1"].map((t) => <option key={t} value={t}>{t}</option>)}
          </select>
        </label>
        <label className="space-y-1">
          <span className="text-slate-400">Candles</span>
          <input type="number" min={50} max={5000} value={candleCount} onChange={(e) => setCandleCount(Number(e.target.value))}
            className="w-full rounded border border-slate-700 bg-slate-950 px-2 py-1 text-slate-100" />
        </label>
        <label className="space-y-1">
          <span className="text-slate-400">Initial balance</span>
          <input type="number" min={100} value={initialBalance} onChange={(e) => setInitialBalance(Number(e.target.value))}
            className="w-full rounded border border-slate-700 bg-slate-950 px-2 py-1 text-slate-100" />
        </label>
        <label className="space-y-1">
          <span className="text-slate-400">Min confidence</span>
          <input type="number" min={0} max={100} value={minConfidence} onChange={(e) => setMinConfidence(Number(e.target.value))}
            className="w-full rounded border border-slate-700 bg-slate-950 px-2 py-1 text-slate-100" />
        </label>
        <label className="space-y-1">
          <span className="text-slate-400">History start (optional)</span>
          <input type="date" value={startDate} onChange={(e) => setStartDate(e.target.value)}
            className="w-full rounded border border-slate-700 bg-slate-950 px-2 py-1 text-slate-100" />
        </label>
        <label className="space-y-1">
          <span className="text-slate-400">History end (optional)</span>
          <input type="date" value={endDate} onChange={(e) => setEndDate(e.target.value)}
            className="w-full rounded border border-slate-700 bg-slate-950 px-2 py-1 text-slate-100" />
        </label>
      </div>
      {rangeIncomplete && <p className="text-[10px] text-amber-400">Set both history dates (or neither).</p>}
      {rangeInverted && <p className="text-[10px] text-amber-400">History start must be before history end.</p>}
      <button onClick={() => create.mutate()} disabled={create.isPending || rangeIncomplete || rangeInverted}
        className="w-full rounded-md bg-indigo-600 px-3 py-2 text-sm font-semibold text-white hover:bg-indigo-500 disabled:opacity-50">
        {create.isPending ? "Running…" : "Run backtest"}
      </button>
      {create.isError && <p className="text-xs text-red-400">{(create.error as Error).message}</p>}
      <p className="text-[10px] text-slate-500">Backtests run on real broker history when enough closed bars exist; otherwise a clearly labeled synthetic series is used (never for an explicit date range). Past performance does not guarantee future results.</p>
    </div>
  );
}
