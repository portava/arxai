// Does the hour-of-week volatility forecaster (lib/risk/src/volForecast.ts)
// give the structural forecast a better VOLATILITY range than the one it draws
// today? Measured on REAL markets (scripts/fixtures/real-markets-v1).
//
// WHAT IS COMPARED (both symmetric bands; neither says anything about direction)
//   CURRENT  - exactly what the product draws: volatilityBand() from
//              lib/domain/src/structural/learning.ts. sigma = RMS of the last
//              120 close-to-close log returns; edge = exp(+-0.6745 sigma sqrt(j)) - 1.
//   VARIANT  - same 25%-75% random-walk band, but the cumulative variance to
//              checkpoint j comes from the forecaster's "seasonal" model:
//              deseasonalised EWMA of Parkinson variance x the sum of the
//              hour-of-week factors of bars 1..j ahead, times one scale k that
//              turns Parkinson (high-low) variance into close-to-close variance.
//              k = sum r^2 / sum parkinson over the training bars only.
//              edge = exp(+-0.6745 sqrt(k * var_j)) - 1.
//   Pre-registered before looking: the primary variant is "seasonal" with the
//   training-only scale. Two diagnostics are reported but decide nothing:
//   "ewma" (scaled, no hour-of-week) and "seasonal" without the scale.
//
// SCORE - the 50% interval score chooseRangeEngine uses: at checkpoints 15, 30
//   and 60 bars ahead, (hi - lo) + 4 max(0, lo - y) + 4 max(0, y - hi) on the
//   relative change y. Gain per forecast = sum over checkpoints of
//   CURRENT score - VARIANT score (positive = variant better).
//
// METHOD
//   - Every series in the pinned fixture: 14 markets x {M15, H1}.
//   - Walk-forward: first 40% of each series is training only; the rest is 6
//     blocks, and before each block the seasonal factors and the scale are
//     refitted on ALL bars before it. Nothing is scored with parameters that saw it.
//   - Forecast origins every 60 bars (non-overlapping 60-bar futures), each
//     with its 120 bars of history, exactly the episode shape the model uses.
//   - Lower bound: lowerMeanGain from the structural model (moving-block
//     bootstrap, 2.5th percentile of the mean), per series and pooled.
//   - Pooled: each forecast's gain divided by its series' mean CURRENT score,
//     so every market counts on its own scale and a volatile index cannot
//     drown out a quiet currency pair.
//   - ADOPT only if the pooled normalised lower bound is > 0.
//
// Pure apart from reading the pinned fixture. Prints a JSON report; with
// --markdown <path> also writes the human-readable results.

import { writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { createHash } from "node:crypto";
import { fitSeasonal, hourOfWeek, parkinsonVar, type VolBar } from "@workspace/risk";
import { deseasonalisedLevels, fitVolRangeProfile, lowerMeanGain, RANGE_ENGINE_POLICY, seasonalVolatilityBand, volatilityBand } from "@workspace/domain/structural";
import type { StructuralBar } from "@workspace/domain/structural";
import { stableStringify } from "@workspace/discovery";
import { loadVerifiedMarketsFixture } from "./marketsHistoryFixture.js";
import { TIMEFRAME_SECONDS } from "./intradayHistoryFixture.js";

export const STRUCTURAL_VOL_RANGE_VERSION = "arx-structural-vol-range-research-v1";
const HERE = dirname(fileURLToPath(import.meta.url));
const FIXTURES = join(HERE, "..", "..", "fixtures");

const HISTORY = 120;
const FUTURE = 60;
const CHECKPOINTS = RANGE_ENGINE_POLICY.checkpoints;
const BARS_PER_DAY: Record<string, number> = { M15: 96, H1: 24 };
const TRAIN_FRACTION = 0.4;
const BLOCKS = 6;
const Z50 = 0.6745;
const MISS = 4;

export type VariantKey = "seasonal" | "ewma" | "seasonalUnscaled";
export const VARIANTS: readonly VariantKey[] = ["seasonal", "ewma", "seasonalUnscaled"];
export const PRIMARY: VariantKey = "seasonal";

export interface SeriesRow {
  symbol: string;
  assetClass: string;
  timeframe: string;
  n: number;
  currentScore: number;
  currentInside: number;
  variants: Record<VariantKey, { score: number; inside: number; relGain: number; lowerGain: number }>;
}

function ewma(v: readonly number[], halfLife: number): Float64Array {
  const lambda = Math.pow(0.5, 1 / halfLife);
  const out = new Float64Array(v.length);
  let m = v[0] ?? 0;
  for (let i = 0; i < v.length; i++) { m = i === 0 ? v[0]! : lambda * m + (1 - lambda) * v[i]!; out[i] = m; }
  return out;
}

const intervalScore = (lo: number, hi: number, y: number) => (hi - lo) + MISS * Math.max(0, lo - y) + MISS * Math.max(0, y - hi);

export function runStructuralVolRangeResearch(fixturesRoot: string = FIXTURES, pinned?: string) {
  const { manifest, instruments } = loadVerifiedMarketsFixture(fixturesRoot, pinned);
  const rows: SeriesRow[] = [];
  const pooled: Record<VariantKey, number[]> = { seasonal: [], ewma: [], seasonalUnscaled: [] };
  /** Largest gap between the production band and the research formula (should be ~1e-15). */
  let maxBandDiff = 0;
  for (const inst of instruments) {
    const tf = inst.spec.timeframe;
    const step = TIMEFRAME_SECONDS[tf] * 1000;
    const perDay = BARS_PER_DAY[tf]!;
    const t = inst.dates.map((d) => Date.parse(d));
    const bars: VolBar[] = inst.bars.map((b, i) => ({ t: t[i]!, high: b.high, low: b.low, close: b.close }));
    const structural: StructuralBar[] = inst.bars.map((b, i) => ({ openTime: t[i]!, closeTime: t[i]! + step, open: b.open, high: b.high, low: b.low, close: b.close, isFinal: true }));
    const v = bars.map(parkinsonVar);
    const r2 = bars.map((b, i) => (i ? Math.log(b.close / bars[i - 1]!.close) ** 2 : 0));
    const plainEwma = ewma(v, perDay);
    const trainEnd0 = Math.floor(bars.length * TRAIN_FRACTION);
    const blockLen = Math.floor((bars.length - trainEnd0) / BLOCKS);
    const current: number[] = [];
    let currentIn = 0;
    const scores: Record<VariantKey, number[]> = { seasonal: [], ewma: [], seasonalUnscaled: [] };
    const inside: Record<VariantKey, number> = { seasonal: 0, ewma: 0, seasonalUnscaled: 0 };
    // First origin on the 60-bar grid inside the scored region.
    let i = Math.ceil(trainEnd0 / FUTURE) * FUTURE;
    for (let b = 0; b < BLOCKS; b++) {
      const start = trainEnd0 + b * blockLen;
      const end = b === BLOCKS - 1 ? bars.length : start + blockLen;
      const seasonal = fitSeasonal(bars, v, start);
      let sr = 0, sv = 0;
      for (let k = 1; k < start; k++) { sr += r2[k]!; sv += v[k]!; }
      const scale = sv > 0 ? sr / sv : 1;
      const dEwma = ewma(bars.map((x, k) => v[k]! / seasonal.factor[hourOfWeek(x.t)]!), perDay);
      // The primary variant is scored through the PRODUCTION code (volRange.ts),
      // so what is adopted is exactly what was measured.
      const profile = fitVolRangeProfile(structural, start, step);
      if (!profile) throw new Error(`no vol-range profile for ${inst.spec.symbol} ${tf}`);
      const levels = deseasonalisedLevels(structural, profile);
      for (; i < end && i + FUTURE < bars.length; i += FUTURE) {
        if (i < HISTORY) continue;
        // Origin = close of bar i-1 (the last history bar); the future is bars i..i+59.
        const o = i - 1;
        const startClose = bars[o]!.close;
        const cur = volatilityBand(structural.slice(i - HISTORY, i), FUTURE);
        const prod = seasonalVolatilityBand(levels[o]!, structural[o]!.openTime, profile, FUTURE);
        if (!prod) continue;
        let cumSeason = 0;
        const cumByJ: number[] = [];
        for (let j = 1; j <= FUTURE; j++) { cumSeason += seasonal.factor[hourOfWeek(bars[o]!.t + j * step)]!; cumByJ.push(cumSeason); }
        let curS = 0;
        const varS: Record<VariantKey, number> = { seasonal: 0, ewma: 0, seasonalUnscaled: 0 };
        for (const j of CHECKPOINTS) {
          const y = bars[o + j]!.close / startClose - 1;
          const lo = cur.bear[j - 1]!, hi = cur.bull[j - 1]!;
          curS += intervalScore(lo, hi, y);
          currentIn += +(y >= lo && y <= hi);
          const cum: Record<VariantKey, number> = {
            seasonal: scale * dEwma[o]! * cumByJ[j - 1]!,
            ewma: scale * plainEwma[o]! * j,
            seasonalUnscaled: dEwma[o]! * cumByJ[j - 1]!,
          };
          maxBandDiff = Math.max(maxBandDiff, Math.abs(prod.bull[j - 1]! - (Math.exp(Z50 * Math.sqrt(cum.seasonal)) - 1)));
          for (const k of VARIANTS) {
            const sd = Z50 * Math.sqrt(Math.max(0, cum[k]));
            const vlo = k === "seasonal" ? prod.bear[j - 1]! : Math.exp(-sd) - 1, vhi = k === "seasonal" ? prod.bull[j - 1]! : Math.exp(sd) - 1;
            varS[k] += intervalScore(vlo, vhi, y);
            inside[k] += +(y >= vlo && y <= vhi);
          }
        }
        current.push(curS);
        for (const k of VARIANTS) scores[k].push(varS[k]);
      }
    }
    const n = current.length;
    if (!n) continue;
    const mean = (xs: readonly number[]) => xs.reduce((a, x) => a + x, 0) / Math.max(1, xs.length);
    const base = mean(current);
    const variants = {} as SeriesRow["variants"];
    for (const k of VARIANTS) {
      const gains = current.map((c, q) => c - scores[k][q]!);
      variants[k] = { score: mean(scores[k]), inside: inside[k] / (n * CHECKPOINTS.length), relGain: base > 0 ? mean(gains) / base : 0, lowerGain: base > 0 ? lowerMeanGain(gains) / base : 0 };
      if (base > 0) pooled[k].push(...gains.map((g) => g / base));
    }
    rows.push({ symbol: inst.spec.symbol, assetClass: inst.spec.assetClass, timeframe: tf, n, currentScore: base, currentInside: currentIn / (n * CHECKPOINTS.length), variants });
  }
  const summary = {} as Record<VariantKey, { n: number; meanGain: number; lowerGain: number; seriesBetter: number; seriesLowerAboveZero: number }>;
  for (const k of VARIANTS) {
    const g = pooled[k];
    summary[k] = {
      n: g.length,
      meanGain: g.reduce((a, x) => a + x, 0) / Math.max(1, g.length),
      lowerGain: lowerMeanGain(g),
      seriesBetter: rows.filter((r) => r.variants[k].relGain > 0).length,
      seriesLowerAboveZero: rows.filter((r) => r.variants[k].lowerGain > 0).length,
    };
  }
  const adopted = summary[PRIMARY].lowerGain > 0;
  const round = (x: number) => Math.round(x * 1e6) / 1e6;
  const resultHash = createHash("sha256").update(stableStringify({
    rows: rows.map((r) => [r.symbol, r.timeframe, r.n, round(r.currentScore), ...VARIANTS.map((k) => [round(r.variants[k].relGain), round(r.variants[k].lowerGain)])]),
    summary: VARIANTS.map((k) => [k, summary[k].n, round(summary[k].meanGain), round(summary[k].lowerGain)]),
    adopted,
  })).digest("hex");
  return { version: STRUCTURAL_VOL_RANGE_VERSION, datasetHash: manifest.datasetHash, primary: PRIMARY, adopted, series: rows.length, summary, rows, resultHash, maxBandDiff };
}

export type StructuralVolRangeReport = ReturnType<typeof runStructuralVolRangeResearch>;

const pct = (x: number) => `${x >= 0 ? "+" : ""}${(x * 100).toFixed(1)}%`;
const share = (x: number) => `${(x * 100).toFixed(1)}%`;

export function renderMarkdown(r: StructuralVolRangeReport): string {
  const p = r.summary[r.primary];
  const L: string[] = [];
  L.push("# Structural forecast: volatility forecaster as the VOLATILITY range", "");
  L.push(`Generated by \`scripts/src/research/structuralVolRangeResearch.ts\` (${r.version}); pinned and regenerated by \`pnpm --filter @workspace/scripts run test:structural-vol-range-research\`. Do not edit by hand.`, "");
  L.push(`- Dataset: \`scripts/fixtures/real-markets-v1\`, hash \`${r.datasetHash}\` (real markets only, no synthetic indices)`);
  L.push(`- Result hash: \`${r.resultHash}\``);
  L.push(`- Series: ${r.series}; scored forecasts (pooled): ${p.n}`, "");
  L.push("## Verdict", "");
  if (r.adopted) {
    L.push(`**Adopted.** The hour-of-week forecaster's band beats the current band at the bootstrap lower bound: pooled gain ${pct(p.meanGain)} of the current score, lower bound ${pct(p.lowerGain)}.`);
  } else {
    L.push(`**No gain, not adopted.** The pre-registered variant (\`${r.primary}\`, training-only scale) does not beat the current 120-bar band at the bootstrap lower bound: pooled gain ${pct(p.meanGain)} of the current score, lower bound ${pct(p.lowerGain)}. The structural forecast keeps its current VOLATILITY range.`);
  }
  L.push("", "This is a test of range width only. Both bands are symmetric around the last close; nothing here forecasts direction, and no directional edge is claimed.", "");
  L.push("## What was compared", "");
  L.push("- **Current**: what the product draws (`volatilityBand` in `lib/domain/src/structural/learning.ts`): ±0.6745·σ·√j in logs, σ the RMS of the last 120 close-to-close log returns.");
  L.push("- **seasonal** (primary, decides adoption): cumulative variance to bar j = k × deseasonalised EWMA of Parkinson variance × sum of hour-of-week factors for bars 1..j; k = Σr² / Σ Parkinson on training bars only.");
  L.push("- **ewma** (diagnostic): same scale, no hour-of-week factors (variance × j).");
  L.push("- **seasonalUnscaled** (diagnostic): seasonal without the scale k (raw Parkinson variance).", "");
  L.push("Score: the 50% interval score `chooseRangeEngine` uses, `(hi−lo) + 4·max(0, lo−y) + 4·max(0, y−hi)` on the relative change at checkpoints 15, 30 and 60 bars, summed per forecast. Walk-forward: first 40% training, then 6 blocks with the seasonal factors and scale refitted on everything before each block. Origins every 60 bars with 120 bars of history. Lower bound: `lowerMeanGain` (moving-block bootstrap, 2.5th percentile). Pooled gains are divided by each series' mean current score so every market counts on its own scale.", "");
  L.push("## Pooled", "");
  L.push("| Variant | Forecasts | Mean gain | Lower bound | Series better | Series with lower bound > 0 |", "|---|---:|---:|---:|---:|---:|");
  for (const k of VARIANTS) {
    const s = r.summary[k];
    L.push(`| ${k}${k === r.primary ? " (primary)" : ""} | ${s.n} | ${pct(s.meanGain)} | ${pct(s.lowerGain)} | ${s.seriesBetter}/${r.series} | ${s.seriesLowerAboveZero}/${r.series} |`);
  }
  L.push("", "Gain = (current score − variant score) / current score; positive means the variant's range is better.", "");
  L.push("## Per market", "");
  L.push("| Market | TF | Forecasts | Current inside | seasonal inside | seasonal gain | seasonal lower | ewma gain | unscaled gain |", "|---|---|---:|---:|---:|---:|---:|---:|---:|");
  for (const row of r.rows) {
    const s = row.variants.seasonal;
    L.push(`| ${row.symbol} | ${row.timeframe} | ${row.n} | ${share(row.currentInside)} | ${share(s.inside)} | ${pct(s.relGain)} | ${pct(s.lowerGain)} | ${pct(row.variants.ewma.relGain)} | ${pct(row.variants.seasonalUnscaled.relGain)} |`);
  }
  L.push("", "\"Inside\" is how often the move stayed in the band; a calibrated 50% band is inside about half the time.", "");
  const worse = r.rows.filter((row) => row.variants[r.primary].relGain < 0).length;
  L.push("## Limits", "");
  L.push(`- The gain is small: ${pct(p.meanGain)} of the interval score pooled. It holds at the pooled lower bound, but only ${p.seriesLowerAboveZero} of ${r.series} series clear zero on their own and ${worse} are worse. It is a modestly better-sized range, not a different kind of forecast.`);
  L.push("- Tested on M15 and H1 only, so only those bar sizes use it (the 8h/12h presets on M15 and the 2d preset on H1). M1, M5, M30 and H4 keep the 120-bar band: they were not measured.");
  L.push("- Production fits the hour-of-week factors and the scale once per model, on the bars that closed by the model's `trainedThrough`, and computes the EWMA over the feed the forecast reads (up to 5000 bars). The research refitted before each of 6 blocks on everything earlier. Same estimator, coarser refit schedule.");
  L.push("- The range engine choice (history vs volatility) is now made against this band on the model's selection and gate setups, which the profile was not fitted on.");
  L.push(`- The unscaled diagnostic scored higher (${pct(r.summary.seasonalUnscaled.meanGain)}), giving narrower bands. It was not the pre-registered variant, and switching to it after seeing these numbers would pick on the test data, so it is not used.`);
  L.push("- Range width only. It does not touch the probabilities, the paths' middle or any direction claim.", "");
  return L.join("\n");
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const report = runStructuralVolRangeResearch();
  const md = process.argv.indexOf("--markdown");
  if (md > 0 && process.argv[md + 1]) writeFileSync(process.argv[md + 1]!, renderMarkdown(report) + "\n");
  console.log(JSON.stringify({ ...report, rows: undefined }, null, 2));
}
