// Natural-language mission intent parser — pure, IO-free, no LLM required.
//
// Accepts a single natural-language string from a user describing a profit
// goal and returns a structured MissionIntent (or null on parse failure).
//
// Examples that parse:
//   "turn $500 into $750 in 2 hours"
//   "$1000 to $1500 in 30 minutes"
//   "double $200 in 1 week"
//   "make $100 profit from $500 in 3 days"
//   "grow $500 to $700 in 45min"
//   "scalp this account to $100 in 20 minutes"   ← target-only (startingAmount null)
//   "grow this to $500 by tomorrow"               ← relative time
//   "turn $500 into $750 in 2 hours, aggressive"  ← optional riskProfile extraction
//
// This is ADVISORY / PLANNING ONLY. The output feeds the Mission Planner
// display surfaces only; it never relaxes, overrides, or triggers any
// execution gate.

import type { TimeframeUnit, RiskProfile } from "@workspace/domain/profit-mission";
import { specToMinutes, specToLabel } from "@workspace/domain/profit-mission";

export interface MissionIntent {
  /**
   * Starting amount. Null when the description mentions only a target
   * (e.g. "scalp to $X in N unit") — the UI should preserve the current
   * form value in that case.
   */
  startingAmount: number | null;
  targetAmount: number;
  timeframeAmount: number;
  timeframeUnit: TimeframeUnit;
  timeframeMinutes: number;
  timeframeLabel: string;
  /**
   * Risk profile extracted from the text, if any keyword is present.
   * Null when no profile keyword was found.
   */
  riskProfile: RiskProfile | null;
  /** Raw sentence that was successfully parsed. */
  source: string;
}

export interface ParseMissionIntentResult {
  ok: true;
  intent: MissionIntent;
}
export interface ParseMissionIntentFailure {
  ok: false;
  reason: string;
}
export type ParseMissionIntentOutput = ParseMissionIntentResult | ParseMissionIntentFailure;

// ── Timeframe ─────────────────────────────────────────────────────────────────

const UNIT_ALIASES: Array<[RegExp, TimeframeUnit]> = [
  [/\b(?:min(?:utes?)?)\b/i, "minutes"],
  [/\bhr(?:s)?\b|\bhour(?:s)?\b/i, "hours"],
  [/\bday(?:s)?\b/i, "days"],
  [/\bweek(?:s)?\b/i, "weeks"],
];

/**
 * Scan the entire text for ANY valid number+unit pair, returning the first
 * match whose unit is a recognised TimeframeUnit.
 *
 * Scanning all pairs (not just the first token) is necessary so that phrases
 * like "Make $200 in 5 hours" don't stop at "200 in" (200 is a number, "in"
 * is a word, but not a valid unit) and miss the "5 hours" that follows.
 */
function extractTimeframe(text: string): { amount: number; unit: TimeframeUnit } | null {
  const re = /(\d+(?:\.\d+)?)\s*([a-zA-Z]+)/gi;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text)) !== null) {
    const amount = parseFloat(m[1]!);
    if (!Number.isFinite(amount) || amount <= 0) continue;
    const raw = m[2]!;
    for (const [alias, unit] of UNIT_ALIASES) {
      if (alias.test(raw)) return { amount, unit };
    }
  }
  return null;
}

/**
 * Resolve relative time expressions. Returns { amount, unit } or null.
 * Supported: "by tomorrow" / "by end of day" / "by EOD" / "by end of week"
 */
function extractRelativeTimeframe(
  text: string,
): { amount: number; unit: TimeframeUnit } | null {
  const t = text.toLowerCase();
  // "by tomorrow" → 24 hours
  if (/\bby\s+tomorrow\b/.test(t)) return { amount: 24, unit: "hours" };
  // "by end of day" / "by EOD" / "by close of day" → 8 hours (a trading session)
  if (/\bby\s+(?:end\s+of\s+(?:the\s+)?day|eod|close\s+of\s+(?:the\s+)?day)\b/.test(t))
    return { amount: 8, unit: "hours" };
  // "by end of week" / "by EOW" → 5 days
  if (/\bby\s+(?:end\s+of\s+(?:the\s+)?week|eow)\b/.test(t))
    return { amount: 5, unit: "days" };
  // "by end of month" → 4 weeks
  if (/\bby\s+(?:end\s+of\s+(?:the\s+)?month|eom)\b/.test(t))
    return { amount: 4, unit: "weeks" };
  return null;
}

// ── Risk profile extraction ───────────────────────────────────────────────────

const RISK_PROFILE_ALIASES: Array<[RegExp, RiskProfile]> = [
  [/\bconservative\b/i, "conservative"],
  [/\bbalanced\b/i, "balanced"],
  [/\baggressive\b/i, "aggressive"],
  [/\bextreme\b/i, "extreme"],
];

function extractRiskProfile(text: string): RiskProfile | null {
  for (const [re, profile] of RISK_PROFILE_ALIASES) {
    if (re.test(text)) return profile;
  }
  return null;
}

// ── Parser ────────────────────────────────────────────────────────────────────

/**
 * Parse a natural-language mission description into a MissionIntent.
 *
 * Patterns supported:
 *  - "turn $A into $B in N unit"
 *  - "$A to $B in N unit"
 *  - "double $A in N unit" (target = 2×A)
 *  - "make $P profit from $A in N unit" (target = A + P)
 *  - "grow $A to $B in N unit" / "grow $A by $P in N unit"
 *  - "scalp [this/account/it] to $T in N unit" (startingAmount = null)
 *  - "[take/push/target] [this/account/it] to $T in N unit" (startingAmount = null)
 *  - "grow/take [this/account/it] to $T by tomorrow/EOD/EOW/EOM" (relative time)
 *  - Any sentence with two dollar amounts and a timeframe (fallback)
 *  - Any sentence with one dollar amount + a target verb + a timeframe (target-only fallback)
 *
 * riskProfile is extracted from any occurrence of "conservative", "balanced",
 * "aggressive", or "extreme" anywhere in the text (null if not found).
 */
export function parseMissionIntent(input: string): ParseMissionIntentOutput {
  const text = input.trim();
  if (!text) return { ok: false, reason: "Empty input" };

  const riskProfile = extractRiskProfile(text);

  // ── "double $A in N unit" ─────────────────────────────────────────────────
  const doubleM = /double\s+\$?([\d,]+(?:\.\d+)?)\s+in\s+(.+)/i.exec(text);
  if (doubleM) {
    const startingAmount = parseFloat(doubleM[1]!.replace(/,/g, ""));
    const tf = extractTimeframe(doubleM[2]!) ?? extractRelativeTimeframe(doubleM[2]!);
    if (Number.isFinite(startingAmount) && startingAmount > 0 && tf) {
      return buildResult(text, startingAmount, startingAmount * 2, tf.amount, tf.unit, riskProfile);
    }
  }

  // ── "make $P profit from $A in N unit" ───────────────────────────────────
  const profitM = /make\s+\$?([\d,]+(?:\.\d+)?)\s+profit\s+from\s+\$?([\d,]+(?:\.\d+)?)\s+in\s+(.+)/i.exec(text);
  if (profitM) {
    const profit = parseFloat(profitM[1]!.replace(/,/g, ""));
    const start = parseFloat(profitM[2]!.replace(/,/g, ""));
    const tf = extractTimeframe(profitM[3]!) ?? extractRelativeTimeframe(profitM[3]!);
    if (Number.isFinite(profit) && Number.isFinite(start) && start > 0 && profit > 0 && tf) {
      return buildResult(text, start, start + profit, tf.amount, tf.unit, riskProfile);
    }
  }

  // ── "turn $A into $B in N unit" ───────────────────────────────────────────
  // Fail-fast on ordering violations (don't fall through to reordering fallback).
  const turnM = /turn\s+\$?([\d,]+(?:\.\d+)?)\s+into\s+\$?([\d,]+(?:\.\d+)?)\s+in\s+(.+)/i.exec(text);
  if (turnM) {
    const start = parseFloat(turnM[1]!.replace(/,/g, ""));
    const target = parseFloat(turnM[2]!.replace(/,/g, ""));
    const tf = extractTimeframe(turnM[3]!) ?? extractRelativeTimeframe(turnM[3]!);
    if (Number.isFinite(start) && Number.isFinite(target) && start > 0 && tf) {
      if (target <= start) return { ok: false, reason: "Target must be greater than the starting amount." };
      return buildResult(text, start, target, tf.amount, tf.unit, riskProfile);
    }
  }

  // ── "grow $A to $B in N unit" ─────────────────────────────────────────────
  const growToM = /grow\s+\$?([\d,]+(?:\.\d+)?)\s+to\s+\$?([\d,]+(?:\.\d+)?)\s+in\s+(.+)/i.exec(text);
  if (growToM) {
    const start = parseFloat(growToM[1]!.replace(/,/g, ""));
    const target = parseFloat(growToM[2]!.replace(/,/g, ""));
    const tf = extractTimeframe(growToM[3]!) ?? extractRelativeTimeframe(growToM[3]!);
    if (Number.isFinite(start) && Number.isFinite(target) && start > 0 && tf) {
      if (target <= start) return { ok: false, reason: "Target must be greater than the starting amount." };
      return buildResult(text, start, target, tf.amount, tf.unit, riskProfile);
    }
  }

  // ── "grow $A by $P in N unit" ─────────────────────────────────────────────
  const growByM = /grow\s+\$?([\d,]+(?:\.\d+)?)\s+by\s+\$?([\d,]+(?:\.\d+)?)\s+in\s+(.+)/i.exec(text);
  if (growByM) {
    const start = parseFloat(growByM[1]!.replace(/,/g, ""));
    const profit = parseFloat(growByM[2]!.replace(/,/g, ""));
    const tf = extractTimeframe(growByM[3]!) ?? extractRelativeTimeframe(growByM[3]!);
    if (Number.isFinite(start) && Number.isFinite(profit) && start > 0 && profit > 0 && tf) {
      return buildResult(text, start, start + profit, tf.amount, tf.unit, riskProfile);
    }
  }

  // ── "$A to $B in N unit" (compact form) ───────────────────────────────────
  // Fail-fast on ordering violations so the fallback doesn't silently swap amounts.
  const compactM = /\$?([\d,]+(?:\.\d+)?)\s+to\s+\$?([\d,]+(?:\.\d+)?)\s+in\s+(.+)/i.exec(text);
  if (compactM) {
    const start = parseFloat(compactM[1]!.replace(/,/g, ""));
    const target = parseFloat(compactM[2]!.replace(/,/g, ""));
    const tf = extractTimeframe(compactM[3]!) ?? extractRelativeTimeframe(compactM[3]!);
    if (Number.isFinite(start) && Number.isFinite(target) && start > 0 && tf) {
      if (target <= start) return { ok: false, reason: "Target must be greater than the starting amount." };
      return buildResult(text, start, target, tf.amount, tf.unit, riskProfile);
    }
  }

  // ── Target-only patterns (startingAmount = null) ──────────────────────────
  // "scalp/take/push/target [this/account/it/my account] to $T in N unit"
  // "grow [this/account/it] to $T in N unit"
  // Also supports "by tomorrow/EOD/EOW" relative-time suffix.
  // [^$]* skips any filler words ("this account", "my account", etc.) before "to $amount".
  const targetOnlyRe =
    /(?:scalp|take|push|target|grow)\b[^$]*\bto\s+\$?([\d,]+(?:\.\d+)?)\s+(in\s+.+|by\s+\w.+)/i;
  const targetOnlyM = targetOnlyRe.exec(text);
  if (targetOnlyM) {
    const target = parseFloat(targetOnlyM[1]!.replace(/,/g, ""));
    const suffix = targetOnlyM[2]!.trim();
    const tf =
      extractTimeframe(suffix.replace(/^in\s+/i, "")) ??
      extractRelativeTimeframe(suffix);
    if (Number.isFinite(target) && target > 0 && tf) {
      return buildResult(text, null, target, tf.amount, tf.unit, riskProfile);
    }
  }

  // ── Relative-time two-amount fallback ─────────────────────────────────────
  // Handle "grow this to $500 by tomorrow" where the verb is "grow this"
  const relTwoM =
    /\$?([\d,]+(?:\.\d+)?)\s+(?:into|to)\s+\$?([\d,]+(?:\.\d+)?)\s+(by\s+\w.+)/i.exec(text);
  if (relTwoM) {
    const a = parseFloat(relTwoM[1]!.replace(/,/g, ""));
    const b = parseFloat(relTwoM[2]!.replace(/,/g, ""));
    const tf = extractRelativeTimeframe(relTwoM[3]!);
    if (Number.isFinite(a) && Number.isFinite(b) && a > 0 && b > a && tf) {
      return buildResult(text, a, b, tf.amount, tf.unit, riskProfile);
    }
  }

  // ── Relative-time target-only fallback ────────────────────────────────────
  // "grow this to $500 by tomorrow", "take it to $1200 by EOD"
  const relTargetM = /(?:to)\s+\$?([\d,]+(?:\.\d+)?)\s+(by\s+\w.+)/i.exec(text);
  if (relTargetM) {
    const target = parseFloat(relTargetM[1]!.replace(/,/g, ""));
    const tf = extractRelativeTimeframe(relTargetM[2]!);
    if (Number.isFinite(target) && target > 0 && tf) {
      return buildResult(text, null, target, tf.amount, tf.unit, riskProfile);
    }
  }

  // ── Fallback: two money values + a timeframe anywhere in the string ────────
  const moneyValues: number[] = [];
  const moneyRe = /\$\s*([\d,]+(?:\.\d+)?)/g;
  let match: RegExpExecArray | null;
  while ((match = moneyRe.exec(text)) !== null) {
    const n = parseFloat(match[1]!.replace(/,/g, ""));
    if (Number.isFinite(n) && n > 0) moneyValues.push(n);
  }
  const tfFallback =
    extractTimeframe(text) ?? extractRelativeTimeframe(text);
  if (moneyValues.length >= 2 && tfFallback) {
    const [a, b] = [moneyValues[0]!, moneyValues[1]!];
    const [start, target] = a < b ? [a, b] : [b, a];
    if (target > start) {
      return buildResult(text, start, target, tfFallback.amount, tfFallback.unit, riskProfile);
    }
  }

  // ── Fallback: single money value + target verb + timeframe → target-only ──
  if (moneyValues.length === 1 && tfFallback) {
    const target = moneyValues[0]!;
    return buildResult(text, null, target, tfFallback.amount, tfFallback.unit, riskProfile);
  }

  return {
    ok: false,
    reason:
      "Could not extract a target and timeframe from the input. " +
      'Try: "turn $500 into $750 in 2 hours", "scalp to $100 in 20 minutes", or "grow this to $500 by tomorrow".',
  };
}

// ── Builder ───────────────────────────────────────────────────────────────────

function buildResult(
  source: string,
  startingAmount: number | null,
  targetAmount: number,
  timeframeAmount: number,
  timeframeUnit: TimeframeUnit,
  riskProfile: RiskProfile | null,
): ParseMissionIntentOutput {
  if (startingAmount !== null && startingAmount >= targetAmount) {
    return { ok: false, reason: "Target must be greater than the starting amount." };
  }
  const timeframeMinutes = specToMinutes(timeframeAmount, timeframeUnit);
  if (timeframeMinutes <= 0) {
    return { ok: false, reason: "Timeframe must be a positive duration." };
  }
  const timeframeLabel = specToLabel(timeframeAmount, timeframeUnit);
  return {
    ok: true,
    intent: {
      startingAmount,
      targetAmount,
      timeframeAmount,
      timeframeUnit,
      timeframeMinutes,
      timeframeLabel,
      riskProfile,
      source,
    },
  };
}
