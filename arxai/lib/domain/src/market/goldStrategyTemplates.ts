// ── GOLD STRATEGY TEMPLATES + AUTO-BOT PRECONDITION — PURE (Task #657) ───────
//
// PURE advisory definitions for the six gold strategy templates plus their
// downgrade-only evaluation and the gold Auto-Bot PRECONDITION. A template is a
// labelled playbook (style, preferred sessions, primary tactic, bias model, risk
// notes). Evaluation folds the gold macro/timing/tactic/risk verdicts into ONE
// advisory verdict that is AT MOST conditional — it can never be READY_NOW.
//
// ── SAFETY ──────────────────────────────────────────────────────────────────
// DISPLAY / DECISION-SUPPORT only. The verdict's `readyNow` field is the literal
// type `false` — a COMPILE-TIME guarantee the gold layer never authorises a
// trade. The Auto-Bot precondition ANDs every gold verdict with the EXTERNAL
// feed / candle-sufficiency / Trade-Health / live-execution-gate facts the caller
// passes in (gold never sets them); fail-closed. Even an "eligible" precondition
// only permits the existing pipeline to CONSIDER the setup — it bypasses no gate.

import { isGoldMode, type GoldTradeStyle } from "./goldMode";
import { goldMacroSupport, type GoldMacroVerdict } from "./goldMacroContract";
import type { GoldSession, GoldTimingVerdict } from "./goldSessionContract";
import type { GoldCandleVerdict, GoldTactic } from "./goldTacticsContract";
import type { GoldRiskVerdict } from "./goldRiskContract";

export interface GoldStrategyTemplate {
  id: string;
  name: string;
  description: string;
  style: GoldTradeStyle;
  preferredSessions: readonly GoldSession[];
  primaryTactic: GoldTactic;
  biasModel: string;
  riskNotes: string;
}

export const GOLD_STRATEGY_TEMPLATES: readonly GoldStrategyTemplate[] = [
  {
    id: "gold_london_sweep_reversal",
    name: "London Sweep Reversal",
    description:
      "London sweeps the Asian range liquidity then reverses — fade the sweep back inside the range after a reclaim.",
    style: "intraday",
    preferredSessions: ["london", "overlap"],
    primaryTactic: "liquidity_sweep_reclaim",
    biasModel: "Asian range + sweep direction + reclaim; macro is supportive context only.",
    riskNotes: "Stop beyond the sweep extreme; gold wicks — give ATR room.",
  },
  {
    id: "gold_ny_breakout_retest",
    name: "NY Breakout + Retest",
    description:
      "NY-session breakout of a key level that holds its retest — gold breakouts fake out, so the retest is mandatory.",
    style: "intraday",
    preferredSessions: ["new_york", "overlap"],
    primaryTactic: "breakout_retest",
    biasModel: "Close beyond level + held retest + momentum; macro must not oppose.",
    riskNotes: "No retest ⇒ low confidence; block on wide spread / into an opposing level.",
  },
  {
    id: "gold_trend_pullback",
    name: "Trend Pullback Continuation",
    description:
      "In an established gold trend, buy/sell the pullback into structure with a confirming candle.",
    style: "swing",
    preferredSessions: ["london", "new_york", "overlap"],
    primaryTactic: "trend_pullback",
    biasModel: "Trend direction + pullback to structure + confirmation; macro aligned is a plus.",
    riskNotes: "Stop beyond the structure swing; reduce size in extreme ATR.",
  },
  {
    id: "gold_wick_rejection_level",
    name: "Wick Rejection at Level",
    description:
      "Shooting star / hammer AT a key level with prior push + confirmation — never mid-range, never wick-only.",
    style: "scalp",
    preferredSessions: ["london", "new_york", "overlap"],
    primaryTactic: "wick_rejection",
    biasModel: "Candle rejection at level + confirmation; conditional only, gold never shorts/buys a wick alone.",
    riskNotes: "Block scalps on news/wide spread/extreme-ATR tight stop.",
  },
  {
    id: "gold_news_volatility_fade",
    name: "News Volatility Fade",
    description:
      "After a high-impact news impulse exhausts, fade the over-extension back toward value once spread normalises.",
    style: "intraday",
    preferredSessions: ["new_york", "post_news"],
    primaryTactic: "exhaustion_fade",
    biasModel: "Post-news exhaustion + reclaim of a level; never trade INTO the news window.",
    riskNotes: "Wait for spread to normalise; the news window itself blocks entries.",
  },
  {
    id: "gold_range_edge_bounce",
    name: "Range Edge Bounce",
    description:
      "In a defined gold range, fade the edge back toward the midpoint with a confirming rejection.",
    style: "scalp",
    preferredSessions: ["asia", "late_fade"],
    primaryTactic: "range_edge_bounce",
    biasModel: "Range edge + rejection + room to midpoint; avoid when a breakout is brewing.",
    riskNotes: "Stop just beyond the range edge; small size — ranges break.",
  },
] as const;

export function getGoldStrategyTemplate(id: string): GoldStrategyTemplate | undefined {
  return GOLD_STRATEGY_TEMPLATES.find((t) => t.id === id);
}

export type GoldStrategyClass = "blocked" | "no_trade" | "watch" | "conditional";

export interface GoldStrategyEvalInput {
  template: GoldStrategyTemplate;
  direction: "buy" | "sell";
  macro: GoldMacroVerdict;
  timing: GoldTimingVerdict;
  tactic: GoldCandleVerdict;
  risk: GoldRiskVerdict;
  feedConfirmed: boolean;
  feedStale: boolean;
  sufficiencyAllowsSetup: boolean;
}

export interface GoldStrategyVerdict {
  templateId: string;
  decision: GoldStrategyClass;
  conditional: boolean;
  confidence: number;
  /** Literal `false`: the gold layer can NEVER emit READY_NOW. */
  readyNow: false;
  supportingFactors: string[];
  blockingFactors: string[];
  warnings: string[];
}

function clamp(n: number): number {
  return Math.max(0, Math.min(100, Math.round(n)));
}

/**
 * Evaluate a gold strategy template into ONE advisory verdict. Downgrade-only:
 * blocks dominate, then a stale/unconfirmed feed forces context-only, then macro/
 * risk caps apply. The result is AT MOST `conditional`; `readyNow` is always
 * `false`. Never raises confidence above the lowest applicable ceiling.
 */
export function evaluateGoldStrategy(input: GoldStrategyEvalInput): GoldStrategyVerdict {
  const { template, direction, macro, timing, tactic, risk } = input;
  const supporting: string[] = [];
  const blocking: string[] = [];
  const warnings: string[] = [...tactic.warnings, ...risk.warnings, ...timing.warnings];

  const contextOnly = !input.feedConfirmed || input.feedStale || !input.sufficiencyAllowsSetup;

  // ── Hard blocks ────────────────────────────────────────────────────────────
  if (timing.timingStatus === "news_blocked") blocking.push("News window — timing blocks entry.");
  if (timing.timingStatus === "spread_blocked") blocking.push("Spread is wide — timing blocks entry.");
  if (timing.timingStatus === "wick_risk_high") blocking.push("Extreme-volatility wick risk — entry unsafe.");
  if (risk.scalpBlocked && template.style === "scalp") blocking.push("Risk model blocks this gold scalp.");
  for (const r of risk.blockReasons) blocking.push(r);
  if (tactic.decision === "no_trade") blocking.push("No valid tactic setup.");
  if (tactic.decision === "too_late" || risk.tooLate) blocking.push("Too late / chasing — no entry.");

  // Direction agreement between the tactic and the requested direction.
  const tacticDir =
    tactic.decision === "conditional_buy" ? "buy" : tactic.decision === "conditional_sell" ? "sell" : "none";
  if (tacticDir !== "none" && tacticDir !== direction) {
    blocking.push("Tactic direction disagrees with the requested side.");
  }

  if (blocking.length > 0) {
    return {
      templateId: template.id,
      decision: "blocked",
      conditional: false,
      confidence: clamp(Math.min(20, tactic.confidence)),
      readyNow: false,
      supportingFactors: supporting,
      blockingFactors: [...new Set(blocking)],
      warnings: [...new Set(warnings)],
    };
  }

  // ── Confidence: start from tactic, apply every ceiling (downgrade-only) ──────
  let confidence = tactic.confidence;
  confidence = Math.min(confidence, macro.confidenceCap);
  confidence = Math.min(confidence, risk.confidenceCap);
  confidence = Math.min(confidence, timing.base.scannerTruthImpact.confidenceCeiling);

  // Macro relationship — support adds a SMALL nudge (still capped), else honest note.
  const support = goldMacroSupport(macro, direction);
  if (support === "supports") {
    confidence = Math.min(100, confidence + 5);
    supporting.push(`Macro leans ${macro.macroBias} — supports the ${direction} side.`);
  } else if (support === "caps") {
    confidence = Math.min(confidence, macro.confidenceCap);
    warnings.push("Macro conflicts with or does not support this side — capped.");
  } else if (support === "unavailable") {
    warnings.push("Gold macro is unavailable — read this setup without macro confirmation.");
  }

  if (timing.timingApproved) supporting.push("Timing approves the moment.");
  if (tactic.atKeyLevel) supporting.push(`${tactic.pattern} at a key level.`);

  // Stale/unconfirmed feed forces context-only — never overrides a stale feed.
  if (contextOnly) {
    confidence = Math.min(confidence, 35);
    warnings.push("Feed is not live-confirmed — gold setup shown as context only.");
    return {
      templateId: template.id,
      decision: "watch",
      conditional: true,
      confidence: clamp(confidence),
      readyNow: false,
      supportingFactors: [...new Set(supporting)],
      blockingFactors: [],
      warnings: [...new Set(warnings)],
    };
  }

  // A live-confirmed, unblocked, conditional tactic ⇒ conditional (never ready).
  const decision: GoldStrategyClass = tactic.conditional ? "conditional" : "watch";
  return {
    templateId: template.id,
    decision,
    conditional: true,
    confidence: clamp(confidence),
    readyNow: false,
    supportingFactors: [...new Set(supporting)],
    blockingFactors: [],
    warnings: [...new Set(warnings)],
  };
}

export interface GoldAutoBotPreconditionInput {
  symbol: string;
  direction: "buy" | "sell";
  macro: GoldMacroVerdict;
  timing: GoldTimingVerdict;
  tactic: GoldCandleVerdict;
  risk: GoldRiskVerdict;
  /** EXTERNAL facts the gold layer never sets. */
  feedLiveConfirmed: boolean;
  feedStale: boolean;
  candleSufficiencyMet: boolean;
  tradeHealthReady: boolean;
  /** The result of the EXISTING live-execution gates (e.g. the 18-gate dispatch). */
  liveExecutionGatesPass: boolean;
}

export interface GoldAutoBotPrecondition {
  /** Advisory only — every prerequisite present AND no gold verdict objects. */
  eligible: boolean;
  blockReasons: string[];
  note: string;
}

/**
 * Gold Auto-Bot PRECONDITION. ANDs every gold verdict with the external feed,
 * candle-sufficiency, Trade-Health and live-execution-gate facts. Fail-closed:
 * any missing prerequisite ⇒ not eligible. Eligibility NEVER authorises a trade —
 * the existing live pipeline/gates remain the sole executor; this only lets them
 * CONSIDER the gold setup.
 */
export function goldAutoBotPrecondition(
  input: GoldAutoBotPreconditionInput,
): GoldAutoBotPrecondition {
  const blockReasons: string[] = [];

  if (!isGoldMode(input.symbol)) blockReasons.push("Symbol is not in Gold Mode.");
  if (!input.feedLiveConfirmed) blockReasons.push("Feed is not live-confirmed.");
  if (input.feedStale) blockReasons.push("Feed is stale.");
  if (!input.candleSufficiencyMet) blockReasons.push("Candle sufficiency is not met.");
  if (!input.tradeHealthReady) blockReasons.push("Trade Health is not ready.");
  if (!input.liveExecutionGatesPass) blockReasons.push("Live-execution gates do not pass.");

  if (input.macro.macroBias === "unavailable") blockReasons.push("Gold macro is unavailable.");
  if (goldMacroSupport(input.macro, input.direction) === "caps") {
    blockReasons.push("Gold macro conflicts with the requested side.");
  }
  if (!input.timing.timingApproved) blockReasons.push("Gold timing does not approve the moment.");

  const tacticDir =
    input.tactic.decision === "conditional_buy"
      ? "buy"
      : input.tactic.decision === "conditional_sell"
        ? "sell"
        : "none";
  if (tacticDir !== input.direction) blockReasons.push("Gold tactic does not give a conditional setup on this side.");

  if (input.risk.scalpBlocked) blockReasons.push("Gold risk model blocks the setup.");
  if (input.risk.blockReasons.length > 0) blockReasons.push(...input.risk.blockReasons);
  if (input.risk.tooLate) blockReasons.push("Too late / chasing.");

  return {
    eligible: blockReasons.length === 0,
    blockReasons: [...new Set(blockReasons)],
    note: "Gold Auto-Bot precondition is advisory only — it never authorises a trade; the existing live-execution gates remain the sole executor.",
  };
}
