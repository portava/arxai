// Real-data validation runner: every strategyEngine family, every instrument,
// walk-forward + purged/embargoed CPCV + Deflated Sharpe + PBO + one
// Benjamini–Hochberg pass over the ENTIRE search.
//
// WHAT THIS ADDS OVER THE V75 KILLER TEST
// ---------------------------------------
// The killer test (validationFactoryTest §7e) proves the factory certifies
// nothing on a substrate where the right answer is KNOWN to be "no edge". It
// cannot say anything about real markets. This runner points the same machinery
// at real history (a hash-pinned fixture, or stored market_candles /
// broker_candles) and reports what survives — expected: little or nothing.
//
// It also adds the piece the factory alone does not test: SELECTION. The
// factory scores each fixed-rule variant; walk-forward here re-selects the best
// variant of each family on an expanding, purged+embargoed training window and
// scores ONLY the next, unseen window. The pooled out-of-sample series is the
// honest record of "pick the best-looking parameters, then trade them".
//
// MULTIPLICITY IS CHARGED FOR THE WHOLE SEARCH
// --------------------------------------------
// m for Benjamini–Hochberg, and nTrials for the Deflated Sharpe, are the TOTAL
// number of tests in the run: every variant on every instrument plus every
// walk-forward selection series. Choosing the instrument is a trial too.
//
// COSTS
// -----
// Returns are net of a per-unit-turnover cost by asset class (parameters, hashed
// into the run). A position flip from −1 to +1 is two units of turnover.
//
// WHAT IT CANNOT DO
// -----------------
// It never proposes beyond SHADOW and never sets liveAllowed: every survivor is
// emitted with `promotionCeiling: "SHADOW"` and `liveAllowed: false` literals,
// and this file contains no other value for either.
//
// Pure: no I/O, no clock, no randomness except the SEEDED positive control.

import { createHash } from "node:crypto";
import {
  allStrategyVariants,
  strategyReturns,
  validateFamily,
  cpcvSplits,
  deflatedSharpe,
  sharpe,
  skewness,
  kurtosis,
  stdev,
  seeded,
  FAMILY_KEYS,
  DEFAULT_THRESHOLDS,
  type Bar,
  type CpcvOptions,
  type CpcvSplit,
  type StrategyVariant,
  type TrialResult,
  type ValidationThresholds,
} from "@workspace/validation";
import { controlFdr, sharpePValue, stableStringify } from "@workspace/discovery";

export const REAL_DATA_RUNNER_VERSION = "arx-real-data-validation-v1";

export type AssetClass = "fx" | "crypto" | "metal" | "index";

export interface RunnerInstrument {
  symbol: string;
  assetClass: AssetClass;
  /** "close_only" ⇒ high/low are DERIVED; wick-dependent families are flagged. */
  ohlc: "ohlc" | "close_only";
  /** Where the bars came from (fixture file, market_candles, broker_candles…). */
  source: string;
  dates: string[];
  bars: Bar[];
  /** Annualisation for REPORTING only; defaults to params.barsPerYear[assetClass] (daily). */
  barsPerYear?: number;
}

export interface RunnerParams {
  cpcv: Omit<CpcvOptions, "nObs">;
  walkForward: { folds: number; minTrainFraction: number; horizon: number; embargo: number };
  thresholds: ValidationThresholds;
  pboBlocks: number;
  fdrQ: number;
  /** Cost per unit of position turnover, as a log-return fraction. */
  costPerTurnover: Record<AssetClass, number>;
  /** Bars per year for annualised reporting only (never used in a test). */
  barsPerYear: Record<AssetClass, number>;
  lookaheadSamples: number;
}

export const DEFAULT_RUNNER_PARAMS: RunnerParams = {
  cpcv: { nGroups: 6, p: 2, horizon: 5, embargo: 5 },
  walkForward: { folds: 5, minTrainFraction: 0.4, horizon: 5, embargo: 5 },
  thresholds: DEFAULT_THRESHOLDS,
  pboBlocks: 10,
  fdrQ: 0.05,
  // Conservative round-trip-ish costs on DAILY bars: 1bp FX, 10bp crypto
  // (spot taker fee alone), 5bp gold proxy, 2bp index.
  costPerTurnover: { fx: 0.0001, crypto: 0.001, metal: 0.0005, index: 0.0002 },
  barsPerYear: { fx: 252, crypto: 365, metal: 365, index: 252 },
  lookaheadSamples: 8,
};

/** Families whose decision reads the bar's high/low/open beyond the close. */
export const WICK_DEPENDENT_FAMILIES: readonly string[] = [
  "BreakOfStructure", "LiquiditySweepReversal", "VolatilityExpansion",
  "PullbackContinuation", "MeanReversion", "SessionBreakout",
];

export interface PlantedEdgeSpec {
  symbol: string;
  familyKey: string;
  /** Probability the planted position has the sign of the next return. */
  hitRate: number;
  seed: number;
}

export interface VariantResult {
  key: string;
  familyKey: string;
  symbol: string;
  bars: number;
  activeBars: number;
  turnover: number;
  netSharpe: number;
  annualisedSharpe: number;
  oosSharpe: number;
  dsr: number;
  pbo: number;
  pValue: number;
  factoryVerdict: "PASS" | "REJECT";
  fdrCertified: boolean;
  survivor: boolean;
  vetoes: string[];
  rangesDerived: boolean;
  planted: boolean;
}

export interface WalkForwardFold { trainEnd: number; testStart: number; testEnd: number; selected: string; trainSharpe: number; testSharpe: number }

export interface WalkForwardResult {
  key: string;
  symbol: string;
  familyKey: string;
  folds: WalkForwardFold[];
  oosBars: number;
  oosSharpe: number;
  annualisedSharpe: number;
  dsr: number;
  pValue: number;
  fdrCertified: boolean;
  survivor: boolean;
  vetoes: string[];
}

export interface HonestyChecks {
  cpcvSplitsChecked: number;
  cpcvViolations: number;
  walkForwardFoldsChecked: number;
  walkForwardViolations: number;
  lookaheadVariantsChecked: number;
  lookaheadViolations: string[];
  fdrFamilySize: number;
  dsrTrialsCharged: number;
  /** Run-wide spread of per-bar Sharpe ratios used as the DSR null field. */
  dsrTrialSharpeSd: number;
  testsSupplied: number;
}

export interface Survivor {
  key: string;
  kind: "variant" | "walk_forward";
  symbol: string;
  familyKey: string;
  annualisedSharpe: number;
  dsr: number;
  pbo: number | null;
  pValue: number;
  /** Hard ceiling. A survivor here may at most be PROPOSED for SHADOW. */
  promotionCeiling: "SHADOW";
  liveAllowed: false;
}

export interface RealDataRunResult {
  runnerVersion: typeof REAL_DATA_RUNNER_VERSION;
  datasetHash: string;
  paramsHash: string;
  params: RunnerParams;
  instruments: Array<{ symbol: string; assetClass: AssetClass; ohlc: string; source: string; bars: number; first: string; last: string; barsPerYear: number }>;
  families: string[];
  variants: VariantResult[];
  walkForward: WalkForwardResult[];
  fdr: { q: number; familySize: number; rejections: number; threshold: number | null };
  survivors: Survivor[];
  summary: Array<{ symbol: string; familyKey: string; variants: number; activeVariants: number; survivors: number;
    bestKey: string; bestAnnualisedSharpe: number; bestDsr: number; pbo: number; walkForwardAnnualisedSharpe: number;
    walkForwardSurvivor: boolean; rangesDerived: boolean }>;
  checks: HonestyChecks;
  validationReportHashes: string[];
  planted: PlantedEdgeSpec | null;
  /** sha256 over everything above — the result identity. */
  resultHash: string;
}

const sha256 = (s: string) => createHash("sha256").update(s, "utf8").digest("hex");
const r10 = (x: number) => (Number.isFinite(x) ? Number(x.toFixed(10)) : x);

/** Net per-bar returns: position at i earns i→i+1, minus turnover cost charged when the position changes at i. */
export function netReturns(positions: readonly number[], closes: readonly number[], costPerTurnover: number): { returns: number[]; turnover: number } {
  const gross = strategyReturns(positions, closes);
  let turnover = 0;
  const out = gross.map((g, i) => {
    const prev = i === 0 ? 0 : positions[i - 1]!;
    const dt = Math.abs(positions[i]! - prev);
    turnover += dt;
    return g - dt * costPerTurnover;
  });
  return { returns: out, turnover };
}

// ── Honesty verifiers ───────────────────────────────────────────────────────

/**
 * Independently re-check a CPCV split: no training index may have a label
 * window [i, i+horizon) touching the test set (purge), and none may sit within
 * `embargo` bars after the end of a contiguous test block (embargo).
 * Recomputed from the index sets alone — it does not trust the split's counters.
 */
export function cpcvIsolationViolations(split: CpcvSplit, nObs: number, horizon: number, embargo: number): number {
  const inTest = new Uint8Array(nObs);
  for (const i of split.testIdx) inTest[i] = 1;
  const blockEnds: number[] = [];
  for (let i = 0; i < nObs; i++) if (inTest[i] && (i + 1 === nObs || !inTest[i + 1])) blockEnds.push(i + 1);
  let violations = 0;
  for (const t of split.trainIdx) {
    if (inTest[t]) { violations++; continue; }
    let leak = false;
    for (let j = t; j < Math.min(nObs, t + horizon); j++) if (inTest[j]) { leak = true; break; }
    if (!leak) for (const e of blockEnds) if (t >= e && t < e + embargo) { leak = true; break; }
    if (leak) violations++;
  }
  return violations;
}

/** Walk-forward folds must leave horizon+embargo bars between train end and test start. */
export function walkForwardViolations(folds: readonly WalkForwardFold[], horizon: number, embargo: number): number {
  return folds.filter((f) => !(f.trainEnd + horizon + embargo <= f.testStart && f.testStart < f.testEnd)).length;
}

/**
 * Prefix invariance: the position a variant takes at bar i must be identical
 * whether it sees bars[0..i] or the whole series. Any difference means the
 * signal read a future bar. Checked at deterministic sample indices.
 */
export function lookaheadViolation(v: Pick<StrategyVariant, "positions">, bars: readonly Bar[], samples: number): number | null {
  const full = v.positions(bars);
  const n = bars.length;
  for (let s = 1; s <= samples; s++) {
    const i = Math.floor((n - 2) * (s / (samples + 1)));
    const prefix = v.positions(bars.slice(0, i + 1));
    if (prefix[i] !== full[i]) return i;
  }
  return null;
}

/** Walk-forward fold boundaries over nObs returns. */
export function walkForwardFolds(nObs: number, wf: RunnerParams["walkForward"]): Array<{ trainEnd: number; testStart: number; testEnd: number }> {
  const out: Array<{ trainEnd: number; testStart: number; testEnd: number }> = [];
  const first = Math.floor(nObs * wf.minTrainFraction);
  const span = nObs - first;
  for (let k = 0; k < wf.folds; k++) {
    const testStart = first + Math.floor((span * k) / wf.folds);
    const testEnd = first + Math.floor((span * (k + 1)) / wf.folds);
    out.push({ trainEnd: testStart - wf.horizon - wf.embargo, testStart, testEnd });
  }
  return out;
}

/** Seeded planted edge: position has the sign of the NEXT return with probability hitRate. */
export function plantedEdgeReturns(closes: readonly number[], spec: PlantedEdgeSpec, costPerTurnover: number): number[] {
  const rnd = seeded(spec.seed);
  const positions: number[] = [];
  for (let i = 0; i < closes.length; i++) {
    const next = i + 1 < closes.length ? Math.sign(closes[i + 1]! - closes[i]!) : 0;
    positions.push(rnd() < spec.hitRate ? next : -next);
  }
  return netReturns(positions, closes, costPerTurnover).returns;
}

export function paramsHashOf(params: RunnerParams): string {
  return sha256(stableStringify({ runnerVersion: REAL_DATA_RUNNER_VERSION, params }));
}

// ── The run ────────────────────────────────────────────────────────────────

export function runRealDataValidation(opts: {
  instruments: readonly RunnerInstrument[];
  datasetHash: string;
  params?: RunnerParams;
  planted?: PlantedEdgeSpec;
}): RealDataRunResult {
  const params = opts.params ?? DEFAULT_RUNNER_PARAMS;
  const variantsTemplate = allStrategyVariants();
  const families = [...new Set(variantsTemplate.map((v) => v.familyKey))];
  if (!FAMILY_KEYS.every((f) => families.includes(f))) throw new Error("runner: a strategyEngine family is missing from the grid");

  const checks: HonestyChecks = {
    cpcvSplitsChecked: 0, cpcvViolations: 0, walkForwardFoldsChecked: 0, walkForwardViolations: 0,
    lookaheadVariantsChecked: 0, lookaheadViolations: [], fdrFamilySize: 0, dsrTrialsCharged: 0, dsrTrialSharpeSd: 0, testsSupplied: 0,
  };

  // Total multiplicity, fixed BEFORE any result exists: every variant on every
  // instrument, one walk-forward series per (instrument, family), + planted.
  const nWf = opts.instruments.length * families.length;
  const nVariantTests = opts.instruments.length * variantsTemplate.length + (opts.planted ? 1 : 0);
  const m = nVariantTests + nWf;

  interface Pending { trial: TrialResult; symbol: string; activeBars: number; turnover: number; rangesDerived: boolean; planted: boolean; ppy: number }
  const pendingByFamily = new Map<string, Pending[]>();
  const wfSeries: Array<{ key: string; symbol: string; familyKey: string; folds: WalkForwardFold[]; returns: number[]; ppy: number }> = [];

  for (const inst of opts.instruments) {
    const closes = inst.bars.map((b) => b.close);
    const cost = params.costPerTurnover[inst.assetClass];
    const ppy = inst.barsPerYear ?? params.barsPerYear[inst.assetClass];
    const perFamily = new Map<string, Pending[]>();
    for (const v of variantsTemplate) {
      const la = lookaheadViolation(v, inst.bars, params.lookaheadSamples);
      checks.lookaheadVariantsChecked++;
      if (la !== null) checks.lookaheadViolations.push(`${inst.symbol}:${v.key}@${la}`);
      const pos = v.positions(inst.bars);
      const { returns, turnover } = netReturns(pos, closes, cost);
      const p: Pending = {
        trial: { key: `${inst.symbol}:${v.key}`, familyKey: v.familyKey, returns },
        symbol: inst.symbol, activeBars: pos.filter((x) => x !== 0).length, turnover,
        rangesDerived: inst.ohlc === "close_only" && WICK_DEPENDENT_FAMILIES.includes(v.familyKey),
        planted: false, ppy,
      };
      const list = perFamily.get(v.familyKey) ?? [];
      list.push(p);
      perFamily.set(v.familyKey, list);
    }
    if (opts.planted && opts.planted.symbol === inst.symbol) {
      const list = perFamily.get(opts.planted.familyKey);
      if (!list) throw new Error(`planted family ${opts.planted.familyKey} unknown`);
      list.unshift({
        trial: { key: `${inst.symbol}:PLANTED_EDGE`, familyKey: opts.planted.familyKey, returns: plantedEdgeReturns(closes, opts.planted, cost) },
        symbol: inst.symbol, activeBars: closes.length - 1, turnover: NaN, rangesDerived: false, planted: true, ppy,
      });
    }

    // Walk-forward selection per family, on purged+embargoed expanding windows.
    const nObs = closes.length - 1;
    const foldBounds = walkForwardFolds(nObs, params.walkForward);
    for (const [familyKey, list] of perFamily) {
      const real = list.filter((x) => !x.planted); // the selector never sees the planted control
      const folds: WalkForwardFold[] = [];
      const oos: number[] = [];
      for (const fb of foldBounds) {
        let best = real[0]!;
        let bestSr = -Infinity;
        for (const c of real) {
          const sr = sharpe(c.trial.returns.slice(0, Math.max(0, fb.trainEnd)));
          const s = Number.isFinite(sr) ? sr : -Infinity;
          if (s > bestSr) { bestSr = s; best = c; }
        }
        const test = best.trial.returns.slice(fb.testStart, fb.testEnd);
        oos.push(...test);
        folds.push({ ...fb, selected: best.trial.key, trainSharpe: r10(bestSr), testSharpe: r10(sharpe(test)) });
      }
      checks.walkForwardFoldsChecked += folds.length;
      checks.walkForwardViolations += walkForwardViolations(folds, params.walkForward.horizon, params.walkForward.embargo);
      wfSeries.push({ key: `${inst.symbol}:${familyKey}:WALK_FORWARD`, symbol: inst.symbol, familyKey, folds, returns: oos, ppy });

      const fam = `${inst.symbol}:${familyKey}`;
      pendingByFamily.set(fam, list);
    }

    // CPCV isolation, verified independently on this instrument's split geometry.
    for (const split of cpcvSplits({ ...params.cpcv, nObs })) {
      checks.cpcvSplitsChecked++;
      checks.cpcvViolations += cpcvIsolationViolations(split, nObs, params.cpcv.horizon, params.cpcv.embargo);
    }
  }

  // The DSR's null field is the WHOLE search: the spread of Sharpe ratios over
  // every trial in the run (planted control included — it is one trial of m).
  const allTrials = [...pendingByFamily.values()].flat();
  const runTrialSharpeSd = stdev(allTrials.map((p) => sharpe(p.trial.returns)).filter(Number.isFinite));
  checks.dsrTrialSharpeSd = r10(runTrialSharpeSd);

  // Factory validation per (instrument, family), charged for the WHOLE run.
  const variants: VariantResult[] = [];
  const reportHashes: string[] = [];
  let prevHash = "0".repeat(64);
  for (const [fam, list] of pendingByFamily) {
    const report = validateFamily(fam, list.map((x) => x.trial), {
      cpcv: params.cpcv, thresholds: params.thresholds, pboBlocks: params.pboBlocks, prevHash, chargedTrials: m,
      trialSharpeSd: runTrialSharpeSd,
    });
    prevHash = report.reportHash;
    reportHashes.push(report.reportHash);
    checks.dsrTrialsCharged = Math.max(checks.dsrTrialsCharged, report.nTrials);
    report.candidates.forEach((c, i) => {
      const p = list[i]!;
      const ppy = p.ppy;
      const net = sharpe(p.trial.returns);
      variants.push({
        key: c.key, familyKey: c.familyKey, symbol: p.symbol, bars: p.trial.returns.length,
        activeBars: p.activeBars, turnover: p.turnover,
        netSharpe: r10(net), annualisedSharpe: r10(net * Math.sqrt(ppy)),
        oosSharpe: r10(c.oosSharpe), dsr: r10(c.dsr), pbo: r10(c.pbo),
        pValue: sharpePValue(c.oosSharpe, p.trial.returns.length),
        factoryVerdict: c.verdict, fdrCertified: false, survivor: false, vetoes: [...c.vetoes],
        rangesDerived: p.rangesDerived, planted: p.planted,
      });
    });
  }

  // Walk-forward series: DSR charged for the same m, against the spread of all variant Sharpes.
  const walkForward: WalkForwardResult[] = wfSeries.map((w) => {
    const sr = sharpe(w.returns);
    const d = deflatedSharpe({ observedSharpe: sr, trackLength: w.returns.length, skew: skewness(w.returns),
      kurtosis: kurtosis(w.returns), nTrials: m, trialSharpeSd: runTrialSharpeSd });
    const vetoes: string[] = [];
    if (!(sr > 0)) vetoes.push(`WF_OOS_NOT_POSITIVE (${sr.toFixed(4)})`);
    if (!(d.dsr >= params.thresholds.minDsr)) vetoes.push(`DSR_BELOW_THRESHOLD (${d.dsr.toFixed(4)} < ${params.thresholds.minDsr})`);
    return {
      key: w.key, symbol: w.symbol, familyKey: w.familyKey, folds: w.folds, oosBars: w.returns.length,
      oosSharpe: r10(sr), annualisedSharpe: r10(sr * Math.sqrt(w.ppy)),
      dsr: r10(d.dsr), pValue: sharpePValue(sr, w.returns.length), fdrCertified: false, survivor: false, vetoes,
    };
  });

  // ONE Benjamini–Hochberg pass over every test in the run.
  const tests = [...variants.map((v) => ({ key: v.key, p: v.pValue })), ...walkForward.map((w) => ({ key: w.key, p: w.pValue }))];
  checks.testsSupplied = tests.length;
  const fdr = controlFdr(tests, params.fdrQ, m);
  checks.fdrFamilySize = fdr.familySize;
  const certified = new Set(fdr.decisions.filter((d) => d.rejected).map((d) => d.key));
  const fdrVeto = `FDR_NOT_CERTIFIED (q=${params.fdrQ}, m=${m})`;
  for (const v of variants) {
    v.fdrCertified = certified.has(v.key);
    if (!v.fdrCertified) v.vetoes.push(fdrVeto);
    v.survivor = v.factoryVerdict === "PASS" && v.fdrCertified;
  }
  for (const w of walkForward) {
    w.fdrCertified = certified.has(w.key);
    if (!w.fdrCertified) w.vetoes.push(fdrVeto);
    w.survivor = w.vetoes.length === 0;
  }

  const survivors: Survivor[] = [
    ...variants.filter((v) => v.survivor).map((v) => ({
      key: v.key, kind: "variant" as const, symbol: v.symbol, familyKey: v.familyKey,
      annualisedSharpe: v.annualisedSharpe, dsr: v.dsr, pbo: v.pbo, pValue: v.pValue,
      promotionCeiling: "SHADOW" as const, liveAllowed: false as const,
    })),
    ...walkForward.filter((w) => w.survivor).map((w) => ({
      key: w.key, kind: "walk_forward" as const, symbol: w.symbol, familyKey: w.familyKey,
      annualisedSharpe: w.annualisedSharpe, dsr: w.dsr, pbo: null, pValue: w.pValue,
      promotionCeiling: "SHADOW" as const, liveAllowed: false as const,
    })),
  ];

  const summary = opts.instruments.flatMap((inst) => families.map((familyKey) => {
    const vs = variants.filter((v) => v.symbol === inst.symbol && v.familyKey === familyKey && !v.planted);
    const best = [...vs].sort((a, b) => b.dsr - a.dsr || b.annualisedSharpe - a.annualisedSharpe)[0]!;
    const wf = walkForward.find((w) => w.symbol === inst.symbol && w.familyKey === familyKey)!;
    return {
      symbol: inst.symbol, familyKey, variants: vs.length, activeVariants: vs.filter((v) => v.activeBars > 0).length,
      survivors: vs.filter((v) => v.survivor).length, bestKey: best.key,
      bestAnnualisedSharpe: best.annualisedSharpe, bestDsr: best.dsr, pbo: best.pbo,
      walkForwardAnnualisedSharpe: wf.annualisedSharpe, walkForwardSurvivor: wf.survivor,
      rangesDerived: vs.some((v) => v.rangesDerived),
    };
  }));

  const body: Omit<RealDataRunResult, "resultHash"> = {
    runnerVersion: REAL_DATA_RUNNER_VERSION,
    datasetHash: opts.datasetHash,
    paramsHash: paramsHashOf(params),
    params,
    instruments: opts.instruments.map((i) => ({ symbol: i.symbol, assetClass: i.assetClass, ohlc: i.ohlc, source: i.source,
      bars: i.bars.length, first: i.dates[0]!, last: i.dates.at(-1)!,
      barsPerYear: i.barsPerYear ?? params.barsPerYear[i.assetClass] })),
    families,
    variants,
    walkForward,
    fdr: { q: fdr.q, familySize: fdr.familySize, rejections: fdr.rejections, threshold: fdr.threshold },
    survivors,
    summary,
    checks,
    validationReportHashes: reportHashes,
    planted: opts.planted ?? null,
  };
  return { ...body, resultHash: sha256(stableStringify(body)) };
}
