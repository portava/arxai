// Phase UX5 — Smart Exit Plan engine.
//
// Pure function: given a resolved trade, a fresh intelligence scoring
// output, user preferences, and trade age, returns a deterministic exit
// plan with suggested levels, a trade-efficiency score, a time-based
// warning, and a recommended Review action.
//
// SAFETY:
//   * All levels are decision support only. Nothing here triggers an
//     order, moves a stop, or closes a position. Every action button on
//     the UI must open a confirmation modal first.
//   * When inputs are missing, the relevant level/score is null and the
//     missing fields are listed in dataQuality.missing. No fabrication.
//   * No guarantees of profit, no claims of certainty. The explanation
//     text always frames suggestions as considerations.

import type { ScoringOutput } from "./scoring.js";

export type ExitPlanInput = {
  symbol: string;
  side: "BUY" | "SELL";
  entryPrice: number | null;
  currentPrice: number | null;
  stopLoss: number | null;
  takeProfit: number | null;
  unrealizedPnl: number | null;
  peakPnl: number | null;
  mae: number | null;
  ageMinutes: number | null;
  prefs: {
    style: string;                 // scalping | intraday | swing | custom
    exitStyle: string;             // conservative | balanced | aggressive
    sensitivity: string;           // conservative | balanced | aggressive
    profitGivebackPercent: number;
    maxHoldTimeMinutes: number;
    partialClosePreference: string;
    moveStopToBreakevenPref: string;
    trailStopPref: string;
  };
  scoring: ScoringOutput;
};

export type ExitPlanOutput = {
  protectProfitLevel: number | null;
  invalidationLevel: number | null;
  continuationLevel: number | null;
  conservativeExitLevel: number | null;
  aggressiveExitLevel: number | null;
  partialCloseLevel: number | null;
  trailStopLevel: number | null;
  tradeEfficiencyScore: number | null;
  closeUrgencyScore: number | null;
  efficiencyLabel:
    | "Efficient winner" | "Healthy hold" | "Slowing down"
    | "Stalling" | "Profit fading" | "High-risk hold"
    | "Exit review recommended" | "Data insufficient";
  timeWarning: string | null;
  recommendedAction:
    | "HOLD" | "WATCH_CLOSELY" | "MOVE_STOP_TO_BREAKEVEN" | "TRAIL_STOP"
    | "PARTIAL_CLOSE" | "CLOSE_CONSIDERATION" | "CLOSE_NOW_PROMPT"
    | "NO_ACTION_DATA_INSUFFICIENT";
  explanation: string;
  invalidationTrigger: string;
  continuationTrigger: string;
  dataQuality: ScoringOutput["dataQuality"] & {
    canDeriveLevels: boolean;
    canScoreEfficiency: boolean;
  };
};

const round = (n: number, places = 5) => {
  const p = Math.pow(10, places);
  return Math.round(n * p) / p;
};
const clamp = (n: number, lo = 0, hi = 100) => Math.max(lo, Math.min(hi, Math.round(n)));

function styleCapMinutes(style: string): number {
  if (style === "scalping") return 30;
  if (style === "intraday") return 240;
  if (style === "swing") return 4320;
  return 240;
}

export function computeExitPlan(input: ExitPlanInput): ExitPlanOutput {
  const { side, entryPrice, currentPrice, stopLoss, takeProfit, prefs, scoring } = input;
  const sign = side === "BUY" ? 1 : -1;

  const dqExtra = {
    canDeriveLevels: entryPrice != null && stopLoss != null && takeProfit != null,
    canScoreEfficiency: input.unrealizedPnl != null && entryPrice != null && currentPrice != null,
  };
  const dataQuality = { ...scoring.dataQuality, ...dqExtra };

  // ── Risk + reward sizing (R-multiples) ───────────────────────────────
  let R: number | null = null;       // price units per 1R risk
  let reward: number | null = null;  // price units to TP
  if (entryPrice != null && stopLoss != null) R = Math.abs(entryPrice - stopLoss);
  if (entryPrice != null && takeProfit != null) reward = Math.abs(takeProfit - entryPrice);

  // ── Suggested levels (null when underlying data is missing) ──────────
  let protectProfitLevel: number | null = null;
  let invalidationLevel: number | null = null;
  let continuationLevel: number | null = null;
  let conservativeExitLevel: number | null = null;
  let aggressiveExitLevel: number | null = null;
  let partialCloseLevel: number | null = null;
  let trailStopLevel: number | null = null;

  // exitStyle scaling — conservative takes profit earlier; aggressive waits longer.
  const styleMult = prefs.exitStyle === "conservative" ? 0.75
    : prefs.exitStyle === "aggressive" ? 1.25 : 1.0;

  // Hard contract: levels are derived ONLY when entry + SL + TP are all
  // present (canDeriveLevels=true). When any input is missing, every level
  // is null and the user/assistant must be told inputs are incomplete.
  if (dqExtra.canDeriveLevels && entryPrice != null && R != null && R > 0 && takeProfit != null) {
    invalidationLevel = stopLoss;                                  // SL itself
    protectProfitLevel = round(entryPrice + sign * R * 1.0);       // +1R: lock breakeven+1R
    conservativeExitLevel = round(entryPrice + sign * R * (1.0 * styleMult));
    aggressiveExitLevel = takeProfit;
    continuationLevel = round(entryPrice + sign * R * 1.5);        // proves follow-through
    if (prefs.partialClosePreference !== "off") {
      partialCloseLevel = round(entryPrice + sign * R * 1.0);      // close half at +1R
    }
    // Trail-stop suggestion only when current is >= 1R in profit.
    if (currentPrice != null && input.unrealizedPnl != null && input.unrealizedPnl > 0) {
      const inProfitR = Math.abs(currentPrice - entryPrice) / R;
      const trigger = prefs.trailStopPref === "after_2r" ? 2 : prefs.trailStopPref === "after_1r" ? 1 : null;
      if (trigger != null && inProfitR >= trigger) {
        // Trail by 0.5R behind current price.
        trailStopLevel = round(currentPrice - sign * R * 0.5);
      }
    }
  }

  // ── Trade Efficiency Score (0..100) ──────────────────────────────────
  let tradeEfficiencyScore: number | null = null;
  let efficiencyLabel: ExitPlanOutput["efficiencyLabel"] = "Data insufficient";

  if (dqExtra.canScoreEfficiency) {
    const pnl = input.unrealizedPnl!;
    const peak = input.peakPnl ?? Math.max(pnl, 0);
    const giveback = scoring.derived.profitGivebackPercent ?? 0;
    const age = input.ageMinutes ?? 0;
    const cap = styleCapMinutes(prefs.style);

    // Base from current P&L sign.
    let score = pnl >= 0 ? 60 : 35;
    // Continuation evidence (only when candles available).
    if (scoring.scores.continuationScore != null) {
      score += (scoring.scores.continuationScore - 50) * 0.35;
    }
    // Giveback penalty.
    score -= giveback * 0.4;
    // Drawdown vs risk penalty.
    if (input.mae != null && R != null && R > 0) {
      const maeR = Math.abs(input.mae) / R;
      score -= clamp(maeR * 15, 0, 25);
    }
    // Time efficiency — losing time without profit growth is punished.
    if (age > 0) {
      const ageRatio = age / Math.max(1, cap);
      if (pnl <= 0 && ageRatio > 0.5) score -= clamp(ageRatio * 20, 0, 25);
      if (pnl > 0 && peak > 0 && ageRatio > 1 && pnl < peak * 0.7) score -= 10;
    }
    // Volatility risk penalty.
    if (scoring.scores.volatilityRiskScore != null) {
      score -= scoring.scores.volatilityRiskScore * 0.15;
    }
    tradeEfficiencyScore = clamp(score);
    if (tradeEfficiencyScore >= 80) efficiencyLabel = "Efficient winner";
    else if (tradeEfficiencyScore >= 65) efficiencyLabel = "Healthy hold";
    else if (tradeEfficiencyScore >= 50) efficiencyLabel = "Slowing down";
    else if (tradeEfficiencyScore >= 35) efficiencyLabel = "Stalling";
    else if (tradeEfficiencyScore >= 25) {
      efficiencyLabel = pnl > 0 ? "Profit fading" : "High-risk hold";
    } else efficiencyLabel = "Exit review recommended";
  }

  // ── Time-based warning ───────────────────────────────────────────────
  let timeWarning: string | null = null;
  if (input.ageMinutes != null) {
    const cap = styleCapMinutes(prefs.style);
    const r = input.ageMinutes / cap;
    if (r >= 1.5) timeWarning = `Well past your typical ${prefs.style} hold window (${Math.round(input.ageMinutes)}m vs ~${cap}m). Holding longer requires fresh justification.`;
    else if (r >= 1.0) timeWarning = `At the end of your usual ${prefs.style} hold window (${Math.round(input.ageMinutes)}m / ~${cap}m). Momentum should justify holding.`;
    else if (r >= 0.8) timeWarning = `Approaching your usual ${prefs.style} hold window (${Math.round(input.ageMinutes)}m / ~${cap}m).`;
  }

  // ── Recommended action — mirror scoring engine but bias on efficiency ─
  let recommendedAction: ExitPlanOutput["recommendedAction"] = scoring.recommendedAction;
  if (tradeEfficiencyScore != null) {
    if (tradeEfficiencyScore < 25 && recommendedAction === "HOLD") recommendedAction = "CLOSE_CONSIDERATION";
    if (tradeEfficiencyScore < 35 && recommendedAction === "WATCH_CLOSELY"
        && (input.unrealizedPnl ?? 0) > 0) recommendedAction = "MOVE_STOP_TO_BREAKEVEN";
    if (tradeEfficiencyScore >= 80 && recommendedAction === "WATCH_CLOSELY") recommendedAction = "HOLD";
  }

  // ── Explanation + triggers (always honest about missing data) ────────
  const parts: string[] = [];
  if (!dqExtra.canDeriveLevels) {
    parts.push("Suggested levels require entry, stop, and take-profit — some are missing, so the exit plan is partial.");
  } else if (R != null && reward != null) {
    const rrR = reward / R;
    parts.push(`Trade risk is 1R = ${round(R)} ${input.symbol}; reward is ~${round(rrR, 2)}R.`);
  }
  if (tradeEfficiencyScore != null) {
    parts.push(`Trade efficiency ${tradeEfficiencyScore}/100 (${efficiencyLabel.toLowerCase()}).`);
  } else {
    parts.push("Trade efficiency cannot be scored yet — live P&L or price is missing.");
  }
  if (timeWarning) parts.push(timeWarning);
  parts.push("Levels are decision support, not guarantees — every action requires your confirmation.");
  const explanation = parts.join(" ");

  const invalidationTrigger = invalidationLevel != null
    ? `Price closes through ${round(invalidationLevel)} (your stop). The thesis is broken; review close immediately.`
    : "A clean break of your stop level would invalidate the trade — but stop is not set, so this is unmeasured.";
  const continuationTrigger = continuationLevel != null
    ? `Price holds above ${round(continuationLevel)} for ${input.side === "BUY" ? "BUY" : "SELL"} continuation (1.5R in your favor).`
    : "Continuation cannot be measured without entry/stop reference.";

  return {
    protectProfitLevel, invalidationLevel, continuationLevel,
    conservativeExitLevel, aggressiveExitLevel,
    partialCloseLevel, trailStopLevel,
    tradeEfficiencyScore,
    closeUrgencyScore: scoring.scores.closeUrgencyScore,
    efficiencyLabel, timeWarning, recommendedAction, explanation,
    invalidationTrigger, continuationTrigger, dataQuality,
  };
}
