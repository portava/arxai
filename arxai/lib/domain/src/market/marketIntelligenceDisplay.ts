// ── MARKET INTELLIGENCE — DISPLAY MAPPER (Task #652, Phase 2) ─────────────────
//
// PURE, DISPLAY-ONLY projection of a `MarketIntelligenceSnapshot` +
// `StrategyVerdict` into (a) a seven-part reasoning block Eleanor renders
// (Decision / Why / Evidence / Confirmation / Invalidation / Trader Test /
// Risk Note) and (b) the Scanner badge row (Direction / Pivot / Entry /
// OrderFlow / Timing / Confluence / Target Room).
//
// This module is PURE: no IO, no DB, no HTTP, no clock, no role/privilege input.
// Same inputs ⇒ same display. It carries NO execution-permission field — every
// label is an honest description of what the read SHOWS, never a trade command
// or a grant. It can only describe/downgrade; it can never raise readiness or
// authorize a trade. The Auto-Bot and every caller must AND the real, separate
// 18-gate live-execution pipeline; this projection alone can never dispatch.

import type {
  MarketIntelligenceSnapshot,
  StrategyVerdict,
  IntelligenceReadiness,
} from "./marketIntelligenceContract";

/** Honest visual tone for a badge — never an execution signal. */
export type IntelligenceBadgeTone = "positive" | "caution" | "negative" | "neutral";

export type IntelligenceBadgeKey =
  | "direction"
  | "pivot"
  | "entry"
  | "order_flow"
  | "timing"
  | "confluence"
  | "target_room";

export interface IntelligenceBadge {
  key: IntelligenceBadgeKey;
  /** Short column title, e.g. "Direction". */
  title: string;
  /** Honest one/two-word state, e.g. "Bullish", "Proxy only", "Wait for close". */
  label: string;
  tone: IntelligenceBadgeTone;
  /** A short factual detail line. */
  detail: string;
}

/** The seven-part reasoning block. Strings only — never a trade instruction. */
export interface IntelligenceReasoningBlock {
  decision: string;
  why: string;
  evidence: string[];
  confirmation: string;
  invalidation: string;
  traderTest: string;
  riskNote: string;
}

export interface MarketIntelligenceDisplay {
  reasoning: IntelligenceReasoningBlock;
  badges: IntelligenceBadge[];
}

const READINESS_LABEL: Record<IntelligenceReadiness, string> = {
  research_only: "Research only",
  context_only: "Context only",
  watchlist: "Watch",
  conditional: "Conditional",
  ready_candidate: "Candidate",
  blocked: "Blocked",
};

function biasWord(bias: MarketIntelligenceSnapshot["finalBias"]): string {
  switch (bias) {
    case "bullish":
      return "Bullish";
    case "bearish":
      return "Bearish";
    case "conflict":
      return "Conflict";
    case "neutral":
      return "Neutral";
    case "unknown":
    default:
      return "Unknown";
  }
}

// ── Per-child badge builders (honest label + tone) ───────────────────────────

function directionBadge(s: MarketIntelligenceSnapshot): IntelligenceBadge {
  const d = s.direction.scalpDirection;
  const conflict = s.direction.conflict || s.finalBias === "conflict";
  const label = conflict
    ? "Conflict"
    : d === "buy"
      ? "Long bias"
      : d === "sell"
        ? "Short bias"
        : d === "mixed"
          ? "Mixed"
          : "Wait";
  const tone: IntelligenceBadgeTone = conflict
    ? "negative"
    : d === "buy" || d === "sell"
      ? "positive"
      : "caution";
  return {
    key: "direction",
    title: "Direction",
    label,
    tone,
    detail: s.direction.conflictReason ?? `HTF ${s.direction.htfDirection} / LTF ${s.direction.ltfDirection}.`,
  };
}

function pivotBadge(s: MarketIntelligenceSnapshot): IntelligenceBadge {
  const impact = s.pivot.scannerTruthImpact;
  const label =
    s.pivot.levels == null
      ? "No levels"
      : impact.supportive
        ? "At support/structure"
        : impact.edgeAdjustment < 0
          ? "Against structure"
          : `Bias ${s.pivot.pivotBias}`;
  const tone: IntelligenceBadgeTone =
    s.pivot.levels == null
      ? "neutral"
      : impact.supportive
        ? "positive"
        : impact.edgeAdjustment < 0
          ? "negative"
          : "neutral";
  const detail =
    s.pivot.nearestLevel != null
      ? `Nearest ${s.pivot.nearestLevel} (${s.pivot.pivotSourceTimeframe} pivots).`
      : `${s.pivot.pivotSourceTimeframe} pivots unavailable.`;
  return { key: "pivot", title: "Pivot", label, tone, detail };
}

function entryBadge(s: MarketIntelligenceSnapshot): IntelligenceBadge {
  const st = s.entry.entryStatus;
  const map: Record<string, { label: string; tone: IntelligenceBadgeTone }> = {
    not_available: { label: "No setup", tone: "neutral" },
    forming: { label: "Forming", tone: "caution" },
    waiting_confirmation: { label: "Awaiting trigger", tone: "caution" },
    confirmed_candidate: { label: "Trigger confirmed", tone: "positive" },
    missed: { label: "Missed", tone: "negative" },
    too_late: { label: "Too late", tone: "negative" },
    invalidated: { label: "Invalidated", tone: "negative" },
  };
  const m = map[st] ?? { label: st, tone: "neutral" as IntelligenceBadgeTone };
  const detail =
    s.entry.currentRR != null
      ? `RR ~${s.entry.currentRR} (min ${s.entry.minimumRR}).`
      : `Minimum RR ${s.entry.minimumRR}.`;
  return { key: "entry", title: "Entry", label: m.label, tone: m.tone, detail };
}

function orderFlowBadge(s: MarketIntelligenceSnapshot): IntelligenceBadge {
  const tier = s.orderFlow.dataTier;
  const supports = s.orderFlow.supportsDirection;
  const label =
    tier === "unavailable"
      ? "Unavailable"
      : supports === "yes"
        ? "Supports"
        : supports === "no"
          ? "Contradicts"
          : supports === "mixed"
            ? "Mixed"
            : "Unknown";
  const tone: IntelligenceBadgeTone =
    tier === "unavailable"
      ? "neutral"
      : supports === "yes"
        ? "positive"
        : supports === "no"
          ? "negative"
          : "caution";
  const tierLabel =
    tier === "true_order_flow" ? "true order flow" : tier === "proxy_order_flow" ? "proxy (candle-derived)" : "no data";
  return {
    key: "order_flow",
    title: "Order Flow",
    label,
    tone,
    detail: `${s.orderFlow.pressure} pressure — ${tierLabel}.`,
  };
}

function timingBadge(s: MarketIntelligenceSnapshot): IntelligenceBadge {
  const st = s.timing.timingStatus;
  const map: Record<string, { label: string; tone: IntelligenceBadgeTone }> = {
    good: { label: "Good", tone: "positive" },
    early: { label: "Early", tone: "caution" },
    late: { label: "Late", tone: "negative" },
    wait_for_close: { label: "Wait for close", tone: "caution" },
    wait_for_retest: { label: "Wait for retest", tone: "caution" },
    news_blocked: { label: "News window", tone: "negative" },
    spread_blocked: { label: "Spread wide", tone: "negative" },
    low_liquidity: { label: "Thin liquidity", tone: "negative" },
    exhausted: { label: "Exhausted", tone: "negative" },
  };
  const m = map[st] ?? { label: st, tone: "neutral" as IntelligenceBadgeTone };
  return {
    key: "timing",
    title: "Timing",
    label: m.label,
    tone: m.tone,
    detail: `${s.timing.session} session — ${s.timing.candleState}.`,
  };
}

function confluenceBadge(s: MarketIntelligenceSnapshot): IntelligenceBadge {
  const action = s.confluence.finalAction;
  const map: Record<string, { label: string; tone: IntelligenceBadgeTone }> = {
    no_trade: { label: "No edge", tone: "neutral" },
    wait: { label: "Wait", tone: "caution" },
    watch: { label: "Watch", tone: "caution" },
    conditional: { label: "Conditional", tone: "caution" },
    ready_candidate: { label: "Aligned", tone: "positive" },
    blocked: { label: "Blocked", tone: "negative" },
  };
  const m = map[action] ?? { label: action, tone: "neutral" as IntelligenceBadgeTone };
  return {
    key: "confluence",
    title: "Confluence",
    label: m.label,
    tone: m.tone,
    detail: `Score ${s.confluence.score}/100 · ${s.confluence.alignedFactors.length} aligned, ${s.confluence.conflictingFactors.length} conflicting.`,
  };
}

function targetRoomBadge(s: MarketIntelligenceSnapshot): IntelligenceBadge {
  const room = s.risk.targetRoom;
  const map: Record<string, { label: string; tone: IntelligenceBadgeTone }> = {
    enough_room: { label: "Room to target", tone: "positive" },
    limited_room: { label: "Limited room", tone: "caution" },
    no_room: { label: "No room", tone: "negative" },
    unknown: { label: "Unknown", tone: "neutral" },
  };
  const m = map[room] ?? { label: room, tone: "neutral" as IntelligenceBadgeTone };
  const detail = s.risk.rrAcceptable ? "Reward:risk acceptable." : "Reward:risk below minimum.";
  return { key: "target_room", title: "Target Room", label: m.label, tone: m.tone, detail };
}

// ── Reasoning block ──────────────────────────────────────────────────────────

function buildReasoning(
  snapshot: MarketIntelligenceSnapshot,
  verdict: StrategyVerdict,
): IntelligenceReasoningBlock {
  const decision = `${READINESS_LABEL[verdict.readiness]} — ${biasWord(snapshot.finalBias)} (confidence ${snapshot.confidence}/100, ${snapshot.quality} quality).`;

  const why = verdict.primaryReason;

  const evidence: string[] = [
    ...verdict.checklist.filter((c) => c.satisfied).map((c) => `${c.label}: ${c.detail}`),
    ...(snapshot.confluence.alignedFactors.length
      ? [`Aligned factors: ${snapshot.confluence.alignedFactors.join(", ")}.`]
      : []),
  ];
  if (evidence.length === 0) evidence.push("No independent factor is satisfied yet.");

  const unmet = verdict.checklist.filter((c) => !c.satisfied).map((c) => c.label);
  const confirmation =
    unmet.length > 0
      ? `Would need: ${unmet.join(", ")}.`
      : "All read checks are satisfied — still confirm live readiness and risk before acting.";

  const invalidationLevel = snapshot.entry.invalidationTrigger ?? snapshot.direction.invalidationLevel;
  const invalidation =
    snapshot.finalBias === "conflict"
      ? "Read is in conflict — treat any single-side bias as invalidated until the factors agree."
      : invalidationLevel != null
        ? `Bias is invalidated on a decisive move through ${invalidationLevel}.`
        : "No clean invalidation level on this read — wait for structure to define one.";

  const traderTest =
    snapshot.finalBias === "bullish"
      ? "Would a disciplined trader buy here on this evidence alone — or wait for the trigger to confirm?"
      : snapshot.finalBias === "bearish"
        ? "Would a disciplined trader sell here on this evidence alone — or wait for the trigger to confirm?"
        : "Is there a real, falsifiable edge here — or is this just noise to stay flat on?";

  const rrText =
    snapshot.risk.currentRR != null
      ? `Reward:risk ~${snapshot.risk.currentRR} against a ${snapshot.risk.minimumRR} minimum, target room ${snapshot.risk.targetRoom.replace(/_/g, " ")}.`
      : `Reward:risk unknown; minimum is ${snapshot.risk.minimumRR}.`;
  const riskNote = `${rrText} This is a read for decision support, not a trade instruction or a permission to execute.`;

  return { decision, why, evidence, confirmation, invalidation, traderTest, riskNote };
}

/**
 * Build the full display projection. PURE and display-only: it can only describe
 * or downgrade what the snapshot/verdict already established — it never raises
 * readiness, sets an execution flag, or authorizes a trade.
 */
export function buildMarketIntelligenceDisplay(
  snapshot: MarketIntelligenceSnapshot,
  verdict: StrategyVerdict,
): MarketIntelligenceDisplay {
  const badges: IntelligenceBadge[] = [
    directionBadge(snapshot),
    pivotBadge(snapshot),
    entryBadge(snapshot),
    orderFlowBadge(snapshot),
    timingBadge(snapshot),
    confluenceBadge(snapshot),
    targetRoomBadge(snapshot),
  ];
  return { reasoning: buildReasoning(snapshot, verdict), badges };
}
