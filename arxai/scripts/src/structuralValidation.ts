/** Reproducible validation CLI, not an application market-data provider.
 * Only public candle/tick reads; no credentials or trading API messages.
 * node --import tsx src/structuralValidation.ts <output-dir> [--capture]
 */
import { mkdir, readFile, writeFile, appendFile } from "node:fs/promises";
import { resolve, join } from "node:path";
import { createHash } from "node:crypto";
import { fitStructuralModel, forecastStructural, evaluateForecast, makeEpisodes, chronologicalPartitions,
  MODEL_POLICY, STRUCTURAL_VERSION, calibrationBins, probabilities, scenarioIndex, lowerMeanGain,
  type StructuralBar, type DataOrigin } from "@workspace/domain/structural";
import { resolveDerivSymbol } from "../../artifacts/api-server/src/lib/data/providers/derivProvider.js";

const ENDPOINT = "wss://api.derivws.com/trading/v1/options/ws/public";
const SYMBOLS = ["V75", "V75_1S", "V50", "V50_1S", "V25_1S"];
const directory = process.argv[2];
if (!directory) throw new Error("Pass an output directory; use --capture to download public data.");
const output = resolve(directory);
await mkdir(output, { recursive: true });

async function publicRead(request: Record<string, unknown>): Promise<any> {
  if (!("ticks_history" in request || "ticks" in request)) throw new Error("READ_ONLY_MESSAGE_REQUIRED");
  return new Promise((resolve, reject) => {
    const socket = new WebSocket(ENDPOINT);
    const timeout = setTimeout(() => { socket.close(); reject(new Error("PUBLIC_DATA_TIMEOUT")); }, 15_000);
    socket.onopen = () => socket.send(JSON.stringify({ ...request, req_id: 1 }));
    socket.onerror = () => { clearTimeout(timeout); socket.close(); reject(new Error("PUBLIC_DATA_CONNECTION_FAILED")); };
    socket.onmessage = event => {
      const response = JSON.parse(String(event.data));
      if (response.req_id !== 1) return;
      clearTimeout(timeout); socket.close();
      if (response.error) reject(new Error(response.error.code ?? "PUBLIC_DATA_REFUSED")); else resolve(response);
    };
  });
}

// Freeze implementation settings before obtaining holdout data/results.
const sourceHashes = Object.fromEntries(await Promise.all(["contracts", "observer", "math", "model", "evaluation"].map(async name =>
  [name, createHash("sha256").update(await readFile(new URL(`../../lib/domain/src/structural/${name}.ts`, import.meta.url))).digest("hex")])));
const plan = { version: STRUCTURAL_VERSION, policy: MODEL_POLICY, symbols: SYMBOLS,
  sourceHashes,
  split: "chronological 55/15/15/15, 60m purge", endpoint: ENDPOINT,
  claims: "Exploratory real-feed replay; not a market-edge acceptance test; no historical arrival times." };
const planHash = createHash("sha256").update(JSON.stringify(plan)).digest("hex");
await writeFile(join(output, "plan.json"), JSON.stringify({ ...plan, planHash }, null, 2), { flag: "wx" });
const summaries: unknown[] = [];
for (const symbol of SYMBOLS) {
  const path = join(output, `${symbol}.json`);
  try {
    if (process.argv.includes("--capture")) {
      const map = resolveDerivSymbol(symbol)!;
      let end: string | number = "latest";
      const raw: any[] = [], requests: unknown[] = [];
      for (let page = 0; page < 8; page++) {
        const request = { ticks_history: map.derivId, style: "candles", granularity: 60, count: 1000, end: String(end) };
        const response = await publicRead(request);
        if (!response.candles?.length) break;
        raw.push(...response.candles); requests.push({ request, receivedAt: new Date().toISOString(), count: response.candles.length });
        end = Math.min(...response.candles.map((b: any) => Number(b.epoch))) - 1;
      }
      const fetchedAt = new Date().toISOString(), now = Date.now();
      const seen = new Set<number>();
      const bars: StructuralBar[] = raw.sort((a, b) => Number(a.epoch) - Number(b.epoch))
        .filter(b => { const t = Number(b.epoch); if (seen.has(t)) return false; seen.add(t); return (t + 60) * 1000 <= now; })
        .map(b => ({ openTime: Number(b.epoch) * 1000, closeTime: (Number(b.epoch) + 60) * 1000,
          open: Number(b.open), high: Number(b.high), low: Number(b.low), close: Number(b.close), isFinal: true }));
      const origin: DataOrigin = { provider: "deriv_public", symbol, fetchedAt, kind: "BROKER_HISTORY", historicalArrivalTimesKnown: false };
      await writeFile(path, JSON.stringify({ bars, origin, endpoint: ENDPOINT, requests }), { flag: "wx" });
      const tick = await publicRead({ ticks: map.derivId, subscribe: 1 });
      await writeFile(join(output, `${symbol}-live-tick.json`), JSON.stringify({ receivedAt: new Date().toISOString(), response: tick }), { flag: "wx" });
    }
    const raw = await readFile(path, "utf8");
    const { bars, origin } = JSON.parse(raw) as { bars: StructuralBar[]; origin: DataOrigin };
    const started = performance.now(), model = fitStructuralModel(bars, origin), fitMs = performance.now() - started;
    const holdout = chronologicalPartitions(makeEpisodes(bars)).holdout;
    const scores: Array<{ eligible: boolean; horizon: number; brier: number; baselineBrier: number; logLoss: number; outcome: number; p: [number, number, number]; leadMinutes: number | null; firstBreakLeadMinutes: number | null }> = [];
    const pathAvailability = { UP_FIRST: 0, DOWN_FIRST: 0, NEITHER: 0 };
    const forecastFile = join(output, `${symbol}-issued.jsonl`);
    await writeFile(forecastFile, "", { flag: "wx" });
    for (const e of holdout) {
      const f = forecastStructural(model, e.history, origin);
      // Prewrite the immutable forecast before the evaluation function receives
      // its future. Replay is candle-close based, not original arrival replay.
      await appendFile(forecastFile, JSON.stringify(f) + "\n");
      for (const path of f.paths) if (path.candles.length) pathAvailability[path.scenario]++;
      for (const s of evaluateForecast(f, e.future, e.origin + 3_600_000)) scores.push({ eligible: e.eligible,
        horizon: s.horizon, brier: s.brier, baselineBrier: s.baselineBrier, logLoss: s.logLoss,
        leadMinutes: s.event ? (s.event.time - e.origin) / 60_000 : null,
        firstBreakLeadMinutes: s.event ? (s.event.precursorTime - e.origin) / 60_000 : null,
        outcome: scenarioIndex(s.outcome), p: probabilities(f.mass, s.horizon) });
    }
    const diagnostics = (selected: typeof scores) => {
      const calls = selected.filter(r => r.p.indexOf(Math.max(...r.p)) < 2);
      const correct = calls.filter(r => r.p.indexOf(Math.max(...r.p)) === r.outcome);
      const actual = selected.filter(r => r.outcome < 2);
      const median = (xs: number[]) => xs.length ? xs.sort((a, b) => a - b)[Math.floor(xs.length / 2)] : null;
      return { n: selected.length, directionalCalls: calls.length, correct: correct.length,
        precision: calls.length ? correct.length / calls.length : null,
        recall: actual.length ? correct.length / actual.length : null,
        falseDirectionFraction: calls.length ? (calls.length - correct.length) / calls.length : null,
        medianConfirmationLeadMinutes: median(correct.flatMap(r => r.leadMinutes == null ? [] : [r.leadMinutes])),
        medianFirstBreakLeadMinutes: median(correct.flatMap(r => r.firstBreakLeadMinutes == null ? [] : [r.firstBreakLeadMinutes])),
        decisionRule: "argmax directional class, descriptive only; not a calibrated warning threshold" };
    };
    const byHorizon = [1, 3, 5, 15, 30, 60].map(horizon => {
      const selected = scores.filter(s => s.horizon === horizon), n = selected.length;
      return { horizon, n, brier: selected.reduce((s, r) => s + r.brier, 0) / n,
        baselineBrier: selected.reduce((s, r) => s + r.baselineBrier, 0) / n,
        logLoss: selected.reduce((s, r) => s + r.logLoss, 0) / n,
        counts: [0, 1, 2].map(c => selected.filter(s => s.outcome === c).length), calibration: calibrationBins(selected),
        lowerMeanBrierGain: lowerMeanGain(selected.map(r => r.baselineBrier - r.brier)),
        all: diagnostics(selected), prebreak: diagnostics(selected.filter(r => r.eligible)),
        confirmation: diagnostics(selected.filter(r => !r.eligible)) };
    });
    const summary = { symbol, bars: bars.length, first: bars[0]!.openTime, last: bars.at(-1)!.closeTime,
      sha256: createHash("sha256").update(raw).digest("hex"), planHash, fitMs,
      gates: { geometry: model.geometryGate, confirmation: model.confirmationGate, prebreak: model.prebreakGate },
      partitions: model.partitions, dataQuality: model.dataQuality, eligibleHoldout: holdout.filter(e => e.eligible).length, pathAvailability, byHorizon,
      verdict: "EXPLORATORY_REAL_FEED_REPLAY_NOT_MARKET_EDGE_VALIDATION" };
    await writeFile(join(output, `${symbol}-result.json`), JSON.stringify(summary, null, 2), { flag: "wx" });
    await writeFile(join(output, `${symbol}-model.json`), JSON.stringify(model), { flag: "wx" });
    summaries.push(summary); console.log(JSON.stringify({ symbol, bars: bars.length, holdout: holdout.length, fitMs, brier5m: byHorizon[2]!.brier, prebreak: model.prebreakGate.reason }));
  } catch (error) { process.exitCode = 1; const result = { symbol, error: error instanceof Error ? error.message : String(error) }; summaries.push(result); console.log(JSON.stringify(result)); }
}
await writeFile(join(output, "summary.json"), JSON.stringify(summaries, null, 2), { flag: "wx" });
