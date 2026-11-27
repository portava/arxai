import type { StructuralBar } from "./contracts.js";

/**
 * Hour-of-week volatility range for the structural forecast's VOLATILITY
 * engine. Measured on real markets before adoption: on M15 and H1 it beat
 * the 120-bar band at the bootstrap lower bound of the 50% interval score
 * (docs/STRUCTURAL_VOL_RANGE_RESULTS.md, pinned by
 * scripts/src/structuralVolRangeResearchTest.ts). Other bar sizes were not
 * tested, so they keep the 120-bar band.
 *
 * The band is still the symmetric 25%-75% range of a random walk,
 * +-0.6745 sqrt(cumulative variance to bar j) in logs. Only the variance
 * changes: deseasonalised EWMA of Parkinson (high-low) variance x the sum of
 * the hour-of-week factors of the bars ahead x one scale that turns Parkinson
 * variance into close-to-close variance. It carries no direction.
 *
 * The seasonal fit mirrors fitSeasonal in lib/risk/src/volForecast.ts (domain
 * cannot import risk); the research test asserts both give identical factors.
 */
export const VOL_RANGE_POLICY = Object.freeze({
  /** Bar sizes the research tested and adopted: M15 and H1. */
  testedStepsMs: [15 * 60_000, 60 * 60_000] as readonly number[],
  z50: .6745,
  /** Shrinkage of each hour's factor toward 1 (log space), weight n/(n+K). */
  shrinkK: 5,
});

export interface VolRangeProfile {
  stepMs: number;
  /** EWMA half-life in bars: one day of bars. */
  halfLifeBars: number;
  /** 168 hour-of-week factors (Monday 00:00 UTC = 0); 1 where unseen. */
  factor: number[];
  /** Sum of squared close-to-close log returns / sum of Parkinson variance, on the fitted bars. */
  scale: number;
  /** Close time of the last bar the profile was fitted on. */
  fittedThrough: number;
}

const validBar = (b: StructuralBar) => b.isFinal && [b.openTime,b.closeTime,b.open,b.high,b.low,b.close].every(Number.isFinite)
  && b.closeTime>b.openTime && b.low>0 && b.high>=Math.max(b.open,b.close) && b.low<=Math.min(b.open,b.close);
const validProfile = (p: VolRangeProfile) => VOL_RANGE_POLICY.testedStepsMs.includes(p.stepMs)
  && Number.isFinite(p.fittedThrough) && Number.isFinite(p.scale) && p.scale>0
  && Number.isFinite(p.halfLifeBars) && p.halfLifeBars>0 && p.factor.length===168
  && p.factor.every(x=>Number.isFinite(x)&&x>0);
const LN2x4 = 4 * Math.LN2;
export function parkinsonVariance(b: Pick<StructuralBar, "high" | "low">): number {
  if (!(b.high > 0 && b.low > 0 && b.high >= b.low)) return 0;
  const r = Math.log(b.high / b.low);
  return (r * r) / LN2x4;
}
export function hourOfWeekUtc(t: number): number {
  const d = new Date(t);
  return ((d.getUTCDay() + 6) % 7) * 24 + d.getUTCHours();
}

/** Seasonal factors from bars [0, end) only, the same estimator as lib/risk fitSeasonal. */
export function seasonalFactors(openTimes: readonly number[], v: readonly number[], end: number): number[] {
  const sum = new Float64Array(168), n = new Float64Array(168);
  let total = 0, count = 0;
  for (let i = 0; i < end; i++) {
    const h = hourOfWeekUtc(openTimes[i]!);
    sum[h] += v[i]!; n[h] += 1; total += v[i]!; count += 1;
  }
  const mean = count > 0 ? total / count : 0;
  const factor = new Array<number>(168).fill(1);
  if (!(mean > 0)) return factor;
  const K = VOL_RANGE_POLICY.shrinkK;
  for (let h = 0; h < 168; h++) {
    if (n[h] === 0) continue;
    const raw = Math.max(sum[h]! / n[h]! / mean, 0.01);
    const w = n[h]! / (n[h]! + K);
    factor[h] = Math.max(0.05, Math.exp(w * Math.log(raw)));
  }
  return factor;
}

/** Fit on bars [0, end). Null for a bar size the research did not test, or too little data. */
export function fitVolRangeProfile(bars: readonly StructuralBar[], end: number, stepMs: number): VolRangeProfile | null {
  if (!VOL_RANGE_POLICY.testedStepsMs.includes(stepMs) || !Number.isInteger(end) || end < 2 || end > bars.length) return null;
  if (bars.slice(0, end).some((b, i) => !validBar(b) || (i > 0 && b.openTime < bars[i - 1]!.closeTime))) return null;
  const v = bars.map(parkinsonVariance);
  let sr = 0, sv = 0;
  for (let k = 1; k < end; k++) { sr += Math.log(bars[k]!.close / bars[k - 1]!.close) ** 2; sv += v[k]!; }
  if (!(sv > 0) || !Number.isFinite(sr)) return null;
  return { stepMs, halfLifeBars: Math.round(86_400_000 / stepMs), factor: seasonalFactors(bars.map(b => b.openTime), v, end),
    scale: sr / sv, fittedThrough: bars[end - 1]!.closeTime };
}

/** Deseasonalised EWMA of Parkinson variance at every bar (causal: bar i uses bars 0..i). */
export function deseasonalisedLevels(bars: readonly StructuralBar[], profile: VolRangeProfile): Float64Array {
  const lambda = Math.pow(0.5, 1 / profile.halfLifeBars);
  const out = new Float64Array(bars.length);
  let m = 0;
  for (let i = 0; i < bars.length; i++) {
    const d = parkinsonVariance(bars[i]!) / profile.factor[hourOfWeekUtc(bars[i]!.openTime)]!;
    m = i === 0 ? d : lambda * m + (1 - lambda) * d;
    out[i] = m;
  }
  return out;
}

/** The band edges for bars 1..horizonBars after a last bar opening at `lastOpenTime` with deseasonalised level `level`. */
export function seasonalVolatilityBand(level: number, lastOpenTime: number, profile: VolRangeProfile, horizonBars: number): { bull: number[]; bear: number[] } | null {
  if (!(level > 0) || !Number.isFinite(level) || !validProfile(profile)
    || !Number.isFinite(lastOpenTime) || profile.fittedThrough > lastOpenTime + profile.stepMs
    || !Number.isInteger(horizonBars) || horizonBars < 1 || horizonBars > 60) return null;
  const bull: number[] = [], bear: number[] = [];
  let cum = 0;
  for (let j = 1; j <= horizonBars; j++) {
    cum += profile.factor[hourOfWeekUtc(lastOpenTime + j * profile.stepMs)]!;
    const sd = VOL_RANGE_POLICY.z50 * Math.sqrt(profile.scale * level * cum);
    if (!Number.isFinite(Math.exp(sd))) return null;
    bull.push(Math.exp(sd) - 1); bear.push(Math.exp(-sd) - 1);
  }
  return { bull, bear };
}

/** Band at the end of a longer history (the forecast's whole feed), or null when it cannot be drawn. */
export function seasonalBandAt(history: readonly StructuralBar[], profile: VolRangeProfile | null | undefined, horizonBars: number): { bull: number[]; bear: number[] } | null {
  if (!profile || !history.length || !validProfile(profile) || profile.fittedThrough > history.at(-1)!.closeTime
    || history.some((b,i)=>!validBar(b) || b.closeTime-b.openTime!==profile.stepMs || (i>0 && b.openTime<history[i-1]!.closeTime))) return null;
  const levels = deseasonalisedLevels(history, profile);
  return seasonalVolatilityBand(levels[levels.length - 1]!, history.at(-1)!.openTime, profile, horizonBars);
}
