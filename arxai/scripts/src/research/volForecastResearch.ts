// Volatility-forecast research on REAL markets (scripts/fixtures/real-markets-v1).
//
// QUESTION: does knowing (a) that volatility clusters and (b) the hour of the
// week let us forecast how much price will move over the next H bars better
// than a constant-volatility baseline (the trailing five-day average)?
//
// METHOD
//   - Every series in the pinned fixture: 14 real markets x {M15, H1}.
//   - Two horizons per timeframe, fixed before looking: M15 {4, 16} bars (1h, 4h),
//     H1 {4, 24} bars (4h, 1 day).
//   - Walk-forward: the first 40% of each series is training only. The rest is
//     cut into 6 blocks; before each block the seasonal factors and HAR
//     coefficients are refitted on ALL bars before it, and only that block is
//     scored. Nothing is ever scored with parameters that saw it.
//   - Loss: QLIKE (Patton 2011), robust to noise in the variance proxy.
//   - Test: one-sided Diebold–Mariano vs the baseline, Newey–West lag = H
//     (overlapping targets).
//   - Multiplicity: ONE Benjamini–Hochberg pass at q = 0.05 over every
//     (series, horizon, model) test in the run.
//   - Calibration: coverage of the 80% band ±1.2816·sqrt(forecast) on the
//     close-to-close move over the horizon (how often the move stayed inside).
//
// Pure apart from reading the pinned fixture. Prints a JSON report; with
// --markdown <path> also writes the human-readable results.

import { writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { createHash } from "node:crypto";
import {
  fitVolModels, forecastAt, volFeatures, parkinsonVar, realisedAhead, qlike, dieboldMariano, bandCoverage,
  type VolBar, type VolModelKey,
} from "@workspace/risk";
import { controlFdr, stableStringify } from "@workspace/discovery";
import { loadVerifiedMarketsFixture } from "./marketsHistoryFixture.js";
import { TIMEFRAME_SECONDS } from "./intradayHistoryFixture.js";

export const VOL_RESEARCH_VERSION = "arx-vol-forecast-research-v1";
const HERE = dirname(fileURLToPath(import.meta.url));
const FIXTURES = join(HERE, "..", "..", "fixtures");

const MODELS: readonly Exclude<VolModelKey, "naive">[] = ["ewma", "seasonal", "har", "harSeasonal"];
const HORIZONS: Record<string, number[]> = { M15: [4, 16], H1: [4, 24] };
const BARS_PER_DAY: Record<string, number> = { M15: 96, H1: 24 };
const TRAIN_FRACTION = 0.4;
const BLOCKS = 6;
const Q = 0.05;
const Z80 = 1.2816;
/** A (series, horizon) with fewer scored forecasts than this is reported unmeasured, not tested. */
export const MIN_SCORED = 500;

export interface VolTestRow {
  key: string;
  symbol: string;
  assetClass: string;
  timeframe: string;
  horizon: number;
  model: string;
  n: number;
  baselineQlike: number;
  modelQlike: number;
  /** Relative QLIKE improvement over the baseline (positive = better). */
  improvement: number;
  dmStat: number;
  p: number;
  survives: boolean;
  coverage80: number;
  baselineCoverage80: number;
}

export interface VolUnmeasured { symbol: string; timeframe: string; horizon: number; scored: number; reason: string }

export function runVolResearch(fixturesRoot: string = FIXTURES, pinned?: string): { version: string; datasetHash: string; family: number; survivors: number; rows: VolTestRow[]; unmeasured: VolUnmeasured[]; resultHash: string } {
  const { manifest, instruments } = loadVerifiedMarketsFixture(fixturesRoot, pinned);
  const rows: Omit<VolTestRow, "survives">[] = [];
  const unmeasured: VolUnmeasured[] = [];
  for (const inst of instruments) {
    const tf = inst.spec.timeframe;
    const step = TIMEFRAME_SECONDS[tf] * 1000;
    const bars: VolBar[] = inst.bars.map((b, i) => ({ t: Date.parse(inst.dates[i]!), high: b.high, low: b.low, close: b.close }));
    const v = bars.map(parkinsonVar);
    for (const horizon of HORIZONS[tf]!) {
      const cfg = { horizon, barsPerDay: BARS_PER_DAY[tf]! };
      const trainEnd0 = Math.floor(bars.length * TRAIN_FRACTION);
      const blockLen = Math.floor((bars.length - trainEnd0) / BLOCKS);
      const loss: Record<VolModelKey, number[]> = { naive: [], ewma: [], seasonal: [], har: [], harSeasonal: [] };
      const fcs: Record<VolModelKey, number[]> = { naive: [], ewma: [], seasonal: [], har: [], harSeasonal: [] };
      const moves: number[] = [];
      for (let b = 0; b < BLOCKS; b++) {
        const start = trainEnd0 + b * blockLen;
        const end = b === BLOCKS - 1 ? bars.length : start + blockLen;
        // Fit on everything before the block; targets inside fitVolModels stop H bars short of `start`.
        const fitted = fitVolModels(bars, cfg, start);
        const f = volFeatures(bars, fitted);
        for (let i = start; i < end && i + horizon < bars.length; i++) {
          // Only score a target whose bars are all real consecutive bars (no weekend/holiday gap inside).
          if (bars[i + horizon]!.t - bars[i]!.t !== horizon * step) continue;
          const y = realisedAhead(v, i, horizon);
          if (!(y > 0)) continue;
          const fc = forecastAt(bars, fitted, step, i, f);
          if (!Object.values(fc).every((x) => x > 0 && Number.isFinite(x))) continue;
          for (const k of ["naive", ...MODELS] as VolModelKey[]) { loss[k].push(qlike(y, fc[k])); fcs[k].push(fc[k]); }
          moves.push(Math.log(bars[i + horizon]!.close / bars[i]!.close));
        }
      }
      if (loss.naive.length < MIN_SCORED) {
        // Not a test with a bad result: there was nothing to score. Kept out of the FDR family and said so.
        unmeasured.push({ symbol: inst.spec.symbol, timeframe: tf, horizon, scored: loss.naive.length,
          reason: `only ${loss.naive.length} windows of ${horizon} consecutive ${tf} bars with no gap (the market closes inside every ${horizon}-bar window)` });
        continue;
      }
      const mean = (xs: number[]) => xs.reduce((a, b) => a + b, 0) / Math.max(1, xs.length);
      const base = mean(loss.naive);
      const baseCov = bandCoverage(moves, fcs.naive, Z80);
      for (const m of MODELS) {
        const dm = dieboldMariano(loss.naive, loss[m], horizon);
        rows.push({
          key: `${inst.spec.symbol}|${tf}|h${horizon}|${m}`,
          symbol: inst.spec.symbol, assetClass: inst.spec.assetClass, timeframe: tf, horizon, model: m,
          n: loss[m].length, baselineQlike: base, modelQlike: mean(loss[m]),
          improvement: base > 0 ? (base - mean(loss[m])) / base : 0,
          dmStat: dm.stat, p: Number.isFinite(dm.p) ? dm.p : 1,
          coverage80: bandCoverage(moves, fcs[m], Z80), baselineCoverage80: baseCov,
        });
      }
    }
  }
  const fdr = controlFdr(rows.map((r) => ({ key: r.key, p: r.p })), Q, rows.length);
  const rejected = new Set(fdr.decisions.filter((d) => d.rejected).map((d) => d.key));
  const out: VolTestRow[] = rows.map((r) => ({ ...r, survives: rejected.has(r.key) && r.improvement > 0 }));
  const round = (x: number) => Math.round(x * 1e6) / 1e6;
  const resultHash = createHash("sha256").update(stableStringify({ rows: out.map((r) => [r.key, r.n, round(r.improvement), r.survives]), unmeasured })).digest("hex");
  return { version: VOL_RESEARCH_VERSION, datasetHash: manifest.datasetHash, family: rows.length, survivors: out.filter((r) => r.survives).length, rows: out, unmeasured, resultHash };
}

function pct(x: number) { return `${(x * 100).toFixed(1)}%`; }

export function renderMarkdown(r: ReturnType<typeof runVolResearch>): string {
  const lines: string[] = [];
  lines.push("# Volatility forecast results (real markets)", "");
  lines.push(`Generated by \`scripts/src/research/volForecastResearch.ts\` (${r.version}) on the pinned fixture \`real-markets-v1\` (dataset ${r.datasetHash.slice(0, 12)}…). Result hash ${r.resultHash.slice(0, 12)}…`, "");
  lines.push(`**${r.survivors} of ${r.family}** model tests beat the five-day constant-volatility baseline after one Benjamini–Hochberg pass at q = ${Q} over the whole run.`, "");
  lines.push("Improvement = relative reduction in QLIKE loss vs the baseline, out of sample (walk-forward, refitted before every block). Coverage = how often the close-to-close move over the horizon stayed inside the model's 80% band (80% is perfect).", "");
  // Best model per series/horizon.
  const groups = new Map<string, VolTestRow[]>();
  for (const row of r.rows) { const g = `${row.symbol}|${row.timeframe}|${row.horizon}`; groups.set(g, [...(groups.get(g) ?? []), row]); }
  lines.push("| Market | TF | Horizon | Best model | Improvement | p | Survives | 80% band coverage (model / baseline) | N |", "|---|---|---|---|---|---|---|---|---|");
  for (const [, rs] of groups) {
    const best = [...rs].sort((a, b) => b.improvement - a.improvement)[0]!;
    lines.push(`| ${best.symbol} | ${best.timeframe} | ${best.horizon} bars | ${best.model} | ${pct(best.improvement)} | ${best.p < 1e-4 ? best.p.toExponential(1) : best.p.toFixed(4)} | ${best.survives ? "yes" : "no"} | ${pct(best.coverage80)} / ${pct(best.baselineCoverage80)} | ${best.n} |`);
  }
  if (r.unmeasured.length) {
    lines.push("", "## Not measurable (kept out of the test family)", "");
    for (const u of r.unmeasured) lines.push(`- ${u.symbol} ${u.timeframe}, ${u.horizon} bars: ${u.reason}.`);
  }
  lines.push("", "## By model (median improvement across series and horizons)", "", "| Model | Median improvement | Survivors |", "|---|---|---|");
  for (const m of MODELS) {
    const rs = r.rows.filter((x) => x.model === m).map((x) => x.improvement).sort((a, b) => a - b);
    lines.push(`| ${m} | ${pct(rs[Math.floor(rs.length / 2)] ?? 0)} | ${r.rows.filter((x) => x.model === m && x.survives).length} / ${rs.length} |`);
  }
  lines.push("");
  return `${lines.join("\n")}\n`;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const r = runVolResearch();
  const i = process.argv.indexOf("--markdown");
  if (i > 0 && process.argv[i + 1]) writeFileSync(process.argv[i + 1]!, renderMarkdown(r));
  console.log(JSON.stringify({ version: r.version, datasetHash: r.datasetHash, family: r.family, survivors: r.survivors, resultHash: r.resultHash }, null, 2));
}
