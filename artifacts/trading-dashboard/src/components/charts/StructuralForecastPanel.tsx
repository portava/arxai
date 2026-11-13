import { useCallback, useEffect, useRef, useState } from "react";
import type { ForecastScore, GhostPath, StructuralForecast, Scenario } from "@workspace/domain/structural";
import { Button } from "@/components/ui/button";
import { resolveArxMarket } from "@workspace/domain/market";

interface Row { id: string; issuedAt: number; forecast: StructuralForecast; scores: ForecastScore[] }
const labels: Record<Scenario, string> = { UP_FIRST: "Bullish first", DOWN_FIRST: "Bearish first", NEITHER: "Neither confirmed" };
const allScenarios: Scenario[] = ["UP_FIRST", "DOWN_FIRST", "NEITHER"];
const basePath = (import.meta.env.BASE_URL || "/").replace(/\/$/, "");

export function StructuralForecastPanel({ symbol, onPaths, selectedScenarios, onSelectedScenariosChange }: { symbol: string; onPaths(paths: GhostPath[]): void; selectedScenarios?:Scenario[]; onSelectedScenariosChange?:(next:Scenario[])=>void }) {
  const canonicalSymbol = resolveArxMarket(symbol)?.canonicalSymbol ?? symbol;
  const [row, setRow] = useState<Row | null>(null);
  const [history, setHistory] = useState<Row[]>([]);
  const [internalSelected, setInternalSelected] = useState<Scenario[]>(allScenarios);
  const selected=selectedScenarios??internalSelected;
  const setSelected=(next:Scenario[])=>{setInternalSelected(next);onSelectedScenariosChange?.(next);};
  const [horizon, setHorizon] = useState(60);
  const [cohort, setCohort] = useState("all");
  const [auto, setAuto] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const request = useRef<AbortController | null>(null);

  useEffect(() => {
    request.current?.abort(); setRow(null); setHistory([]); setError(null); setAuto(false); setBusy(false);
    return () => { request.current?.abort(); };
  }, [symbol]);
  useEffect(() => {
    onPaths(row?.forecast.origin.symbol === canonicalSymbol ? row.forecast.paths.filter(p => selected.includes(p.scenario)) : []);
  }, [row, canonicalSymbol, selected, onPaths]);

  const generate = useCallback(async (historyOnly = false) => {
    request.current?.abort(); const controller = new AbortController(); request.current = controller;
    setBusy(true); setError(null);
    try {
      // Resolve existing predictions separately, then issue/save the next one.
      const historyResponse = await fetch(`${basePath}/api/me/structural/forecasts?symbol=${encodeURIComponent(symbol)}`, { credentials: "include", signal: controller.signal });
      if (historyResponse.ok) {
        const memory = await historyResponse.json();
        if (!controller.signal.aborted) setHistory(memory.forecasts ?? []);
      } else if (historyOnly) throw new Error("PREDICTION_MEMORY_UNAVAILABLE");
      if (historyOnly) return;
      const response = await fetch(`${basePath}/api/me/structural/forecasts`, { method: "POST", credentials: "include",
        headers: { "Content-Type": "application/json" }, body: JSON.stringify({ symbol }), signal: controller.signal });
      const result = await response.json();
      if (!response.ok || !result.saved) throw new Error(result.reason ?? result.error ?? "FORECAST_UNAVAILABLE");
      if (!controller.signal.aborted) setRow(result as Row);
    } catch (e) {
      if (!controller.signal.aborted) setError(e instanceof Error ? e.message.replaceAll("_", " ").toLowerCase() : "Forecast unavailable");
    } finally { if (!controller.signal.aborted) setBusy(false); }
  }, [symbol]);

  useEffect(() => {
    if (!auto) return;
    const timer = setInterval(() => { if (!document.hidden && !busy) void generate(); }, 60_000);
    return () => clearInterval(timer);
  }, [auto, busy, generate]);

  const probability = row?.forecast.horizons.find(h => h.minutes === horizon)?.probabilities;
  const evaluated = history.filter(r => cohort === "all" || (cohort === "prebreak" ? r.forecast.preBreakEligible : !r.forecast.preBreakEligible))
    .flatMap(r => r.scores.filter(s => s.horizon === horizon).map(score => ({ score,
      p: r.forecast.horizons.find(h => h.minutes === horizon)?.probabilities })));
  const scores = evaluated.map(r => r.score);
  const directional = evaluated.filter(r => r.p && r.p.indexOf(Math.max(...r.p)) < 2);
  const correctDirection = directional.filter(r => (r.p!.indexOf(Math.max(...r.p!)) === 0 ? "UP_FIRST" : "DOWN_FIRST") === r.score.outcome).length;
  const actualDirection = evaluated.filter(r => r.score.outcome !== "NEITHER").length;
  const average = (key: "brier" | "baselineBrier" | "logLoss") => scores.length ? (scores.reduce((s, r) => s + r[key], 0) / scores.length).toFixed(4) : "—";
  return <section aria-label="Structural forecasts" className="border-t border-zinc-800 px-4 py-3 text-xs">
    <div className="flex flex-wrap items-center gap-3">
      <strong className="text-zinc-100">ARX structural forecast</strong>
      <Button size="sm" variant="outline" disabled={busy} onClick={() => void generate()}>{busy ? "Building forecast…" : "Forecast next hour"}</Button>
      <Button size="sm" variant="ghost" disabled={busy} onClick={() => void generate(true)}>Refresh saved forecasts</Button>
      <label className="flex items-center gap-1"><input type="checkbox" checked={auto} onChange={e => { setAuto(e.target.checked); if (e.target.checked) void generate(); }} /> Update each minute</label>
      <label>Horizon <select aria-label="Forecast horizon" className="rounded bg-zinc-900 p-1" value={horizon} onChange={e => setHorizon(Number(e.target.value))}>
        {[1, 3, 5, 15, 30, 60].map(h => <option key={h} value={h}>{h}m</option>)}</select></label>
    </div>
    {error && <p role="alert" className="mt-2 text-amber-300">Forecast unavailable: {error}. Saved forecasts remain unchanged.</p>}
    {row && row.forecast.origin.symbol === canonicalSymbol && <>
      <p className="mt-2 text-zinc-400">Saved {new Date(row.issuedAt).toLocaleString()} · Data through {new Date(row.forecast.asOf).toLocaleTimeString()} · {row.forecast.mode.replaceAll("_", " ").toLowerCase()} · {row.forecast.origin.provider}</p>
      <div aria-label="Selected horizon probabilities" className="my-2 flex flex-wrap gap-4"><span>Outcomes at {horizon}m:</span>
        {allScenarios.map((scenario, i) => <span key={scenario}>{labels[scenario]}: <strong>{((probability?.[i] ?? 0) * 100).toFixed(1)}%</strong></span>)}
      </div>
      <div className="my-2 flex flex-wrap gap-4"><span>60m ghost paths:</span>{row.forecast.paths.map(path => <label key={path.scenario} className="flex items-center gap-2">
        <input type="checkbox" checked={selected.includes(path.scenario)} disabled={!path.candles.length}
          onChange={e => setSelected(e.target.checked ? [...selected, path.scenario] : selected.filter(s => s !== path.scenario))} />
        <span>{labels[path.scenario]} ({(path.probability * 100).toFixed(1)}% at 60m){!path.candles.length && " · path unavailable"}</span>
      </label>)}</div>
      <p className="text-amber-200">Ghost candles are illustrative scenarios, not calibrated price predictions. “Neither” means no confirmed structural break; prices can still move.</p>
      <p className="mt-1 text-zinc-400">Model {row.forecast.version} · {row.forecast.gateReason.replaceAll("_", " ").toLowerCase()} · Predictive performance not yet validated.</p>
    </>}
    {(row || history.length > 0) && <div aria-label="Forecast performance" className="mt-3 flex flex-wrap gap-4 text-zinc-300">
      <label>Scoring <select aria-label="Forecast scoring cohort" className="rounded bg-zinc-900 p-1" value={cohort} onChange={e => setCohort(e.target.value)}>
        <option value="all">All snapshots</option><option value="prebreak">Before first break</option><option value="confirmation">After precursor</option>
      </select></label>
      <span>{horizon}m resolved: {scores.length}</span><span>Brier: {average("brier")}</span><span>Frequency baseline: {average("baselineBrier")}</span><span>Log loss: {average("logLoss")}</span>
      <span>Direction precision: {directional.length ? `${(100 * correctDirection / directional.length).toFixed(1)}% (${directional.length})` : "—"}</span>
      <span>Direction recall: {actualDirection ? `${(100 * correctDirection / actualDirection).toFixed(1)}%` : "—"}</span>
      <span>Saved forecasts: {history.length + (row && !history.some(r => r.id === row.id) ? 1 : 0)}</span>
    </div>}
    {history.length > 0 && <label className="mt-2 block text-zinc-400">Review a saved forecast <select aria-label="Saved forecast" className="ml-2 rounded bg-zinc-900 p-1" value={row?.id ?? ""} onChange={e => setRow(history.find(r => r.id === e.target.value) ?? row)}>
      <option value="">Select issuance time</option>{row && !history.some(r => r.id === row.id) && <option value={row.id}>Current forecast</option>}
      {history.map(r => <option key={r.id} value={r.id}>{new Date(r.issuedAt).toLocaleString()}</option>)}
    </select></label>}
  </section>;
}
