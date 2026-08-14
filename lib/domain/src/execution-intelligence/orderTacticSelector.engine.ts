// ═══════════════════════════════════════════════════════════════════════════
// Order Tactic Selector
//
// Given pre-trade conditions + (optional) broker scorecard, picks the most
// appropriate order tactic and its parameters:
//
//   • LOCKDOWN broker / EXECUTION_BLOCKED estimate           → CANCEL
//   • COSTLY estimate or DEGRADED broker, with low news      → AGGRESSIVE_LIMIT (cross 1× spread)
//   • COSTLY estimate or UNSTABLE broker, news active        → SCHEDULED 5s
//   • CLEAN/ACCEPTABLE estimate + tight spread + good depth  → MARKET
//   • CLEAN/ACCEPTABLE estimate + wide spread                → PASSIVE_LIMIT (mid-side)
//   • Otherwise                                              → AGGRESSIVE_LIMIT
//
// Pure.
// ═══════════════════════════════════════════════════════════════════════════

import {
  type OrderTactic, type OrderTacticDecision,
  type PreTradeCostEstimate, type BrokerScorecard,
} from "./executionIntelligence.types";

export interface TacticInput {
  estimate: PreTradeCostEstimate;
  scorecard?: BrokerScorecard;
  spreadAtSignalPips: number;
  avgSpreadPips: number;
  newsActiveWindow: boolean;
  intendedSizeLots: number;
  topBookDepthLots: number;
}

export function selectOrderTactic(i: TacticInput): OrderTacticDecision {
  const reasons: string[] = [];
  const broker = i.scorecard?.status;
  const v = i.estimate.verdict;

  if (broker === "LOCKDOWN" || v === "EXECUTION_BLOCKED") {
    reasons.push(`CANCEL — broker ${broker ?? "OK"}, verdict ${v}`);
    return { tactic: "CANCEL", limitOffsetPips: 0, scheduleDelayMs: 0, reasons };
  }

  const spreadRatio = i.avgSpreadPips > 0 ? i.spreadAtSignalPips / i.avgSpreadPips : 1;
  const tightSpread = spreadRatio <= 1.25;
  const goodDepth = i.topBookDepthLots > 0 && i.intendedSizeLots <= i.topBookDepthLots;

  let tactic: OrderTactic;
  let limitOffsetPips = 0;
  let scheduleDelayMs = 0;

  if (broker === "UNSTABLE") {
    // Unstable broker: never MARKET. Pause briefly with a passive limit.
    tactic = "SCHEDULED";
    scheduleDelayMs = 5_000;
    reasons.push(`SCHEDULED 5s — broker UNSTABLE; never MARKET`);
  } else if (i.newsActiveWindow && v === "EXECUTION_COSTLY") {
    tactic = "SCHEDULED";
    scheduleDelayMs = 5_000;
    reasons.push(`SCHEDULED 5s — news active + ${v}`);
  } else if (v === "EXECUTION_COSTLY" || broker === "DEGRADED") {
    // Degraded broker: never MARKET; require explicit price control.
    tactic = "AGGRESSIVE_LIMIT";
    limitOffsetPips = i.spreadAtSignalPips;        // cross by full spread
    reasons.push(`AGGRESSIVE_LIMIT — cross 1× spread (${limitOffsetPips.toFixed(2)}p) [verdict ${v}, broker ${broker ?? "OK"}]`);
  } else if ((v === "EXECUTION_CLEAN" || v === "EXECUTION_ACCEPTABLE") && tightSpread && goodDepth) {
    tactic = "MARKET";
    reasons.push(`MARKET — clean conditions, spread ${spreadRatio.toFixed(2)}× avg, broker ${broker ?? "OK"}`);
  } else if (v === "EXECUTION_CLEAN" || v === "EXECUTION_ACCEPTABLE") {
    tactic = "PASSIVE_LIMIT";
    limitOffsetPips = -i.spreadAtSignalPips / 2;   // join the mid (favorable)
    reasons.push(`PASSIVE_LIMIT — wide spread or thin depth, post inside`);
  } else {
    tactic = "AGGRESSIVE_LIMIT";
    limitOffsetPips = i.spreadAtSignalPips;
    reasons.push(`AGGRESSIVE_LIMIT — fallback`);
  }

  return { tactic, limitOffsetPips, scheduleDelayMs, reasons };
}
