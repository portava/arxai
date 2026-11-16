// ── GOLD REASONING + SCANNER BADGES + OVERLAYS — PURE (Task #657) ────────────
//
// PURE projection of the gold verdicts (macro / session-timing / tactic / risk /
// strategy) into the EXISTING display surfaces: Eleanor's "Gold Context"
// reasoning block, the Scanner badge row, and a gold chart-overlay SPEC. These
// only DESCRIBE what the gold layer already decided — they fetch nothing, decide
// nothing new, and carry no execution-permission field.
//
// ── SAFETY ──────────────────────────────────────────────────────────────────
// DISPLAY only. Overlays are pure spec objects (boxes/markers/levels/labels) with
// `displayOnly: true` and NO trade buttons. Missing macro renders "Unavailable"
// (never "Neutral"/"Favourable"). No IO, no clock. Nothing here grants entry.

import type { IntelligenceBadge, IntelligenceBadgeTone } from "./marketIntelligenceDisplay";
import type { GoldMacroVerdict } from "./goldMacroContract";
import type { GoldTimingVerdict, GoldRange } from "./goldSessionContract";
import type { GoldCandleVerdict } from "./goldTacticsContract";
import type { GoldRiskVerdict } from "./goldRiskContract";
import type { GoldStrategyVerdict } from "./goldStrategyTemplates";

export interface GoldContextBlock {
  title: string;
  /** Honest descriptive lines for Eleanor's Gold Context. */
  lines: string[];
  decision: string;
  confirmation: string;
  invalidation: string;
  riskNote: string;
  warnings: string[];
}

export interface GoldReasoningInput {
  symbol: string;
  direction: "buy" | "sell";
  macro: GoldMacroVerdict;
  timing: GoldTimingVerdict;
  tactic: GoldCandleVerdict;
  risk: GoldRiskVerdict;
  strategy: GoldStrategyVerdict;
}

function macroLine(macro: GoldMacroVerdict): string {
  if (macro.macroBias === "unavailable") {
    return "Macro: unavailable — no dollar/yield/safe-haven driver connected.";
  }
  return `Macro: ${macro.macroBias} (USD ${macro.dollarPressure}, yields ${macro.yieldPressure}, safe-haven ${macro.safeHavenFlow}).`;
}

/**
 * Build Eleanor's Gold Context reasoning block — a faithful description of the
 * gold verdicts. Never upgrades the decision; mirrors the (always-conditional)
 * strategy verdict and surfaces macro honestly as "unavailable" when missing.
 */
export function buildGoldContextBlock(input: GoldReasoningInput): GoldContextBlock {
  const { macro, timing, tactic, risk, strategy } = input;
  const lines: string[] = [
    macroLine(macro),
    `Session: ${timing.session.replace(/_/g, " ")} — timing ${timing.timingStatus.replace(/_/g, " ")}.`,
    `Setup: ${tactic.pattern} — ${tactic.decision.replace(/_/g, " ")} (${tactic.strength}).`,
    `Risk: ATR ${risk.atrState}, wick ${risk.wickRisk}, spread ${risk.spreadRisk}, stop ${risk.stopDistanceStatus.replace(/_/g, " ")}.`,
  ];
  if (timing.asianRange) {
    lines.push(`Asian range ${timing.asianRange.low}–${timing.asianRange.high}.`);
  }
  if (timing.londonSweep.detected) {
    lines.push(timing.londonSweep.reason);
  }

  const decision =
    strategy.decision === "blocked"
      ? "No trade — blocked."
      : strategy.decision === "conditional"
        ? `Conditional ${input.direction} setup — confirmation required.`
        : strategy.decision === "watch"
          ? "Watch only — context, not a trigger."
          : "No valid gold setup.";

  return {
    title: "Gold Context",
    lines,
    decision,
    confirmation: tactic.confirmation,
    invalidation: tactic.invalidation,
    riskNote: risk.riskWarning,
    warnings: [...new Set([...strategy.warnings, ...macro.warnings])],
  };
}

function macroBadgeTone(macro: GoldMacroVerdict): IntelligenceBadgeTone {
  switch (macro.macroBias) {
    case "bullish":
    case "bearish":
      return "positive";
    case "mixed":
      return "caution";
    case "unavailable":
      return "neutral";
    default:
      return "neutral";
  }
}

function timingBadgeTone(timing: GoldTimingVerdict): IntelligenceBadgeTone {
  switch (timing.timingStatus) {
    case "good":
      return "positive";
    case "news_blocked":
    case "spread_blocked":
    case "wick_risk_high":
    case "exhausted":
      return "negative";
    default:
      return "caution";
  }
}

/**
 * Build the gold Scanner badge row. Reuses the shared {@link IntelligenceBadge}
 * shape with the `asset` key so the Scanner renders gold state inline. Honest
 * tones; macro "unavailable" reads neutral, never positive.
 */
export function buildGoldScannerBadges(input: GoldReasoningInput): IntelligenceBadge[] {
  const { macro, timing, tactic, risk } = input;
  return [
    {
      key: "confluence",
      title: "Gold",
      label: "Gold Mode",
      tone: "neutral",
      detail: `${input.symbol} — gold strategy layer active.`,
    },
    {
      key: "direction",
      title: "Macro",
      label: macro.macroBias === "unavailable" ? "Unavailable" : macro.macroBias,
      tone: macroBadgeTone(macro),
      detail: macroLine(macro),
    },
    {
      key: "timing",
      title: "Timing",
      label: timing.timingStatus.replace(/_/g, " "),
      tone: timingBadgeTone(timing),
      detail: `${timing.session.replace(/_/g, " ")} session.`,
    },
    {
      key: "entry",
      title: "Setup",
      label: tactic.decision.replace(/_/g, " "),
      tone: tactic.decision === "no_trade" || tactic.decision === "too_late" ? "negative" : "caution",
      detail: `${tactic.pattern} (${tactic.strength}).`,
    },
    {
      key: "order_flow",
      title: "Risk",
      label: risk.scalpBlocked ? "Blocked" : `ATR ${risk.atrState}`,
      tone: risk.scalpBlocked ? "negative" : risk.atrState === "extreme" ? "caution" : "neutral",
      detail: `Wick ${risk.wickRisk}, spread ${risk.spreadRisk}, stop ${risk.stopDistanceStatus.replace(/_/g, " ")}.`,
    },
  ];
}

export type GoldOverlayElement =
  | { kind: "range_box"; label: string; high: number; low: number }
  | { kind: "level_line"; label: string; price: number; style: "key" | "sweep" | "pivot" }
  | { kind: "marker"; label: string; price: number; tone: IntelligenceBadgeTone };

export interface GoldOverlaySpec {
  /** Always true — overlays are presentation only, never interactive trade UI. */
  displayOnly: true;
  /** No trade buttons are ever part of a gold overlay. */
  tradeButtons: false;
  elements: GoldOverlayElement[];
  caption: string;
}

/**
 * Build the pure gold chart-overlay spec — Asian range box, London-sweep level,
 * NY opening-range box, and key-level lines. A SPEC only: the renderer draws it;
 * there are no trade buttons and nothing here can place an order.
 */
export function buildGoldOverlaySpec(args: {
  asianRange: GoldRange | null;
  nyOpenRange: GoldRange | null;
  timing: GoldTimingVerdict;
  keyLevels?: { label: string; price: number }[];
}): GoldOverlaySpec {
  const elements: GoldOverlayElement[] = [];
  if (args.asianRange) {
    elements.push({
      kind: "range_box",
      label: "Asian Range",
      high: args.asianRange.high,
      low: args.asianRange.low,
    });
  }
  if (args.nyOpenRange) {
    elements.push({
      kind: "range_box",
      label: "NY Opening Range",
      high: args.nyOpenRange.high,
      low: args.nyOpenRange.low,
    });
  }
  if (args.timing.londonSweep.detected && args.timing.londonSweep.level != null) {
    elements.push({
      kind: "level_line",
      label: `London Sweep (${args.timing.londonSweep.direction})`,
      price: args.timing.londonSweep.level,
      style: "sweep",
    });
  }
  for (const lvl of args.keyLevels ?? []) {
    elements.push({ kind: "level_line", label: lvl.label, price: lvl.price, style: "key" });
  }
  return {
    displayOnly: true,
    tradeButtons: false,
    elements,
    caption: "Gold context overlay — display only.",
  };
}
