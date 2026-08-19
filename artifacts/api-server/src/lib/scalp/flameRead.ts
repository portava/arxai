// Ruby Flame Scalp — flame-reading core (pure, deterministic).
//
// A "flame" is a running momentum burst. This module reads the live candle
// window and the current price geometry to answer the human questions a scalper
// actually asks: Is momentum igniting or burning out? Am I early or chasing?
// Is there room left to a target? Is the burst going stale? It produces ONLY
// the structured read — it never sizes a trade and never touches a safety gate.
//
// HARD RULES honoured here:
//  - No candle window (or too few candles) => an honest BLIND read: every flame
//    field is NONE/UNKNOWN. Nothing is fabricated, ever.
//  - Risk personality tunes THRESHOLDS ONLY. It can make a read stricter or
//    looser, but it can never weaken a safety/economic gate in the engine.
//  - All copy is plain English — no internal names, codes, or jargon.

import type {
  ChaseRisk,
  EntryTiming,
  ExecutionQuality,
  FlameFreshness,
  FlameStage,
  HtfContext,
  RiskPersonality,
  Runway,
  RunOnTrace,
  ScalpCandle,
  ScalpDirection,
  ScalpExecutionInput,
  ScalpFlameRead,
  ScalpReadDirection,
  ScalpReadStatus,
  ScalpSetupType,
} from "./scalpTypes.js";

/** Minimum candles before we trust a flame read. Fewer => blind. */
const MIN_FLAME_CANDLES = 5;
/** Window we read momentum over (most recent N). */
const FLAME_WINDOW = 14;
/** Heartbeat freshness mirrors the live gate (15s) for execution-quality bands. */
const HEARTBEAT_FRESH_S = 15;
const HEARTBEAT_EXCELLENT_S = 4;
const HEARTBEAT_GOOD_S = 8;

interface PersonalityProfile {
  /** scalpScore at/above which a clean READY can be STRONG. */
  strongMinScore: number;
  /** scalpScore at/above which an actionable read can be POSSIBLE. */
  possibleMinScore: number;
  /** lateFraction toward target at which timing becomes CHASING. */
  chaseLateFraction: number;
  /** run extension in ATRs at which the flame is STRETCH (overextended). */
  stretchAtr: number;
  /** whether a one-candle ("one-stick") ignition may be tradeable without EXCELLENT execution. */
  allowOneStick: boolean;
  /** how a counter-trend flame is treated. */
  counterTrend: "BLOCK" | "MIXED" | "ALLOW";
}

const PERSONALITY: Record<RiskPersonality, PersonalityProfile> = {
  CONSERVATIVE: { strongMinScore: 80, possibleMinScore: 66, chaseLateFraction: 0.45, stretchAtr: 2.5, allowOneStick: false, counterTrend: "BLOCK" },
  BALANCED: { strongMinScore: 74, possibleMinScore: 60, chaseLateFraction: 0.6, stretchAtr: 3.5, allowOneStick: false, counterTrend: "MIXED" },
  AGGRESSIVE: { strongMinScore: 68, possibleMinScore: 54, chaseLateFraction: 0.75, stretchAtr: 4.5, allowOneStick: false, counterTrend: "ALLOW" },
  OWNER_ADMIN: { strongMinScore: 64, possibleMinScore: 50, chaseLateFraction: 0.85, stretchAtr: 6, allowOneStick: true, counterTrend: "ALLOW" },
};

export function personalityProfile(p: RiskPersonality): PersonalityProfile {
  return PERSONALITY[p];
}

function mean(xs: number[]): number {
  if (xs.length === 0) return 0;
  return xs.reduce((a, b) => a + b, 0) / xs.length;
}

function fmt(v: number, digits: number): string {
  return v.toFixed(Math.max(0, Math.min(8, digits)));
}

export interface FlameReadArgs {
  direction: ScalpDirection;
  candles: ScalpCandle[] | null;
  price: number;
  point: number;
  spreadPrice: number;
  stopDist: number;
  mainTpDist: number;
  quickTpDist: number;
  /** Fraction of entry→TP already travelled (engine geometry). */
  lateFraction: number;
  inZone: boolean;
  execution: ScalpExecutionInput | null;
  htfBias: "bullish" | "bearish" | "neutral" | null;
  personality: RiskPersonality;
  scannerReason: string | null;
  scannerSetupType: string | null;
  invalidationPrice: number;
  quickTpPrice: number;
  mainTpPrice: number;
  digits: number;
}

export interface FlameReadCore {
  /** scalpStatus / readDirection are placeholders here; the engine finalizes them. */
  read: ScalpFlameRead;
  /** Additive adjustment to fold into the shared quality score. */
  scoreAdjust: number;
  /** Status downgrade the engine should apply (only honoured when not blind). */
  downgrade: { kind: "NO_SCALP" | "LATE" | "FORMING" | null; reason: string | null };
  blind: boolean;
}

/** Execution-quality band from bridge/EA freshness + spread spike + latency. */
function readExecutionQuality(
  exec: ScalpExecutionInput | null,
  specSpreadPoints: number | null,
): ExecutionQuality {
  if (!exec) return "FAIR"; // unknown — honest middle; never EXCELLENT (blocks one-stick).
  if (exec.bridgeConnected === false) return "POOR";
  const age = exec.heartbeatAgeSeconds;
  let band: ExecutionQuality = "GOOD";
  if (age == null) {
    band = "FAIR";
  } else if (age > HEARTBEAT_FRESH_S * 2) {
    return "BLOCKED";
  } else if (age > HEARTBEAT_FRESH_S) {
    band = "POOR";
  } else if (age > HEARTBEAT_GOOD_S) {
    band = "FAIR";
  } else if (age <= HEARTBEAT_EXCELLENT_S) {
    band = "EXCELLENT";
  }
  // Spread spike: live spread far above the broker's typical => downgrade.
  if (exec.liveSpreadPoints != null && specSpreadPoints != null && specSpreadPoints > 0) {
    const ratio = exec.liveSpreadPoints / specSpreadPoints;
    if (ratio >= 3) return "POOR";
    if (ratio >= 1.8) band = band === "EXCELLENT" ? "GOOD" : band === "GOOD" ? "FAIR" : band;
  }
  if (exec.latencyMs != null && exec.latencyMs > 800) {
    band = band === "EXCELLENT" ? "GOOD" : band === "GOOD" ? "FAIR" : "POOR";
  }
  return band;
}

function rank(q: ExecutionQuality): number {
  return { BLOCKED: 0, POOR: 1, FAIR: 2, GOOD: 3, EXCELLENT: 4 }[q];
}

/** Build a blind read (no candle window) — honest NONE everywhere. */
export function blindFlameRead(
  personality: RiskPersonality,
  opts: { scannerReason?: string | null; execution?: ScalpExecutionInput | null; specSpreadPoints?: number | null } = {},
): ScalpFlameRead {
  const executionQuality = readExecutionQuality(opts.execution ?? null, opts.specSpreadPoints ?? null);
  return {
    scalpStatus: "NOT_A_SCALP",
    readDirection: "NO_SCALP",
    scalpScore: 0,
    flameStage: "NONE",
    flameAgeCandles: 0,
    freshness: "ACTIVE",
    entryTiming: "NO_ENTRY",
    chaseRisk: "LOW",
    runway: "NONE",
    executionQuality,
    htfContext: "UNKNOWN",
    setupType: "NO_SCALP",
    riskPersonality: personality,
    whyNow: null,
    entryTrigger: null,
    targetIdea: null,
    invalidationIdea: null,
    decayNote: null,
    blind: true,
  };
}

interface Metrics {
  atr: number;
  age: number;
  extension: number;   // ATRs travelled over the run
  bodyExpanding: boolean;
  bodyContracting: boolean;
  lastCloseLoc: number; // 0..1 directional close location of last candle (1 = strong in flame dir)
  opposingWickRatio: number; // opposing wick / body of last candle
  lastOpposes: boolean; // last candle closed against the flame with a real body
  brokeBackThroughOrigin: boolean; // a prior burst that reversed past its start
  newExtreme: boolean; // last candle made a fresh window extreme in flame dir
  driftAtr: number;    // signed full-window drift in ATRs (+ = up)
  // ── Run-on momentum metrics (populated for any age >= 1; 0 when no run) ─────
  /** Average body overlap ratio between consecutive run candles. 0 = tight staircase, 1 = full chop. */
  overlapScore: number;
  /** Worst opposing-wick / body ratio across ALL run candles (not just the last). */
  maxRunOpposingWickRatio: number;
  /** Fraction of run candles whose body closes in the flame direction AND body > 40% of range. */
  runBodyConsistency: number;
  /** Average body-to-range ratio across run candles (higher = stronger directional candles). */
  runBodyStrength: number;
}

function computeMetrics(all: ScalpCandle[], dirSign: number, point: number): Metrics {
  const candles = all.slice(-FLAME_WINDOW);
  const n = candles.length;
  const closes = candles.map((c) => c.close);
  const ranges = candles.map((c) => Math.max(c.high - c.low, 0));
  const bodies = candles.map((c) => Math.abs(c.close - c.open));
  const atr = Math.max(mean(ranges), point);

  // Flame age: trailing close-to-close steps in the flame direction.
  let age = 0;
  for (let i = n - 1; i >= 1; i--) {
    const step = closes[i] - closes[i - 1];
    if (Math.sign(step) === dirSign && Math.abs(step) > atr * 0.05) age++;
    else break;
  }
  const runStart = Math.max(0, n - 1 - age);
  const runMove = (closes[n - 1] - closes[runStart]) * dirSign;
  const extension = Math.max(0, runMove / atr);

  const last = candles[n - 1];
  const lastBody = Math.max(bodies[n - 1], point * 0.01);
  const priorBodies = bodies.slice(0, n - 1);
  const priorAvgBody = priorBodies.length ? mean(priorBodies) : lastBody;
  const bodyExpanding = lastBody > priorAvgBody * 1.15;
  const bodyContracting = lastBody < priorAvgBody * 0.6;

  const lastRange = Math.max(last.high - last.low, point * 0.01);
  const lastCloseLoc =
    dirSign > 0 ? (last.close - last.low) / lastRange : (last.high - last.close) / lastRange;

  // Opposing wick of the last candle (the rejection tail against the flame).
  const upperWick = last.high - Math.max(last.open, last.close);
  const lowerWick = Math.min(last.open, last.close) - last.low;
  const opposingWick = dirSign > 0 ? upperWick : lowerWick;
  const opposingWickRatio = opposingWick / lastBody;

  const lastDir = Math.sign(last.close - last.open);
  const lastOpposes = lastDir === -dirSign && bodies[n - 1] > priorAvgBody * 0.8;

  // New extreme: last close beyond the prior window extreme in the flame dir.
  const priorCloses = closes.slice(0, n - 1);
  const priorExtreme =
    dirSign > 0 ? Math.max(...priorCloses, -Infinity) : Math.min(...priorCloses, Infinity);
  const newExtreme = dirSign > 0 ? last.close > priorExtreme : last.close < priorExtreme;

  // Failed burst: an earlier strong push in the flame dir that price gave back
  // past its origin (close now on the wrong side of where the push started).
  let brokeBackThroughOrigin = false;
  for (let i = n - 2; i >= Math.max(1, n - 6); i--) {
    const push = (closes[i] - closes[i - 1]) * dirSign;
    if (push > atr * 0.8) {
      const gaveBack = (closes[n - 1] - closes[i - 1]) * dirSign;
      if (gaveBack < 0) brokeBackThroughOrigin = true;
      break;
    }
  }

  const driftAtr = (closes[n - 1] - closes[0]) / atr;

  // ── Run-on momentum metrics ───────────────────────────────────────────────
  // These are always 0 when age === 0 (no run). With a run, we inspect the
  // candles in the trailing run window for quality signals.
  // runStart is already declared above (used for extension calc — same window).

  // Overlap score: average body-overlap ratio between consecutive run candles.
  // 0 = tight staircase (each opens near prev close), 1 = full body overlap (chop).
  let overlapScore = 0;
  if (age >= 2) {
    let totalOverlap = 0;
    let pairs = 0;
    for (let i = runStart + 1; i < n; i++) {
      const prev = candles[i - 1]!;
      const curr = candles[i]!;
      const prevBodyHi = Math.max(prev.open, prev.close);
      const prevBodyLo = Math.min(prev.open, prev.close);
      const currBodyHi = Math.max(curr.open, curr.close);
      const currBodyLo = Math.min(curr.open, curr.close);
      const prevBodySize = Math.max(prevBodyHi - prevBodyLo, point * 0.001);
      const overlapAmt = Math.max(0, Math.min(prevBodyHi, currBodyHi) - Math.max(prevBodyLo, currBodyLo));
      totalOverlap += overlapAmt / prevBodySize;
      pairs++;
    }
    overlapScore = pairs > 0 ? Math.min(1, totalOverlap / pairs) : 0;
  }

  // Max opposing-wick ratio across actual run candles (worst rejection tail seen).
  // Start at runStart+1 to skip the pre-run anchor candle (which may have body≈0
  // and would produce a spuriously huge wick ratio, triggering a false WEAKENING).
  const runFirstIdx = runStart + 1;
  let maxRunOpposingWickRatio = 0;
  for (let i = runFirstIdx; i < n; i++) {
    const c = candles[i]!;
    const cBody = Math.max(Math.abs(c.close - c.open), point * 0.01);
    const oppWick = dirSign > 0
      ? c.high - Math.max(c.open, c.close)   // upper wick for BUY
      : Math.min(c.open, c.close) - c.low;   // lower wick for SELL
    maxRunOpposingWickRatio = Math.max(maxRunOpposingWickRatio, oppWick / cBody);
  }

  // Body consistency: fraction of run candles that close in flame direction with body > 40% range.
  // Body strength: average body-to-range ratio across run candles.
  // Again start at runFirstIdx to skip the pre-run anchor candle.
  let runBodyConsistency = 0;
  let runBodyStrength = 0;
  {
    const runLen = n - runFirstIdx;
    if (runLen > 0) {
      let strongCount = 0;
      let totalBodyRatio = 0;
      for (let i = runFirstIdx; i < n; i++) {
        const c = candles[i]!;
        const cRange = Math.max(c.high - c.low, point * 0.01);
        const cBody = Math.abs(c.close - c.open);
        const bodyRatio = cBody / cRange;
        const closesInDir = (c.close - c.open) * dirSign > 0;
        if (closesInDir && bodyRatio > 0.4) strongCount++;
        totalBodyRatio += bodyRatio;
      }
      runBodyConsistency = strongCount / runLen;
      runBodyStrength = totalBodyRatio / runLen;
    }
  }

  return {
    atr,
    age,
    extension,
    bodyExpanding,
    bodyContracting,
    lastCloseLoc,
    opposingWickRatio,
    lastOpposes,
    brokeBackThroughOrigin,
    newExtreme,
    driftAtr,
    overlapScore,
    maxRunOpposingWickRatio,
    runBodyConsistency,
    runBodyStrength,
  };
}

/**
 * Composite run-on quality score (0..1).
 *
 * 0.5 = neutral baseline. Adjusted by:
 *   - Body quality (consistency + strength): ±0.15/0.12
 *   - Close location of last candle: ±0.10/0.15
 *   - Overlap penalty (chop): up to −0.35
 *   - Opposing-wick penalty across run: up to −0.25
 *   - New-extreme bonus: +0.05
 *
 * Used for scoreAdjust (±6 points) and the admin RunOnTrace.
 * Never fabricated: returns 0 when age === 0.
 */
function computeRunOnQuality(m: Metrics): number {
  if (m.age === 0) return 0;

  let q = 0.5;

  // Body quality
  q += (m.runBodyConsistency - 0.5) * 0.30; // −0.15 to +0.15
  q += (m.runBodyStrength - 0.4) * 0.20;    // adjusted around 0.4 baseline

  // Last candle close position in the flame direction
  if (m.lastCloseLoc >= 0.75) q += 0.10;
  else if (m.lastCloseLoc < 0.35) q -= 0.15;

  // Chop penalty: heavy overlap = vibration, not directional travel
  q -= m.overlapScore * 0.35; // 0 to −0.35

  // Opposing-wick penalty: worst rejection wick across the run
  q -= Math.min(0.25, m.maxRunOpposingWickRatio * 0.08);

  // New extreme: the run is still making progress
  if (m.newExtreme) q += 0.05;

  return Math.max(0, Math.min(1, q));
}

function classifyStage(m: Metrics, prof: PersonalityProfile): FlameStage {
  if (m.brokeBackThroughOrigin) return "FAILED";
  // Climactic exhaustion: big opposing tail after an extended run.
  if (m.age >= 2 && m.extension >= prof.stretchAtr * 0.8 && m.opposingWickRatio >= 1.5) return "EXHAUSTED";
  // Strong opposing candle after a real run => reversal risk.
  if (m.age >= 2 && m.lastOpposes) return "REVERSAL_RISK";
  if (m.age === 0) {
    // No trailing run in the flame direction.
    if (m.lastOpposes) return "REVERSAL_RISK";
    return "NONE";
  }
  if (m.extension >= prof.stretchAtr) return "STRETCH";
  // WEAKENING: classic body/wick signals OR run-on quality signals.
  // Chop guard: heavy body overlap across the run = vibration, not directional travel.
  // Deep-wick guard: large opposing wicks repeated across the run = structural rejection.
  const choppyRun = m.age >= 2 && m.overlapScore > 0.62;
  const heavyRejectionInRun = m.age >= 2 && m.maxRunOpposingWickRatio > 1.3;
  if (m.bodyContracting || m.lastCloseLoc < 0.4 || m.opposingWickRatio >= 1 || choppyRun || heavyRejectionInRun) return "WEAKENING";
  // RUN_ON: an established run (age >= 4) OR a young clean run (age 3) with
  // tight body overlap and consistent directional bodies. This allows the engine
  // to classify a 3-candle quality run as RUN_ON rather than waiting for age 4.
  const youngCleanRun = m.age >= 3 && m.overlapScore <= 0.50 && m.runBodyConsistency >= 0.40;
  if (youngCleanRun || m.age >= 4 || m.extension >= prof.stretchAtr * 0.6) return "RUN_ON";
  if (m.age <= 2 && (m.bodyExpanding || m.newExtreme) && m.lastCloseLoc >= 0.6) return "IGNITING";
  return "ACTIVE";
}

function freshnessFor(stage: FlameStage): FlameFreshness {
  switch (stage) {
    case "IGNITING": return "FRESH";
    case "ACTIVE": return "ACTIVE";
    case "RUN_ON": return "ACTIVE";
    case "STRETCH": return "LATE";
    case "WEAKENING": return "LATE";
    case "EXHAUSTED":
    case "FAILED":
    case "REVERSAL_RISK": return "EXPIRED";
    case "NONE": return "ACTIVE";
  }
}

function chaseRiskFor(lateFraction: number, extension: number, prof: PersonalityProfile, stage: FlameStage): ChaseRisk {
  const norm = Math.max(lateFraction, extension / Math.max(prof.stretchAtr, 0.1));
  let band: ChaseRisk = norm < 0.35 ? "LOW" : norm < 0.6 ? "MEDIUM" : norm < 0.85 ? "HIGH" : "EXTREME";
  if (stage === "STRETCH" || stage === "WEAKENING") {
    band = band === "LOW" ? "MEDIUM" : band === "MEDIUM" ? "HIGH" : "EXTREME";
  }
  return band;
}

function timingFor(
  stage: FlameStage,
  lateFraction: number,
  chase: ChaseRisk,
  inZone: boolean,
  prof: PersonalityProfile,
  m: Metrics,
): EntryTiming {
  if (stage === "EXHAUSTED" || stage === "FAILED" || stage === "REVERSAL_RISK" || stage === "NONE") return "NO_ENTRY";
  if (chase === "EXTREME" || lateFraction >= prof.chaseLateFraction) return "CHASING";
  if (stage === "STRETCH" || stage === "WEAKENING") return "LATE";
  if (stage === "IGNITING") return "EARLY";
  // RUN_ON-specific timing: distinguish re-entry flavours from plain ACCEPTABLE.
  if (stage === "RUN_ON") {
    // Pullback re-entry: price is in the entry zone and the run is clean (low chop,
    // consistent directional bodies). Clean re-entry opportunity in flame direction.
    if (inZone && m.runBodyConsistency >= 0.50 && m.overlapScore <= 0.50) return "PULLBACK_REENTRY";
    // Continuation re-entry: not in zone, but the run is early and clean enough
    // to join before it extends further.
    if (!inZone && lateFraction < 0.35 && m.overlapScore <= 0.60) return "CONTINUATION_REENTRY";
    return "ACCEPTABLE";
  }
  if (stage === "ACTIVE" && (inZone || lateFraction < 0.25)) return "CLEAN";
  return "ACCEPTABLE";
}

function runwayFor(lateFraction: number, mainTpDist: number, spreadPrice: number, atr: number): Runway {
  // Target smaller than round-trip cost => no real room.
  if (mainTpDist <= spreadPrice * 2.5) return "NONE";
  if (lateFraction >= 0.9) return "NONE";
  const remaining = mainTpDist * Math.max(0, 1 - lateFraction);
  const remAtr = atr > 0 ? remaining / atr : remaining / Math.max(spreadPrice, 1e-9);
  if (remAtr >= 2) return "CLEAR";
  if (remAtr >= 1) return "MODERATE";
  if (remAtr >= 0.3) return "TIGHT";
  return "NONE";
}

function htfFor(
  htfBias: "bullish" | "bearish" | "neutral" | null,
  dirSign: number,
  driftAtr: number,
): HtfContext {
  if (htfBias) {
    if (htfBias === "neutral") return "NEUTRAL";
    const biasSign = htfBias === "bullish" ? 1 : -1;
    return biasSign === dirSign ? "ALIGNED" : "COUNTER_TREND";
  }
  if (Math.abs(driftAtr) < 0.5) return "NEUTRAL";
  return Math.sign(driftAtr) === dirSign ? "ALIGNED" : "COUNTER_TREND";
}

function setupFor(stage: FlameStage, m: Metrics, inZone: boolean, scannerSetupType: string | null): ScalpSetupType {
  if (stage === "EXHAUSTED") return "EXHAUSTION";
  if (stage === "FAILED") return "FAILED_BREAKOUT";
  if (stage === "REVERSAL_RISK") return "REVERSAL";
  if (stage === "NONE") return "NO_SCALP";
  if (stage === "IGNITING" && m.newExtreme) return "BREAKOUT";
  if (inZone && m.age <= 2) return "RETEST";
  if (stage === "WEAKENING") return "PULLBACK";
  const s = (scannerSetupType || "").toLowerCase();
  if (s.includes("reject")) return "REJECTION";
  if (s.includes("sweep") || s.includes("liquidity")) return "LIQUIDITY_SWEEP";
  if (s.includes("break")) return "BREAKOUT";
  if (s.includes("pull") || s.includes("retest")) return "RETEST";
  return "CONTINUATION";
}

function dirWord(direction: ScalpDirection): string {
  return direction === "BUY" ? "up" : "down";
}

function whyNowFor(
  stage: FlameStage,
  setup: ScalpSetupType,
  direction: ScalpDirection,
  scannerReason: string | null,
  entryTiming?: EntryTiming,
): string | null {
  const up = direction === "BUY";
  switch (stage) {
    case "IGNITING":
      return `A fresh ${up ? "upward" : "downward"} burst is just starting${setup === "BREAKOUT" ? " as price breaks into new ground" : ""} — this is the early part of the move.`;
    case "ACTIVE":
      return `Price is pushing ${dirWord(direction)} with steady strength and closing near its ${up ? "highs" : "lows"} — the move is alive and still has shape.`;
    case "RUN_ON":
      if (entryTiming === "PULLBACK_REENTRY") {
        return `Price pulled back into a clean ${up ? "buy" : "sell"} zone while the ${dirWord(direction)} run is still healthy — this could be a re-entry in the direction of the move.`;
      }
      if (entryTiming === "CONTINUATION_REENTRY") {
        return `The ${dirWord(direction)} run is holding momentum through a brief pause — watch for the next directional candle to join before it extends further.`;
      }
      return `The ${dirWord(direction)} move is still running but is a few candles old — treat it as a continuation rather than a fresh start, and watch for quality to hold.`;
    case "STRETCH":
      return scannerReason ? `${scannerReason}, but the move is stretched and may be near its limit for now.` : `The ${dirWord(direction)} move is stretched and may be near its limit for now.`;
    case "WEAKENING":
      return `The ${dirWord(direction)} push is losing strength — candles are getting smaller and the close is slipping away from the extreme.`;
    case "EXHAUSTED":
    case "FAILED":
    case "REVERSAL_RISK":
    case "NONE":
      return null;
  }
}

/**
 * Read the flame. Pure. When `candles` is missing/too short the read is BLIND
 * (honest NONE) and no status downgrade is suggested.
 */
export function readFlame(args: FlameReadArgs): FlameReadCore {
  const prof = PERSONALITY[args.personality];
  const dirSign = args.direction === "BUY" ? 1 : -1;
  // Spec spread is already folded by the engine; live spread arrives via execution.
  const execQ = readExecutionQuality(args.execution, null);

  const candles = args.candles ?? [];
  const blind = candles.length < MIN_FLAME_CANDLES;

  if (blind) {
    // Honest NONE, identical to the sibling blindFlameRead(); NO status downgrade.
    //
    // This branch previously reported entryTiming "ACCEPTABLE" and graded a
    // runway from `args.point * 50` — a CONSTANT standing in for ATR, i.e. an
    // invented volatility measurement. With no candle window there is no
    // observed volatility and no basis for a timing verdict, so both are the
    // honest floor: NO_ENTRY and runway NONE. The divergence mattered because
    // finalizeScalpVerdict counts ACCEPTABLE as good timing and could promote a
    // blind read to POSSIBLE/STRONG.
    const read: ScalpFlameRead = {
      scalpStatus: "NOT_A_SCALP",
      readDirection: "NO_SCALP",
      scalpScore: 0,
      flameStage: "NONE",
      flameAgeCandles: 0,
      freshness: "ACTIVE",
      entryTiming: "NO_ENTRY",
      chaseRisk: "LOW",
      runway: "NONE",
      executionQuality: execQ,
      htfContext: "UNKNOWN",
      setupType: "NO_SCALP",
      riskPersonality: args.personality,
      whyNow: args.scannerReason ?? null,
      entryTrigger: null,
      targetIdea: null,
      invalidationIdea: `If price closes back through ${fmt(args.invalidationPrice, args.digits)}, the idea is done.`,
      decayNote: null,
      blind: true,
    };
    return { read, scoreAdjust: 0, downgrade: { kind: null, reason: null }, blind: true };
  }

  const m = computeMetrics(candles, dirSign, args.point);
  const stage = classifyStage(m, prof);
  const freshness = freshnessFor(stage);
  const chaseRisk = chaseRiskFor(args.lateFraction, m.extension, prof, stage);
  const entryTiming = timingFor(stage, args.lateFraction, chaseRisk, args.inZone, prof, m);
  const runway = runwayFor(args.lateFraction, args.mainTpDist, args.spreadPrice, m.atr);
  const htfContext = htfFor(args.htfBias, dirSign, m.driftAtr);
  const setupType = setupFor(stage, m, args.inZone, args.scannerSetupType);
  const whyNow = whyNowFor(stage, setupType, args.direction, args.scannerReason, entryTiming);

  // ── Plain-English trigger / target / invalidation ideas.
  const up = args.direction === "BUY";
  const entryTrigger =
    entryTiming === "NO_ENTRY"
      ? null
      : entryTiming === "EARLY"
      ? `Enter as price pushes ${dirWord(args.direction)} and holds above the last small ${up ? "higher low" : "lower high"}.`
      : entryTiming === "PULLBACK_REENTRY"
      ? `Price pulled back into a clean zone while the run is still healthy — enter when it snaps back ${up ? "up" : "down"} with a firm closing candle.`
      : entryTiming === "CONTINUATION_REENTRY"
      ? `The ${dirWord(args.direction)} run is pausing — enter on the next strong ${up ? "bullish" : "bearish"} candle that confirms it's continuing.`
      : entryTiming === "CLEAN" || entryTiming === "ACCEPTABLE"
      ? `Enter on a small pause in the ${dirWord(args.direction)} move while it keeps closing ${up ? "near its highs" : "near its lows"}.`
      : `Only enter if a fresh ${dirWord(args.direction)} candle confirms — otherwise this is too late to chase.`;
  const targetIdea =
    runway === "NONE"
      ? null
      : `Bank a quick profit near ${fmt(args.quickTpPrice, args.digits)} and let the rest aim for ${fmt(args.mainTpPrice, args.digits)}.`;
  const invalidationIdea = `If price closes back through ${fmt(args.invalidationPrice, args.digits)}, the move is done — step aside.`;

  // ── Decay note (freshness in human words).
  let decayNote: string | null = null;
  if (freshness === "LATE") decayNote = "This read is going stale — momentum is fading, so be quick or wait for the next one.";
  else if (freshness === "EXPIRED") {
    decayNote =
      stage === "FAILED"
        ? "This burst already failed and gave back its move — wait for a fresh setup."
        : stage === "EXHAUSTED"
        ? "This burst looks exhausted after a long run — the easy part is gone."
        : "Momentum has flipped against this idea — stand aside for now.";
  }

  // ── Score adjustment folded into the shared quality score.
  // For RUN_ON, use the run-on quality score so clean staircase runs get a small
  // positive boost and choppy / wick-heavy runs get a small negative penalty (−6..+6).
  const runOnQuality = computeRunOnQuality(m);
  let scoreAdjust = 0;
  switch (stage) {
    case "IGNITING": scoreAdjust += 6; break;
    case "ACTIVE": scoreAdjust += 4; break;
    case "RUN_ON": scoreAdjust += Math.round((runOnQuality - 0.5) * 12); break; // −6..+6
    case "STRETCH": scoreAdjust -= 8; break;
    case "WEAKENING": scoreAdjust -= 12; break;
    case "EXHAUSTED": scoreAdjust -= 25; break;
    case "FAILED": scoreAdjust -= 30; break;
    case "REVERSAL_RISK": scoreAdjust -= 20; break;
    case "NONE": break;
  }
  if (execQ === "POOR") scoreAdjust -= 8;
  else if (execQ === "BLOCKED") scoreAdjust -= 14;
  else if (execQ === "FAIR") scoreAdjust -= 3;
  else if (execQ === "EXCELLENT") scoreAdjust += 2;
  if (htfContext === "COUNTER_TREND") scoreAdjust -= 6;
  else if (htfContext === "ALIGNED") scoreAdjust += 3;
  if (chaseRisk === "EXTREME") scoreAdjust -= 8;
  else if (chaseRisk === "HIGH") scoreAdjust -= 4;

  // ── Status downgrade signals (engine applies them; safety gates already ran).
  let downgrade: FlameReadCore["downgrade"] = { kind: null, reason: null };
  const hardDead = stage === "EXHAUSTED" || stage === "FAILED" || stage === "REVERSAL_RISK";
  const oneStick = m.age <= 1 && stage === "IGNITING";
  if (hardDead) {
    downgrade = { kind: "NO_SCALP", reason: decayNote ?? "This burst is finished — not a clean scalp right now." };
  } else if (runway === "NONE") {
    downgrade = { kind: "NO_SCALP", reason: "There is no real room left to a target after costs — not a clean scalp." };
  } else if (whyNow == null) {
    downgrade = { kind: "NO_SCALP", reason: "There is no clear reason to enter right now — wait for a cleaner setup." };
  } else if (htfContext === "COUNTER_TREND" && prof.counterTrend === "BLOCK") {
    downgrade = { kind: "NO_SCALP", reason: "This move is fighting the bigger trend — too risky for this risk style." };
  } else if (entryTiming === "CHASING") {
    downgrade = { kind: "LATE", reason: "Price has already run too far — do not chase." };
  } else if (oneStick && !prof.allowOneStick && rank(execQ) < rank("EXCELLENT")) {
    downgrade = { kind: "FORMING", reason: "Only one strong candle so far — wait for the burst to confirm before entering." };
  }

  const read: ScalpFlameRead = {
    scalpStatus: "WEAK", // finalized by engine
    readDirection: "WAIT", // finalized by engine
    scalpScore: 0, // finalized by engine
    flameStage: stage,
    flameAgeCandles: m.age,
    freshness,
    entryTiming,
    chaseRisk,
    runway,
    executionQuality: execQ,
    htfContext,
    setupType,
    riskPersonality: args.personality,
    whyNow,
    entryTrigger,
    targetIdea,
    invalidationIdea,
    decayNote,
    blind: false,
    // Admin-only run-on trace — strip this field for normal-user responses.
    runOnTrace: stage === "RUN_ON"
      ? ({
          qualityScore: runOnQuality,
          candleCount: m.age,
          overlapScore: m.overlapScore,
          maxOpposingWickRatio: m.maxRunOpposingWickRatio,
          bodyConsistency: m.runBodyConsistency,
          bodyStrength: m.runBodyStrength,
          lastCloseLoc: m.lastCloseLoc,
          stage,
          entryTimingClass: entryTiming,
          scannerScoreImpact: Math.round((runOnQuality - 0.5) * 12),
          dataSource: "candle_window",
        } satisfies RunOnTrace)
      : undefined,
  };

  return { read, scoreAdjust, downgrade, blind: false };
}

/**
 * Finalize the user-facing verdict (scalpStatus / readDirection / scalpScore)
 * once the engine has its FINAL status + quality score. Pure.
 */
export function finalizeScalpVerdict(
  read: ScalpFlameRead,
  args: {
    status: string;
    qualityScore: number;
    direction: ScalpDirection | null;
    personality: RiskPersonality;
  },
): ScalpFlameRead {
  const prof = PERSONALITY[args.personality];
  const actionable = ["READY", "WAIT_FOR_ENTRY", "FORMING", "LATE"].includes(args.status);

  if (!actionable || !args.direction) {
    return {
      ...read,
      scalpStatus: "NOT_A_SCALP",
      readDirection: "NO_SCALP",
      scalpScore: 0,
      // A finished/no-scalp read carries no actionable timing. This used to
      // preserve a blind read's own timing, which was the carrier that let the
      // inline blind branch's "ACCEPTABLE" survive to the surface; blind reads
      // are NO_ENTRY at the source now, so there is nothing to preserve.
      entryTiming: "NO_ENTRY",
    };
  }

  const score = Math.max(0, Math.min(100, Math.round(args.qualityScore)));
  const goodExec = rank(read.executionQuality) >= rank("GOOD");
  const goodTiming = (
    read.entryTiming === "EARLY" ||
    read.entryTiming === "CLEAN" ||
    read.entryTiming === "ACCEPTABLE" ||
    read.entryTiming === "PULLBACK_REENTRY" ||
    read.entryTiming === "CONTINUATION_REENTRY"
  );
  const counterBlocked = read.htfContext === "COUNTER_TREND" && prof.counterTrend !== "ALLOW";

  let scalpStatus: ScalpReadStatus;
  if (
    args.status === "READY" &&
    score >= prof.strongMinScore &&
    goodTiming &&
    read.runway !== "NONE" &&
    read.htfContext !== "COUNTER_TREND" &&
    goodExec
  ) {
    scalpStatus = "STRONG";
  } else if (
    (args.status === "READY" || args.status === "WAIT_FOR_ENTRY") &&
    score >= prof.possibleMinScore &&
    read.entryTiming !== "CHASING" &&
    read.entryTiming !== "NO_ENTRY"
  ) {
    scalpStatus = "POSSIBLE";
  } else {
    scalpStatus = "WEAK";
  }

  let readDirection: ScalpReadDirection;
  if (args.status === "LATE" || read.entryTiming === "CHASING") {
    readDirection = "WAIT";
  } else if (read.htfContext === "COUNTER_TREND" && prof.counterTrend === "MIXED") {
    readDirection = "MIXED";
  } else if (counterBlocked) {
    readDirection = "WAIT";
  } else if (args.status === "READY") {
    readDirection = args.direction;
  } else {
    readDirection = "WAIT";
  }

  return { ...read, scalpStatus, readDirection, scalpScore: score };
}
