// The redesigned Mean Reversion rule (strategyEngine.ts, Strategy 6) replayed
// through the SAME path calibration uses (strategyReplay.replayStrategies:
// rolling 250-bar window, first-touch target-before-stop grading, no
// overlapping trades) on the pinned real-markets fixture.
//
// Reports, per timeframe x asset class, the trade count, win rate and mean R
// both GROSS and NET of an assumed spread (two half-spreads per trade, the
// same assumed half-spreads as the validation runner, converted to R by the
// call's own entry-to-stop distance). A t-stat is printed, not a verdict: the
// subgroups are six looks at the same rule, and the validation runner's
// MeanReversion family (FDR over the whole search) is the test of record.
//
// Reads the pinned fixture only.

import { createHash } from "node:crypto";
import { fileURLToPath } from "node:url";
import { stableStringify } from "@workspace/discovery";
import { replayStrategies, REPLAY_WINDOW } from "../../../artifacts/api-server/src/lib/calibration/strategyReplay.js";
import { meanReversionStrategy } from "../../../artifacts/api-server/src/lib/strategyEngine.js";
import { loadVerifiedMarketsFixture } from "./marketsHistoryFixture.js";
import { MARKETS_RUNNER_PARAMS } from "./realDataValidation.js";

export interface MrGroup { timeframe: string; assetClass: string; n: number; winRate: number; grossR: number; grossT: number; netR: number; netT: number }

function stat(xs: readonly number[]): { mean: number; t: number } {
  const n = xs.length;
  if (n < 2) return { mean: n ? xs[0]! : 0, t: 0 };
  const mean = xs.reduce((a, b) => a + b, 0) / n;
  const sd = Math.sqrt(xs.reduce((a, b) => a + (b - mean) ** 2, 0) / (n - 1));
  return { mean, t: sd > 0 ? mean / (sd / Math.sqrt(n)) : 0 };
}

export function runMeanReversionReplay(fixturesRoot = new URL("../../fixtures", import.meta.url).pathname) {
  const { manifest, instruments } = loadVerifiedMarketsFixture(fixturesRoot);
  const trades: Array<{ tf: string; cls: string; won: boolean; gross: number; net: number }> = [];
  for (const inst of instruments) {
    const candles = inst.bars.map((b, k) => ({ time: inst.dates[k]!, open: b.open, high: b.high, low: b.low, close: b.close, volume: 0 }));
    const half = MARKETS_RUNNER_PARAMS.costPerTurnover[inst.spec.assetClass as "fx" | "metal" | "index"]!;
    for (const s of replayStrategies(candles, inst.spec.symbol)) {
      if (s.strategyKey !== "strategy:mean_reversion") continue;
      const sig = meanReversionStrategy(candles.slice(s.barIndex - REPLAY_WINDOW + 1, s.barIndex + 1), inst.spec.symbol);
      const risk = Math.abs(sig.entryPrice - sig.stopLoss);
      if (!(risk > 0)) throw new Error(`${inst.spec.symbol}@${s.barIndex}: replayed call has no stop distance`);
      const won = s.outcome === 1;
      const gross = won ? s.rr : -1;
      trades.push({ tf: inst.spec.timeframe, cls: inst.spec.assetClass, won, gross, net: gross - (2 * half * sig.entryPrice) / risk });
    }
  }
  const group = (tf: string, cls: string, xs: typeof trades): MrGroup => {
    const g = stat(xs.map((x) => x.gross));
    const n = stat(xs.map((x) => x.net));
    return { timeframe: tf, assetClass: cls, n: xs.length, winRate: xs.filter((x) => x.won).length / Math.max(1, xs.length), grossR: g.mean, grossT: g.t, netR: n.mean, netT: n.t };
  };
  const groups: MrGroup[] = [];
  for (const tf of ["M15", "H1"]) for (const cls of ["fx", "metal", "index"]) {
    const xs = trades.filter((x) => x.tf === tf && x.cls === cls);
    if (xs.length) groups.push(group(tf, cls, xs));
  }
  const all = group("all", "all", trades);
  const r6 = (x: number) => Math.round(x * 1e6) / 1e6;
  const resultHash = createHash("sha256").update(stableStringify([...groups, all].map((g) => [g.timeframe, g.assetClass, g.n, r6(g.grossR), r6(g.netR)]))).digest("hex");
  return { datasetHash: manifest.datasetHash, groups, all, resultHash };
}

export function renderMeanReversionMarkdown(r: ReturnType<typeof runMeanReversionReplay>): string {
  const pct = (x: number) => `${(x * 100).toFixed(1)}%`;
  const L = ["## Mean Reversion (redesigned) replayed on real markets", "",
    `Replayed through the calibration path on \`real-markets-v1\` (dataset ${r.datasetHash.slice(0, 12)}…). Result hash ${r.resultHash.slice(0, 12)}…`, "",
    "| TF | Class | Trades | Win rate | Mean R gross | t | Mean R after spread | t |", "|---|---|---|---|---|---|---|---|"];
  for (const g of [...r.groups, r.all]) L.push(`| ${g.timeframe} | ${g.assetClass} | ${g.n} | ${pct(g.winRate)} | ${g.grossR.toFixed(3)} | ${g.grossT.toFixed(2)} | ${g.netR.toFixed(3)} | ${g.netT.toFixed(2)} |`);
  L.push("");
  return `${L.join("\n")}\n`;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const r = runMeanReversionReplay();
  console.log(renderMeanReversionMarkdown(r));
}
