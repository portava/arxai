// Phase UX7 — Decision rule engine (pure).
//
// Maps the fused inputs (intelligence scores + exit plan + market context
// classification + key levels + user prefs) into one decision label,
// action, suggested button, scores, and reasons.
//
// NO fabrication. NO certainty claims. When inputs are missing, the rule
// engine returns "Data insufficient" with action
// NO_ACTION_DATA_INSUFFICIENT and explains what is missing.

import type { ScoringOutput } from "../intelligence/scoring.js";
import type { ExitPlanOutput } from "../intelligence/exitPlan.js";
import type { MarketContext } from "../marketContext/contextBuilder.js";
import type { ClassificationResult } from "../marketContext/classifier.js";
import type { KeyLevels } from "../marketContext/keyLevels.js";
import type { TradeContextResult } from "../marketContext/tradeContext.js";
import type {
  TradeDecision, DecisionLabel, DecisionAction, SuggestedButton,
  DecisionDataQuality,
} from "./types.js";

export interface UserPrefsLike {
  style: string;
  sensitivity: string;            // conservative | balanced | aggressive
  exitStyle: string;              // conservative | balanced | aggressive
  profitGivebackPercent: number;  // e.g. 35
  partialClosePreference: string; // on | off | ask
  moveStopToBreakevenPref: string;
  trailStopPref: string;
}

export interface RuleInput {
  side: "BUY" | "SELL";
  symbol: string;
  entryPrice: number | null;
  currentPrice: number | null;
  stopLoss: number | null;
  takeProfit: number | null;
  unrealizedPnl: number | null;
  peakPnl: number | null;
  ageMinutes: number | null;
  scoring: ScoringOutput;
  exitPlan: ExitPlanOutput;
  ctx: MarketContext;
  classification: ClassificationResult;
  keyLevels: KeyLevels;
  tradeContext: TradeContextResult;
  prefs: UserPrefsLike;
}

const clamp = (n: number, lo = 0, hi = 100) =>
  Math.max(lo, Math.min(hi, Math.round(n)));

const isProfit = (input: RuleInput): boolean =>
  input.unrealizedPnl != null && input.unrealizedPnl > 0;

// Price-distance helper as fraction of ATR (returns null when not computable).
function distanceInAtr(price: number | null, level: number | null, atr: number | null | undefined): number | null {
  if (price == null || level == null || atr == null || atr <= 0) return null;
  return Math.abs(price - level) / atr;
}

// Invalidation broken? Side-aware.
function invalidationBroken(input: RuleInput): boolean {
  const inv = input.keyLevels.invalidationLevel ?? input.exitPlan.invalidationLevel;
  const p = input.currentPrice;
  if (inv == null || p == null) return false;
  return input.side === "BUY" ? p < inv : p > inv;
}

function buildDataQuality(input: RuleInput): DecisionDataQuality {
  const missing: string[] = [];
  const hasIntel = input.scoring.dataQuality.hasCurrentPrice
    && input.scoring.dataQuality.hasEntryPrice
    && input.scoring.dataQuality.hasPnl;
  const hasPlan = input.exitPlan.dataQuality.canDeriveLevels;
  const mcQ = input.ctx.dataQuality.quality;
  const hasMc = mcQ !== "insufficient";
  if (!hasIntel) missing.push(...input.scoring.dataQuality.missing);
  if (!hasPlan) missing.push("exit_plan_levels");
  if (!hasMc) missing.push("market_context");
  const fresh = (() => {
    try {
      const t = Date.parse(input.ctx.builtAtIso);
      if (!Number.isFinite(t)) return null;
      return Math.max(0, Math.floor((Date.now() - t) / 60_000));
    } catch { return null; }
  })();
  return {
    hasIntelligence: hasIntel,
    hasExitPlan: hasPlan,
    hasMarketContext: hasMc,
    marketContextQuality: hasMc ? mcQ : "unavailable",
    freshnessMinutes: fresh,
    missing: Array.from(new Set(missing)),
  };
}

// ──────────────────────────────────────────────────────────────────────
// Main rule
// ──────────────────────────────────────────────────────────────────────
export function decide(input: RuleInput): TradeDecision {
  const dq = buildDataQuality(input);
  const s = input.scoring.scores;
  const ep = input.exitPlan;
  const cls = input.classification.scores;
  const kl = input.keyLevels;
  const tc = input.tradeContext;
  const reasons: string[] = [];
  const whatWouldChange: string[] = [];

  // ── Tier 0: not enough to decide at all ───────────────────────────
  // Need at least current price + entry price + a route to ranking.
  if (!dq.hasIntelligence && !dq.hasMarketContext) {
    return finalize({
      label: "Data insufficient",
      action: "NO_ACTION_DATA_INSUFFICIENT",
      button: "ASK_AI_WHY",
      confidence: null, urgency: null, risk: null,
      summary: "Not enough fresh data to form a decision yet.",
      mainReason: `Missing: ${dq.missing.slice(0, 4).join(", ") || "trade telemetry"}.`,
      reasons: ["Live quote, candles, or trade telemetry are unavailable."],
      changes: ["Wait for the next provider tick or open the trade on the platform with live data."],
      dq,
    });
  }

  // Useful aggregates (null-safe).
  const reversal = s.reversalRiskScore ?? cls.reversalRiskScore ?? null;
  const fakeout = s.fakeoutRiskScore ?? cls.fakeoutRiskScore ?? null;
  const continuation = s.continuationScore ?? cls.continuationScore ?? null;
  const pullback = s.pullbackScore ?? cls.pullbackScore ?? null;
  const trend = s.trendStrengthScore ?? cls.trendStrengthScore ?? null;
  const closeUrg = s.closeUrgencyScore ?? ep.closeUrgencyScore ?? null;
  const chop = cls.chopRiskScore ?? null;
  const giveback = input.scoring.derived.profitGivebackPercent;
  const efficient = ep.tradeEfficiencyScore;

  // ── Tier 1: hard invalidation ─────────────────────────────────────
  if (invalidationBroken(input)) {
    reasons.push(`Price has broken the invalidation level (${kl.invalidationLevel ?? ep.invalidationLevel}).`);
    if (trend != null) reasons.push(`Trend strength is ${clamp(trend)}.`);
    if (reversal != null) reasons.push(`Reversal risk is ${clamp(reversal)}.`);
    whatWouldChange.push("Price reclaiming the invalidation level on the next bar.");
    return finalize({
      label: "Trade invalidated",
      action: "REVIEW_FULL_CLOSE",
      button: "REVIEW_CLOSE",
      confidence: 80, urgency: 95, risk: 90,
      summary: "The invalidation level has been crossed. Consider reviewing a full close.",
      mainReason: "Invalidation level broken vs trade direction.",
      reasons, changes: whatWouldChange, dq,
    });
  }

  // ── Tier 2: invalidation near (within ~0.6 ATR) ───────────────────
  const atrM15 = input.ctx.timeframes.M15?.atr ?? null;
  const invDistAtr = distanceInAtr(
    input.currentPrice,
    kl.invalidationLevel ?? ep.invalidationLevel,
    atrM15,
  );
  if (invDistAtr != null && invDistAtr <= 0.6) {
    reasons.push(`Price is within ${invDistAtr.toFixed(2)}× M15 ATR of the invalidation level.`);
    if (reversal != null) reasons.push(`Reversal risk is ${clamp(reversal)}.`);
    whatWouldChange.push("Price pushing away from the invalidation by more than 1× ATR.");
    return finalize({
      label: "Trade invalidation near",
      action: "WATCH_CLOSELY",
      button: "SET_ALERT",
      confidence: 60, urgency: 75, risk: 70,
      summary: "Price is leaning into the invalidation level. Watch closely or set an alert.",
      mainReason: "Invalidation level is nearby.",
      reasons, changes: whatWouldChange, dq,
    });
  }

  // ── Tier 3: exit risk rising (reversal/fakeout breakout failed) ───
  const breakoutFailed = /fakeout|failed|reversal/i.test(input.classification.label);
  const reversalHigh = reversal != null && reversal >= 65;
  const fakeoutHigh = fakeout != null && fakeout >= 65;
  if ((reversalHigh && (fakeoutHigh || breakoutFailed))
      || (breakoutFailed && (reversal ?? 0) >= 55)) {
    reasons.push(`Market label: ${input.classification.label}.`);
    if (reversal != null) reasons.push(`Reversal risk ${clamp(reversal)}.`);
    if (fakeout != null) reasons.push(`Fakeout risk ${clamp(fakeout)}.`);
    if (isProfit(input)) reasons.push("Currently in profit — partial close may lock in some gains.");
    const action: DecisionAction = isProfit(input) ? "REVIEW_PARTIAL_CLOSE" : "REVIEW_FULL_CLOSE";
    const button: SuggestedButton = isProfit(input) ? "REVIEW_PARTIAL_CLOSE" : "REVIEW_CLOSE";
    whatWouldChange.push("Continuation reasserting (price reclaiming the breakout / momentum returning).");
    return finalize({
      label: "Exit risk rising",
      action, button,
      confidence: 55, urgency: 80, risk: 75,
      summary: isProfit(input)
        ? "Reversal pressure is rising — review a partial close to lock in some profit."
        : "Reversal pressure is rising on an open loss — review a full close.",
      mainReason: "Reversal/fakeout risk is elevated.",
      reasons, changes: whatWouldChange, dq,
    });
  }

  // ── Tier 4: protect profit (giveback above user threshold) ────────
  if (isProfit(input) && giveback != null && giveback >= input.prefs.profitGivebackPercent) {
    reasons.push(`Profit has given back ${Math.round(giveback)}% from peak (your threshold ${input.prefs.profitGivebackPercent}%).`);
    if (s.profitProtectionScore != null) reasons.push(`Profit protection score ${clamp(s.profitProtectionScore)}.`);
    // Prefer move-stop when user has enabled it; otherwise partial close review.
    const preferMoveStop = /^(on|ask|enabled)$/i.test(input.prefs.moveStopToBreakevenPref);
    const action: DecisionAction = preferMoveStop ? "REVIEW_MOVE_STOP" : "REVIEW_PARTIAL_CLOSE";
    const button: SuggestedButton = preferMoveStop ? "REVIEW_MOVE_STOP" : "REVIEW_PARTIAL_CLOSE";
    whatWouldChange.push("Price making a fresh peak and continuation re-confirming.");
    return finalize({
      label: "Protect profit",
      action, button,
      confidence: 70, urgency: 65, risk: 50,
      summary: "Profit has been giving back from peak. Consider protecting what is on the table.",
      mainReason: `${Math.round(giveback)}% profit giveback exceeds your ${input.prefs.profitGivebackPercent}% comfort.`,
      reasons, changes: whatWouldChange, dq,
    });
  }

  // ── Tier 5: review full close (very high close urgency) ───────────
  if (closeUrg != null && closeUrg >= 80) {
    reasons.push(`Close urgency ${clamp(closeUrg)}.`);
    if (ep.efficiencyLabel) reasons.push(`Exit plan: ${ep.efficiencyLabel}.`);
    return finalize({
      label: "Review full close",
      action: "REVIEW_FULL_CLOSE",
      button: "REVIEW_CLOSE",
      confidence: 65, urgency: clamp(closeUrg), risk: 70,
      summary: "Exit urgency is high. Review a full close.",
      mainReason: "Close urgency from the exit plan is in the top band.",
      reasons,
      changes: ["A fresh continuation signal lowering urgency below 60."],
      dq,
    });
  }

  // ── Tier 6: review partial close (moderate urgency + in profit) ───
  if (isProfit(input) && closeUrg != null && closeUrg >= 60) {
    reasons.push(`Close urgency ${clamp(closeUrg)} with the trade in profit.`);
    if (ep.partialCloseLevel != null) reasons.push(`Partial close level near ${ep.partialCloseLevel}.`);
    return finalize({
      label: "Review partial close",
      action: "REVIEW_PARTIAL_CLOSE",
      button: "REVIEW_PARTIAL_CLOSE",
      confidence: 60, urgency: clamp(closeUrg), risk: 50,
      summary: "Decent profit + rising urgency — review trimming part of the position.",
      mainReason: "Mid-range close urgency while in profit.",
      reasons,
      changes: ["Momentum re-accelerating in the trade's direction."],
      dq,
    });
  }

  // ── Tier 7: move stop / trail stop review (in profit + continuation)
  if (isProfit(input) && trend != null && trend >= 60
      && continuation != null && continuation >= 55) {
    const trailPref = /^(on|ask|enabled)$/i.test(input.prefs.trailStopPref);
    const movePref = /^(on|ask|enabled)$/i.test(input.prefs.moveStopToBreakevenPref);
    if (trailPref) {
      reasons.push(`Trend strength ${clamp(trend)}, continuation ${clamp(continuation)}.`);
      return finalize({
        label: "Trail stop review",
        action: "REVIEW_TRAIL_STOP",
        button: "REVIEW_TRAIL_STOP",
        confidence: 70, urgency: 35, risk: 30,
        summary: "Trend is intact and you prefer trailing — review a trail stop.",
        mainReason: "Strong continuation while preference favors trailing.",
        reasons,
        changes: ["Continuation breaking down or a fakeout signal."],
        dq,
      });
    }
    if (movePref) {
      reasons.push(`Trend strength ${clamp(trend)}, continuation ${clamp(continuation)}.`);
      return finalize({
        label: "Move stop review",
        action: "REVIEW_MOVE_STOP",
        button: "REVIEW_MOVE_STOP",
        confidence: 70, urgency: 30, risk: 30,
        summary: "Trend supports moving stop closer (e.g., to break-even).",
        mainReason: "Continuation is intact — protect the position.",
        reasons,
        changes: ["A pullback that violates the breakeven."],
        dq,
      });
    }
  }

  // ── Tier 8: healthy pullback ──────────────────────────────────────
  if (pullback != null && pullback >= 55
      && continuation != null && continuation >= 55
      && (reversal == null || reversal < 55)) {
    reasons.push(`Pullback ${clamp(pullback)}, continuation ${clamp(continuation)}.`);
    reasons.push(`Trade aligned: ${tc.trendAlignment}.`);
    const action: DecisionAction = isProfit(input) ? "HOLD" : "WATCH_CLOSELY";
    return finalize({
      label: "Healthy pullback",
      action, button: "HOLD_AND_MONITOR",
      confidence: 65, urgency: 25, risk: 30,
      summary: "Looks like a pullback inside trend rather than a reversal.",
      mainReason: "Pullback structure with continuation still intact.",
      reasons,
      changes: ["A close back through the swing low/high against the trade."],
      dq,
    });
  }

  // ── Tier 9: continuation still valid ──────────────────────────────
  if (continuation != null && continuation >= 65 && (reversal == null || reversal < 50)) {
    reasons.push(`Continuation ${clamp(continuation)}, reversal ${reversal == null ? "n/a" : clamp(reversal)}.`);
    reasons.push(`Market label: ${input.classification.label}.`);
    return finalize({
      label: "Continuation still valid",
      action: "HOLD",
      button: "HOLD_AND_MONITOR",
      confidence: 70, urgency: 20, risk: 25,
      summary: "Continuation signals are still pointing in the trade's direction.",
      mainReason: "Continuation score is high and reversal risk is contained.",
      reasons,
      changes: ["A new alert (reversal/fakeout) or break of the invalidation level."],
      dq,
    });
  }

  // ── Tier 10: chop / no clear edge ─────────────────────────────────
  if (chop != null && chop >= 60) {
    reasons.push(`Chop risk ${clamp(chop)}.`);
    return finalize({
      label: "Hold but monitor",
      action: "WATCH_CLOSELY",
      button: "SET_ALERT",
      confidence: 45, urgency: 30, risk: 40,
      summary: "Market is choppy — no clear edge either way; consider an alert.",
      mainReason: "High chop risk.",
      reasons,
      changes: ["A clean breakout or breakdown out of the range."],
      dq,
    });
  }

  // ── Tier 11: efficient winner default → Hold ──────────────────────
  if (efficient != null && efficient >= 65 && isProfit(input)) {
    reasons.push(`Trade efficiency ${clamp(efficient)} — ${ep.efficiencyLabel}.`);
    return finalize({
      label: "Hold",
      action: "HOLD",
      button: "HOLD_AND_MONITOR",
      confidence: 65, urgency: 15, risk: 25,
      summary: "Trade is behaving well — hold and monitor.",
      mainReason: "Efficient winner with no immediate threats.",
      reasons,
      changes: ["A new alert or shift in classification."],
      dq,
    });
  }

  // ── Tier 12: fallback ─────────────────────────────────────────────
  return finalize({
    label: "No clear decision",
    action: "WATCH_CLOSELY",
    button: "ASK_AI_WHY",
    confidence: 35, urgency: 30, risk: 40,
    summary: "Signals are mixed — no clear edge. Watch closely or ask the assistant.",
    mainReason: "Mixed signals across context, scoring, and exit plan.",
    reasons: [
      `Market label: ${input.classification.label}.`,
      `Exit plan: ${ep.efficiencyLabel}.`,
    ],
    changes: ["A new alert or a fresh continuation/reversal signal."],
    dq,
  });
}

function finalize(p: {
  label: DecisionLabel; action: DecisionAction; button: SuggestedButton;
  confidence: number | null; urgency: number | null; risk: number | null;
  summary: string; mainReason: string; reasons: string[]; changes: string[];
  dq: DecisionDataQuality;
}): TradeDecision {
  return {
    decisionLabel: p.label,
    decisionAction: p.action,
    confidenceScore: p.confidence,
    urgencyScore: p.urgency,
    riskScore: p.risk,
    reasonSummary: p.summary,
    mainReason: p.mainReason,
    supportingReasons: p.reasons,
    invalidationLevel: null,         // filled by orchestrator from inputs
    protectProfitLevel: null,
    continuationLevel: null,
    suggestedButton: p.button,
    requiresConfirmation: true,
    whatWouldChange: p.changes,
    dataQuality: p.dq,
    source: "orchestrator",
  };
}
