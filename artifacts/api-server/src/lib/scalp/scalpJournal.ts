// Ruby Flame Scalp — journal + per-symbol personality (Phase 3, PURE core).
//
// Pure functions only — no DB, no I/O, no clock unless injected. They turn an
// open scalp basket into a journal snapshot, derive an honest result + plain-
// English after-action review when it closes, and roll a per-symbol personality
// that feeds a BOUNDED, advice-TIGHTENING-only nudge back into the engine.
//
// SAFETY / honesty:
//  - No fabrication: when P/L is not known we say so (UNKNOWN), we never invent
//    a number or a margin.
//  - Learning only ever TIGHTENS (qualityBias ≤ 0, minQualityDelta ≥ 0). It can
//    never loosen a safety/economic gate — those run upstream in the engine.
//  - Synthetic indices (V75/V25/Boom/Crash/…) are treated separately from forex.
//  - Plain English only; no internal names; no guaranteed-return wording.

import type {
  ScalpBasket,
  ScalpExitUrgency,
  ScalpFlameRead,
} from "./scalpTypes.js";
import { DEFAULT_ASSISTANT_NAME } from "@workspace/domain/assistant-name";

export type ScalpJournalResult = "OPEN" | "WIN" | "LOSS" | "BREAKEVEN" | "UNKNOWN";
export type ScalpPlQuality = "KNOWN" | "ESTIMATED" | "UNKNOWN";

/** A small floating P/L magnitude (account currency) treated as flat. */
export const BREAKEVEN_EPSILON = 0.01;

const EXIT_URGENCY_RANK: Record<ScalpExitUrgency, number> = {
  NONE: 0,
  WATCH: 1,
  PROTECT_PROFIT: 2,
  CLOSE_LATEST: 3,
  CLOSE_PARTIAL: 4,
  CLOSE_ALL: 5,
  EMERGENCY: 6,
};

/** A real exit warning was raised (not just "watch"). */
function isRealExitWarning(u: ScalpExitUrgency): boolean {
  return EXIT_URGENCY_RANK[u] >= EXIT_URGENCY_RANK.CLOSE_LATEST;
}

export function higherUrgency(a: ScalpExitUrgency, b: ScalpExitUrgency): ScalpExitUrgency {
  return EXIT_URGENCY_RANK[a] >= EXIT_URGENCY_RANK[b] ? a : b;
}

/**
 * Synthetic / volatility instrument detection. These behave very differently
 * from forex (no real "spread/news"; sharp, mean-reverting bursts), so the
 * engine and the personality treat them separately.
 */
export function isSyntheticSymbol(symbol: string, assetClass: string | null | undefined): boolean {
  const ac = (assetClass ?? "").toLowerCase();
  if (ac.includes("synthetic") || ac.includes("volatility")) return true;
  const s = (symbol ?? "").toLowerCase();
  return (
    /\b(v|vol|volatility)\s?\d/.test(s) ||
    s.includes("volatility") ||
    s.includes("boom") ||
    s.includes("crash") ||
    s.includes("jump") ||
    s.includes("step index") ||
    s.includes("range break") ||
    /\br_?\d{2,3}\b/.test(s)
  );
}

/** Stable lifecycle key for a basket: accountMode|symbol|direction|firstLegMs. */
export function basketKeyFor(
  accountMode: string,
  symbol: string,
  direction: string,
  firstLegOpenedAtMs: number | null,
): string {
  return `${accountMode}|${symbol.toUpperCase()}|${direction}|${firstLegOpenedAtMs ?? 0}`;
}

/** Earliest leg open time (ms) in a basket, or null when none is known. */
export function firstLegOpenedAtMs(basket: ScalpBasket): number | null {
  let min: number | null = null;
  for (const leg of basket.legs) {
    if (!leg.openedAt) continue;
    const t = new Date(leg.openedAt).getTime();
    if (!Number.isFinite(t)) continue;
    if (min === null || t < min) min = t;
  }
  return min;
}

/** Whether the flame is (still) pushing in the basket's own direction. */
export function flameIsContinuing(flame: ScalpFlameRead): boolean {
  return (
    !flame.blind &&
    (flame.flameStage === "ACTIVE" ||
      flame.flameStage === "RUN_ON" ||
      flame.flameStage === "IGNITING" ||
      flame.flameStage === "STRETCH")
  );
}

/** Whether the flame has clearly turned against the basket. */
export function flameHasReversed(flame: ScalpFlameRead): boolean {
  return (
    !flame.blind &&
    (flame.flameStage === "FAILED" ||
      flame.flameStage === "REVERSAL_RISK" ||
      flame.flameStage === "EXHAUSTED")
  );
}

// ── Snapshot built on FIRST observation of a basket (≈ entry context) ────────

export interface JournalEntrySnapshot {
  accountMode: string;
  symbol: string;
  displayName: string;
  assetClass: string | null;
  isSynthetic: boolean;
  direction: "BUY" | "SELL";
  timeframe: string;
  scalpMode: string | null;
  setupType: string | null;
  basketKey: string;
  entryCount: number;
  addOnCount: number;
  averageEntry: number | null;
  breakEvenPrice: number | null;
  scoreAtEntry: number | null;
  flameStageAtEntry: string | null;
  flameAgeAtEntry: number | null;
  entryTimingAtEntry: string | null;
  chaseRiskAtEntry: string | null;
  spreadPointsAtEntry: number | null;
  executionLatencyAtEntry: number | null;
  htfContextAtEntry: string | null;
  whyNowAtEntry: string | null;
  maxExitUrgency: ScalpExitUrgency;
  flameContinued: boolean;
  lastFloatingPl: number | null;
  lastCurrentPrice: number | null;
  openedAtMs: number | null;
}

export interface SnapshotContext {
  accountMode: string;
  timeframe: string;
  scalpMode?: string | null;
  spreadPoints?: number | null;
  executionLatencySeconds?: number | null;
}

function n(v: number | null | undefined): number | null {
  return typeof v === "number" && Number.isFinite(v) ? v : null;
}

export function buildEntrySnapshot(basket: ScalpBasket, ctx: SnapshotContext): JournalEntrySnapshot {
  const flame = basket.flame;
  const openedAtMs = firstLegOpenedAtMs(basket);
  return {
    accountMode: ctx.accountMode,
    symbol: basket.symbol,
    displayName: basket.displayName,
    assetClass: null,
    isSynthetic: isSyntheticSymbol(basket.symbol, null),
    direction: basket.direction,
    timeframe: ctx.timeframe,
    scalpMode: ctx.scalpMode ?? null,
    setupType: flame.blind ? null : flame.setupType,
    basketKey: basketKeyFor(ctx.accountMode, basket.symbol, basket.direction, openedAtMs),
    entryCount: basket.entryCount,
    addOnCount: Math.max(0, basket.entryCount - 1),
    averageEntry: n(basket.averageEntry),
    breakEvenPrice: n(basket.breakEvenPrice),
    scoreAtEntry: n(flame.scalpScore),
    flameStageAtEntry: flame.flameStage,
    flameAgeAtEntry: n(flame.flameAgeCandles),
    entryTimingAtEntry: flame.entryTiming,
    chaseRiskAtEntry: flame.chaseRisk,
    spreadPointsAtEntry: n(ctx.spreadPoints),
    executionLatencyAtEntry: n(ctx.executionLatencySeconds),
    htfContextAtEntry: flame.htfContext,
    whyNowAtEntry: flame.whyNow,
    maxExitUrgency: basket.exit.urgency,
    flameContinued: flameIsContinuing(flame),
    lastFloatingPl: n(basket.combinedFloatingPl),
    lastCurrentPrice: n(basket.currentPrice),
    openedAtMs,
  };
}

// ── Result + after-action review derivation (on close) ───────────────────────

export interface CloseInputs {
  realizedPl: number | null;
  lastFloatingPl: number | null;
}

/** One broker-closed row matched by leg ticket (numeric fields pre-coerced). */
export interface ClosedLegReading {
  floatingPl: number | null;
  currentPrice: number | null;
}

/**
 * Sum broker-realised P/L across a basket's closed legs — KNOWN-grade ONLY
 * when EVERY leg ticket matched a closed row AND every matched row carried a
 * finite P/L. A partial sum (legs dropped by the staleness filter, never
 * marked closed, or missing a figure) must NOT be presented as the broker's
 * realised number: it returns null so the caller falls back to the honestly-
 * labelled ESTIMATED path. `exitPrice` is best-effort from whatever matched.
 */
export function realizedFromClosedLegs(
  legTicketCount: number,
  closed: ClosedLegReading[],
): { realizedPl: number | null; exitPrice: number | null } {
  let exitPrice: number | null = null;
  let sum = 0;
  let allHavePl = closed.length > 0;
  for (const c of closed) {
    if (typeof c.floatingPl === "number" && Number.isFinite(c.floatingPl)) {
      sum += c.floatingPl;
    } else {
      allHavePl = false;
    }
    if (typeof c.currentPrice === "number" && Number.isFinite(c.currentPrice)) {
      exitPrice = c.currentPrice;
    }
  }
  const complete = legTicketCount > 0 && closed.length === legTicketCount && allHavePl;
  return { realizedPl: complete ? sum : null, exitPrice };
}

export function deriveResult(
  close: CloseInputs,
): { result: ScalpJournalResult; plQuality: ScalpPlQuality; pl: number | null } {
  if (n(close.realizedPl) !== null) {
    return { result: classifyPl(close.realizedPl as number), plQuality: "KNOWN", pl: close.realizedPl };
  }
  if (n(close.lastFloatingPl) !== null) {
    return {
      result: classifyPl(close.lastFloatingPl as number),
      plQuality: "ESTIMATED",
      pl: close.lastFloatingPl,
    };
  }
  return { result: "UNKNOWN", plQuality: "UNKNOWN", pl: null };
}

function classifyPl(pl: number): ScalpJournalResult {
  if (pl > BREAKEVEN_EPSILON) return "WIN";
  if (pl < -BREAKEVEN_EPSILON) return "LOSS";
  return "BREAKEVEN";
}

export interface ReviewInputs {
  result: ScalpJournalResult;
  plQuality: ScalpPlQuality;
  flameStageAtEntry: string | null;
  entryTimingAtEntry: string | null;
  maxExitUrgency: ScalpExitUrgency;
  flameContinued: boolean;
  addOnCount: number;
  isSynthetic: boolean;
}

export interface ScalpReview {
  /** Short headline: what happened. */
  exitReason: string;
  /** The single most useful takeaway for next time. */
  lesson: string;
  /**
   * Did Ruby's exit pressure read line up with the outcome?
   *  true  — she flagged a real exit warning and it lost (good call to listen).
   *  false — she missed it (loss with no warning) OR cried wolf (win after a
   *          close-all warning).
   *  null  — not applicable (result unknown, or a clean win with no warning).
   */
  warnedCorrectly: boolean | null;
}

const ENTRY_TIMING_GRADE: Record<string, string> = {
  EARLY: "a touch early",
  CLEAN: "clean",
  ACCEPTABLE: "acceptable",
  LATE: "late",
  CHASING: "chasing the move",
  NO_ENTRY: "no clear entry",
};

export function gradeEntryTiming(timing: string | null): string {
  if (!timing) return "unclear";
  return ENTRY_TIMING_GRADE[timing] ?? "unclear";
}

/**
 * Produce a short, honest, plain-English after-action review. No internal
 * names, no guaranteed-return wording. Best-effort even when P/L is unknown.
 */
export function deriveReview(r: ReviewInputs): ScalpReview {
  const timingGrade = gradeEntryTiming(r.entryTimingAtEntry);
  const warnedRealWarning = isRealExitWarning(r.maxExitUrgency);

  let warnedCorrectly: boolean | null = null;
  if (r.result === "LOSS") warnedCorrectly = warnedRealWarning ? true : false;
  else if (r.result === "WIN" && (r.maxExitUrgency === "CLOSE_ALL" || r.maxExitUrgency === "EMERGENCY")) {
    warnedCorrectly = false;
  }

  if (r.result === "UNKNOWN") {
    return {
      exitReason:
        "This scalp closed, but the final profit or loss wasn't reported back, so the result is incomplete.",
      lesson:
        "Make sure your MT5 bridge stays connected through the close so every result is captured for review.",
      warnedCorrectly: null,
    };
  }

  if (r.result === "WIN") {
    const parts: string[] = [];
    parts.push(
      r.flameContinued
        ? "This one worked. The move kept pushing in your favour after you got in."
        : "This one closed in profit even though the move cooled off — you took it before it turned.",
    );
    let lesson: string;
    if (warnedCorrectly === false) {
      lesson =
        `${DEFAULT_ASSISTANT_NAME} flashed an exit warning on this winner — worth noticing when her caution would have cut a good trade short.`;
    } else if (r.entryTimingAtEntry === "CLEAN") {
      lesson = "Clean entry timing did the heavy lifting here — keep waiting for that quality of entry.";
    } else if (r.addOnCount > 0) {
      lesson = "Adding while the move was clearly working added to the result. Only add while it's still pushing.";
    } else {
      lesson = `Entry timing was ${timingGrade}; banking it while the move was alive paid off.`;
    }
    return { exitReason: parts.join(" "), lesson, warnedCorrectly };
  }

  if (r.result === "BREAKEVEN") {
    return {
      exitReason: "This scalp finished roughly flat — no real win, no real loss.",
      lesson:
        r.entryTimingAtEntry === "LATE" || r.entryTimingAtEntry === "CHASING"
          ? "A late entry left little room to work. Earlier, cleaner entries give a flat trade more chance to pay."
          : "Flat trades happen. Protecting the entry and not over-adding kept this one from turning into a loss.",
      warnedCorrectly,
    };
  }

  // LOSS
  let exitReason: string;
  if (!r.flameContinued) {
    exitReason = "The burst faded soon after you entered — it didn't follow through, and the trade went against you.";
  } else if (warnedRealWarning) {
    exitReason = `The move turned against you and ${DEFAULT_ASSISTANT_NAME}'s exit pressure was rising before it closed in the red.`;
  } else {
    exitReason = "Price moved against the position and it closed at a loss.";
  }
  if (r.entryTimingAtEntry === "LATE" || r.entryTimingAtEntry === "CHASING") {
    exitReason += ` Entry was ${timingGrade}, which left little cushion.`;
  }

  let lesson: string;
  if (r.addOnCount > 0) {
    lesson = "Adding to this position made the loss bigger — only add while the move is clearly still working.";
  } else if (warnedCorrectly === false) {
    lesson = "There was no early exit signal here; tighter protection on the entry would have capped the damage.";
  } else if (warnedCorrectly === true) {
    lesson = `${DEFAULT_ASSISTANT_NAME}'s rising exit pressure was the tell — acting on that warning earlier would have helped.`;
  } else if (r.entryTimingAtEntry === "LATE" || r.entryTimingAtEntry === "CHASING") {
    lesson = "Chasing a stretched move is where these losses come from — wait for a fresh, cleaner entry.";
  } else if (r.isSynthetic) {
    lesson = "Synthetic indices snap back hard — keep stops in and size smaller when the burst is already extended.";
  } else {
    lesson = "Wait for the move to actually follow through before committing — fading bursts are the usual culprit.";
  }
  return { exitReason, lesson, warnedCorrectly };
}

// ── Per-symbol personality (rolling, bounded, tightening-only) ───────────────

export interface PersonalityCounts {
  tradesClosed: number;
  wins: number;
  losses: number;
  breakevens: number;
  reversalCount: number;
  fakeoutCount: number;
  continuationCount: number;
  avgSpreadPoints: number | null;
  avgFlameAgeAtEntry: number | null;
  avgScoreAtEntry: number | null;
  sampleCount: number;
  isSynthetic: boolean;
}

export interface PersonalityClosedTrade {
  result: ScalpJournalResult;
  flameReversedAtClose: boolean;
  flameContinued: boolean;
  spreadPointsAtEntry: number | null;
  flameAgeAtEntry: number | null;
  scoreAtEntry: number | null;
  isSynthetic: boolean;
}

export const EMPTY_PERSONALITY_COUNTS: PersonalityCounts = {
  tradesClosed: 0,
  wins: 0,
  losses: 0,
  breakevens: 0,
  reversalCount: 0,
  fakeoutCount: 0,
  continuationCount: 0,
  avgSpreadPoints: null,
  avgFlameAgeAtEntry: null,
  avgScoreAtEntry: null,
  sampleCount: 0,
  isSynthetic: false,
};

/** Rolling average that ignores null samples (keeps the prior average). */
function rollAvg(prevAvg: number | null, prevCount: number, sample: number | null): number | null {
  if (sample === null) return prevAvg;
  if (prevAvg === null || prevCount <= 0) return sample;
  return (prevAvg * prevCount + sample) / (prevCount + 1);
}

/** Fold a closed trade into the per-symbol counts (counts only; bias separate). */
export function applyPersonalityDelta(
  prev: PersonalityCounts,
  t: PersonalityClosedTrade,
): PersonalityCounts {
  const next: PersonalityCounts = {
    ...prev,
    isSynthetic: prev.isSynthetic || t.isSynthetic,
    tradesClosed: prev.tradesClosed + 1,
    wins: prev.wins + (t.result === "WIN" ? 1 : 0),
    losses: prev.losses + (t.result === "LOSS" ? 1 : 0),
    breakevens: prev.breakevens + (t.result === "BREAKEVEN" ? 1 : 0),
    reversalCount: prev.reversalCount + (t.result === "LOSS" && t.flameReversedAtClose ? 1 : 0),
    fakeoutCount: prev.fakeoutCount + (t.result === "LOSS" && !t.flameContinued ? 1 : 0),
    continuationCount: prev.continuationCount + (t.flameContinued ? 1 : 0),
    avgSpreadPoints: rollAvg(prev.avgSpreadPoints, prev.sampleCount, t.spreadPointsAtEntry),
    avgFlameAgeAtEntry: rollAvg(prev.avgFlameAgeAtEntry, prev.sampleCount, t.flameAgeAtEntry),
    avgScoreAtEntry: rollAvg(prev.avgScoreAtEntry, prev.sampleCount, t.scoreAtEntry),
    sampleCount: prev.sampleCount + 1,
  };
  return next;
}

export interface PersonalityBias {
  /** ≤ 0 — subtracted from the quality score (penalty). */
  qualityBias: number;
  /** ≥ 0 — raises the minimum-quality floor. */
  minQualityDelta: number;
  /** Plain-English summary for the UI. Null until there's enough data. */
  notes: string | null;
}

/** Minimum closed trades before learning nudges anything (honest small-sample). */
export const PERSONALITY_MIN_SAMPLE = 3;
const MAX_QUALITY_PENALTY = 8;
const MAX_MIN_QUALITY_DELTA = 10;

function clamp(v: number, lo: number, hi: number): number {
  return Math.max(lo, Math.min(hi, v));
}

/**
 * Translate the rolling counts into a BOUNDED, tightening-only nudge. Returns a
 * no-op (0/0) until there is enough data — never guesses on a thin sample.
 * Synthetic indices get a slightly firmer reversal penalty.
 */
export function computeQualityBias(p: PersonalityCounts): PersonalityBias {
  if (p.tradesClosed < PERSONALITY_MIN_SAMPLE) {
    return { qualityBias: 0, minQualityDelta: 0, notes: null };
  }
  const lossRate = p.tradesClosed > 0 ? p.losses / p.tradesClosed : 0;
  const reversalRate = p.tradesClosed > 0 ? p.reversalCount / p.tradesClosed : 0;
  const fakeoutRate = p.tradesClosed > 0 ? p.fakeoutCount / p.tradesClosed : 0;
  const synthFactor = p.isSynthetic ? 1.25 : 1;

  // Penalty grows with how often this symbol loses / reverses / fakes out.
  const penalty =
    lossRate * 6 + reversalRate * 4 * synthFactor + fakeoutRate * 3;
  // Normalize -0 → 0 so a clean (penalty-free) symbol reads as exactly 0.
  const qualityBias = -clamp(penalty, 0, MAX_QUALITY_PENALTY) || 0;

  // Raise the floor when reversals/fakeouts dominate the losses.
  const floorRaise = (reversalRate + fakeoutRate) * 6 * synthFactor;
  const minQualityDelta = clamp(floorRaise, 0, MAX_MIN_QUALITY_DELTA);

  const winRatePct = Math.round((p.wins / p.tradesClosed) * 100);
  let notes: string;
  if (qualityBias <= -4) {
    notes = `${DEFAULT_ASSISTANT_NAME} is being stricter on ${p.isSynthetic ? "this synthetic index" : "this market"} — it has reversed or faded on you more often than it has paid (${winRatePct}% wins so far).`;
  } else if (qualityBias < 0) {
    notes = `${DEFAULT_ASSISTANT_NAME} is a little more cautious here based on your history (${winRatePct}% wins so far).`;
  } else {
    notes = `This market has behaved normally for you so far (${winRatePct}% wins).`;
  }
  return { qualityBias, minQualityDelta, notes };
}
