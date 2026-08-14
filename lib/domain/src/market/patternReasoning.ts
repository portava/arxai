// ── PATTERN REASONING (Task #654) ───────────────────────────────────────────
//
// PURE builder for Eleanor's pattern-reasoning block: the trader-facing
// narration of WHAT a structure is, WHY it matters, the EVIDENCE for it, what
// would CONFIRM it, what would INVALIDATE it, a plain "would a disciplined
// trader take this?" TEST, and a RISK note. It turns the structured
// `PatternDetection` + classified `TradeReadVerdict` into clean prose.
//
// ── SAFETY / HONESTY ────────────────────────────────────────────────────────
// DISPLAY ONLY. This builder describes and educates — it NEVER asserts a trade
// is "ready now", "valid now", profitable, or guaranteed, and it carries no
// execution-permission field. It also never leaks internal enum tokens
// (UPPER_SNAKE / "STRUCTURAL_ONLY" / "READY_NOW") into user copy. Reads that are
// context-only / forming / suppressed are narrated AS SUCH so a reader can never
// mistake evidence for permission.

import type {
  PatternDetection,
  PatternDirection,
  TradeReadClass,
  TradeReadVerdict,
} from "./patternDetectionContract";
import { isActionableTradeRead } from "./patternDetectionContract";

export interface PatternReasoningBlock {
  /** One-line plain-English verdict on the structure (never a grant). */
  decision: string;
  /** Why this structure matters in the current context. */
  why: string;
  /** The measurable evidence behind the read. */
  evidence: string[];
  /** What price action would CONFIRM the structure. */
  confirmation: string;
  /** What price action would INVALIDATE the structure. */
  invalidation: string;
  /** The disciplined-trader gut check. */
  traderTest: string;
  /** Honest risk caveat (failure modes + asset/feed caveats). */
  riskNote: string;
}

export interface PatternReasoningInput {
  symbol: string;
  read: TradeReadVerdict;
  detection: PatternDetection | null;
  /** Extra caveats from the asset profile / session / news (downgrade-only). */
  extraWarnings?: readonly string[];
}

const DIRECTION_WORD: Record<PatternDirection, string> = {
  buy: "bullish",
  sell: "bearish",
  neutral: "non-directional",
};

function readLabel(read: TradeReadClass): string {
  switch (read) {
    case "buy":
      return "a bullish (long) idea";
    case "sell":
      return "a bearish (short) idea";
    case "scalp":
      return "a short-term scalp idea";
    case "reversal":
      return "a possible reversal forming";
    case "continuation":
      return "a possible continuation forming";
    case "consolidation":
      return "a consolidation / no-edge range";
    case "no_trade":
    default:
      return "no actionable setup";
  }
}

function fmtLevel(n: number | null): string {
  if (n == null || !Number.isFinite(n)) return "the trigger level";
  // Trim to a readable precision without assuming instrument decimals.
  const abs = Math.abs(n);
  const decimals = abs >= 100 ? 2 : abs >= 1 ? 4 : 5;
  return n.toFixed(decimals);
}

/**
 * Build the reasoning block. Always honest about state:
 *   • context-only  → the decision says "context only — not a live read".
 *   • forming       → the decision says it is forming / waiting for the trigger.
 *   • actionable    → the decision describes the idea but still frames it as
 *                     evidence to be confirmed against the live gates, never a
 *                     "go now".
 */
export function buildPatternReasoningBlock(
  input: PatternReasoningInput,
): PatternReasoningBlock {
  const { read, detection } = input;
  const name = detection?.name ?? "structure";
  const label = readLabel(read.tradeRead);
  const actionable = isActionableTradeRead(read.tradeRead);

  let decision: string;
  if (read.contextOnly) {
    decision = `${name} is context only right now — not a live read on ${input.symbol}.`;
  } else if (actionable) {
    decision = `${name} reads as ${label} on ${input.symbol} — evidence to weigh, not a signal to act blindly.`;
  } else {
    decision = `${name} reads as ${label} on ${input.symbol}.`;
  }

  const why = detection
    ? `This is a ${DIRECTION_WORD[detection.direction]} ${detection.family} structure; ${
        read.reasons[0] ?? "context shapes whether it can act."
      }`
    : (read.reasons[0] ?? "No qualifying structure is present in the current window.");

  const evidence: string[] = [];
  if (detection) {
    for (const r of detection.rationale) evidence.push(r);
    if (detection.candlesUsed > 0) {
      evidence.push(
        `Read on ${detection.candlesUsed} closed candles (minimum ${detection.minCandles}).`,
      );
    }
    if (detection.locationQuality !== "unknown") {
      evidence.push(`Location: ${detection.locationQuality.replace(/_/g, " ")}.`);
    }
  }
  if (evidence.length === 0) {
    for (const r of read.reasons) evidence.push(r);
  }

  const confirmation =
    detection?.confirmationLevel != null
      ? `Confirms on a close beyond ${fmtLevel(detection.confirmationLevel)}.`
      : read.conditional
        ? "Confirms only once the trigger candle closes — wait for it."
        : "Already confirmed on closed candles; re-check against the live feed.";

  const invalidation =
    detection?.invalidationLevel != null
      ? `Invalidated on a close back beyond ${fmtLevel(detection.invalidationLevel)}.`
      : "Invalidated if price closes back through the structure's opposite edge.";

  const traderTest = actionable
    ? "Would a disciplined trader take this? Only with a confirmed trigger, room to the next level, and risk defined first."
    : read.contextOnly
      ? "A disciplined trader waits — there is no live, confirmed read here yet."
      : "A disciplined trader treats this as context, not a trade — there is no clean trigger.";

  const riskParts: string[] = [];
  if (detection?.failureModes?.length) riskParts.push(...detection.failureModes);
  if (detection?.reliabilityNote) riskParts.push(detection.reliabilityNote);
  if (input.extraWarnings?.length) riskParts.push(...input.extraWarnings);
  if (detection?.warnings?.length) riskParts.push(...detection.warnings);
  const riskNote =
    riskParts.length > 0
      ? riskParts.join(" ")
      : "Patterns are evidence, not permission — they can fail; size risk first and let the live gates have the final say.";

  return { decision, why, evidence, confirmation, invalidation, traderTest, riskNote };
}
