// Plain-English label maps for Ruby Scalp Signals.
//
// SAFETY: normal users must never see raw UPPER_SNAKE status tokens,
// internal mode keys, or engine identifiers. Every enum the scalp engine
// returns is mapped here to a short, human phrase. Raw tokens may still
// live in a `data-*` attribute for tests/devtools (same pattern as the
// scanner status badges) but never as visible copy.

import type {
  ScalpResultStatus,
  ScalpResultUserAction,
  ScalpResultTimingStatus,
  ScalpResultTargetRealityCheck,
  ScalpMode,
  ScalpFlameReadScalpStatus,
  ScalpFlameReadReadDirection,
  ScalpFlameReadFlameStage,
  ScalpFlameReadFreshness,
  ScalpFlameReadEntryTiming,
  ScalpFlameReadChaseRisk,
  ScalpFlameReadRunway,
  ScalpFlameReadExecutionQuality,
  ScalpFlameReadHtfContext,
  ScalpFlameReadSetupType,
  ScalpAddOnVerdictRecommendation,
  ScalpExitVerdictUrgency,
  ScalpExitVerdictAction,
  RiskPersonality,
} from "@workspace/api-client-react";
import type { SetupReadiness } from "@/lib/scannerActionability";

// Map the scalp engine's per-card status onto the shared setup-readiness the ONE
// scanner action verdict consumes. The engine status is RICHER than the 7-value
// actionability vocabulary (it names spread/news/margin specifics), so the
// detailed status badge keeps the engine label; this mapping only feeds the
// unified verdict that gates the Build button so a card can never show an enabled
// "act now" button while the shared verdict says it isn't actionable. Lives in
// this pure label module (not the component) so the regression suite can import
// it without pulling in a React component.
export function scalpStatusToSetup(status: ScalpResultStatus): SetupReadiness {
  switch (status) {
    case "READY":
      return "READY";
    case "FORMING":
    case "WAIT_FOR_ENTRY":
      return "WAIT";
    case "LATE":
      return "TOO_LATE";
    case "INVALID":
    case "NO_CLEAN_SCALP":
    case "SPREAD_TOO_WIDE":
    case "NEWS_DANGER":
    case "MARKET_CLOSED":
    case "SYMBOL_NOT_TRADEABLE":
    case "INSUFFICIENT_MARGIN":
      return "NO_CLEAN_SETUP";
    case "AWAITING_DATA":
    default:
      return "UNKNOWN";
  }
}

export const SCALP_STATUS_LABEL: Record<ScalpResultStatus, string> = {
  READY: "Ready to review",
  FORMING: "Setup forming",
  WAIT_FOR_ENTRY: "Wait for entry",
  LATE: "Too late to chase",
  INVALID: "Setup invalidated",
  NO_CLEAN_SCALP: "No clean scalp",
  SPREAD_TOO_WIDE: "Spread too wide",
  NEWS_DANGER: "High-impact news nearby",
  MARKET_CLOSED: "Market closed",
  SYMBOL_NOT_TRADEABLE: "Not tradeable right now",
  INSUFFICIENT_MARGIN: "Not enough free margin",
  AWAITING_DATA: "Waiting for live data",
};

// Tone for the status chip — emerald = actionable, amber = wait/caution,
// rose = blocked/avoid, zinc = neutral/forming.
export const SCALP_STATUS_TONE: Record<ScalpResultStatus, string> = {
  READY: "bg-emerald-500/20 text-emerald-300 border-emerald-500/40",
  FORMING: "bg-sky-500/20 text-sky-300 border-sky-500/40",
  WAIT_FOR_ENTRY: "bg-amber-500/20 text-amber-300 border-amber-500/40",
  LATE: "bg-amber-500/20 text-amber-300 border-amber-500/40",
  INVALID: "bg-rose-500/20 text-rose-300 border-rose-500/40",
  NO_CLEAN_SCALP: "bg-zinc-500/20 text-zinc-300 border-zinc-500/40",
  SPREAD_TOO_WIDE: "bg-rose-500/20 text-rose-300 border-rose-500/40",
  NEWS_DANGER: "bg-rose-500/20 text-rose-300 border-rose-500/40",
  MARKET_CLOSED: "bg-zinc-500/20 text-zinc-300 border-zinc-500/40",
  SYMBOL_NOT_TRADEABLE: "bg-zinc-500/20 text-zinc-300 border-zinc-500/40",
  INSUFFICIENT_MARGIN: "bg-rose-500/20 text-rose-300 border-rose-500/40",
  AWAITING_DATA: "bg-zinc-500/20 text-zinc-300 border-zinc-500/40",
};

export const SCALP_ACTION_LABEL: Record<ScalpResultUserAction, string> = {
  READY_TO_REVIEW: "Ready to review",
  WAIT: "Wait",
  WATCH: "Watch",
  AVOID: "Avoid",
};

export const SCALP_TIMING_LABEL: Record<ScalpResultTimingStatus, string> = {
  VALID_NOW: "Valid now",
  WAIT_FOR_ENTRY: "Wait for entry",
  LATE: "Too late",
  EXPIRED: "Expired",
};

export const SCALP_TARGET_REALITY_LABEL: Record<ScalpResultTargetRealityCheck & string, string> = {
  REALISTIC: "Realistic for current conditions",
  AGGRESSIVE_BUT_POSSIBLE: "Aggressive but possible",
  TOO_RISKY: "Too ambitious right now",
  NOT_AVAILABLE_RIGHT_NOW: "Not available right now",
};

export const SCALP_MODE_LABEL: Record<ScalpMode, string> = {
  SNIPER: "Sniper",
  SAFER: "Safer",
  FAST: "Fast",
  MOMENTUM: "Momentum",
  REVERSAL: "Reversal",
  ANY: "Any style",
};

// User-selectable styles for the Builder / ranking pickers. ANY first so the
// default is the least opinionated.
export const SCALP_MODE_OPTIONS: ScalpMode[] = [
  "ANY",
  "SNIPER",
  "SAFER",
  "FAST",
  "MOMENTUM",
  "REVERSAL",
];

export const SCALP_MARKET_GROUP_LABEL: Record<string, string> = {
  all: "All markets",
  forex: "Forex",
  metals: "Metals",
  crypto: "Crypto",
  stocks: "Stocks",
  synthetic: "Synthetics",
};

export const SCALP_MARKET_GROUP_OPTIONS = [
  "all",
  "forex",
  "metals",
  "crypto",
  "stocks",
  "synthetic",
] as const;

export function riskTone(level: "LOW" | "MEDIUM" | "HIGH"): string {
  if (level === "LOW") return "text-emerald-300";
  if (level === "MEDIUM") return "text-amber-300";
  return "text-rose-300";
}

export function directionTone(dir: "BUY" | "SELL" | null): string {
  if (dir === "BUY") return "bg-emerald-500/20 text-emerald-300 border-emerald-500/40";
  if (dir === "SELL") return "bg-rose-500/20 text-rose-300 border-rose-500/40";
  return "bg-zinc-500/20 text-zinc-300 border-zinc-500/40";
}

/** Compact "x.xx" / price formatter honouring the symbol's digit count. */
export function fmtPrice(v: number | null | undefined, digits: number | null | undefined): string {
  if (v == null || !Number.isFinite(v)) return "—";
  const d = digits != null && digits >= 0 && digits <= 8 ? digits : 5;
  return v.toFixed(d);
}

export function fmtMoney(v: number | null | undefined): string {
  if (v == null || !Number.isFinite(v)) return "—";
  return `$${v.toFixed(2)}`;
}

export function fmtRr(v: number | null | undefined): string {
  if (v == null || !Number.isFinite(v)) return "—";
  return `1 : ${v.toFixed(2)}`;
}

// ── Flame read labels (Ruby Flame Scalp) ──────────────────────────────────
// Plain-English only. Raw enum tokens stay in data-* attributes, never visible.

export const FLAME_SCALP_STATUS_LABEL: Record<ScalpFlameReadScalpStatus, string> = {
  STRONG: "Strong scalp",
  POSSIBLE: "Possible scalp",
  WEAK: "Weak scalp",
  NOT_A_SCALP: "Not a scalp",
};

export const FLAME_SCALP_STATUS_TONE: Record<ScalpFlameReadScalpStatus, string> = {
  STRONG: "bg-emerald-500/20 text-emerald-300 border-emerald-500/40",
  POSSIBLE: "bg-sky-500/20 text-sky-300 border-sky-500/40",
  WEAK: "bg-amber-500/20 text-amber-300 border-amber-500/40",
  NOT_A_SCALP: "bg-zinc-500/20 text-zinc-300 border-zinc-500/40",
};

export const FLAME_DIRECTION_LABEL: Record<ScalpFlameReadReadDirection, string> = {
  BUY: "Buy side",
  SELL: "Sell side",
  WAIT: "Wait",
  MIXED: "Mixed",
  NO_SCALP: "No scalp",
};

export const FLAME_STAGE_LABEL: Record<ScalpFlameReadFlameStage, string> = {
  IGNITING: "Developing run",
  ACTIVE: "Burning",
  RUN_ON: "Running",
  STRETCH: "Runaway move",
  WEAKENING: "Weakening",
  EXHAUSTED: "Exhausted",
  FAILED: "Failed",
  REVERSAL_RISK: "Reversal risk",
  NONE: "No flame",
};

export const FLAME_STAGE_TONE: Record<ScalpFlameReadFlameStage, string> = {
  IGNITING: "bg-emerald-500/20 text-emerald-300 border-emerald-500/40",
  ACTIVE: "bg-emerald-500/20 text-emerald-300 border-emerald-500/40",
  RUN_ON: "bg-sky-500/20 text-sky-300 border-sky-500/40",
  STRETCH: "bg-amber-500/20 text-amber-300 border-amber-500/40",
  WEAKENING: "bg-amber-500/20 text-amber-300 border-amber-500/40",
  EXHAUSTED: "bg-rose-500/20 text-rose-300 border-rose-500/40",
  FAILED: "bg-rose-500/20 text-rose-300 border-rose-500/40",
  REVERSAL_RISK: "bg-rose-500/20 text-rose-300 border-rose-500/40",
  NONE: "bg-zinc-500/20 text-zinc-300 border-zinc-500/40",
};

export const FLAME_FRESHNESS_LABEL: Record<ScalpFlameReadFreshness, string> = {
  FRESH: "Fresh",
  ACTIVE: "Still good",
  LATE: "Going stale",
  EXPIRED: "Expired",
};

export const FLAME_TIMING_LABEL: Record<ScalpFlameReadEntryTiming, string> = {
  EARLY: "Early",
  CLEAN: "Clean entry",
  ACCEPTABLE: "Acceptable",
  LATE: "Late entry",
  CHASING: "Chasing",
  NO_ENTRY: "No entry",
};

export const FLAME_CHASE_LABEL: Record<ScalpFlameReadChaseRisk, string> = {
  LOW: "Low chase risk",
  MEDIUM: "Some chase risk",
  HIGH: "High chase risk",
  EXTREME: "Extreme chase risk",
};

export const FLAME_RUNWAY_LABEL: Record<ScalpFlameReadRunway, string> = {
  CLEAR: "Clear runway",
  MODERATE: "Moderate runway",
  TIGHT: "Tight runway",
  NONE: "No runway",
};

export const FLAME_EXECUTION_LABEL: Record<ScalpFlameReadExecutionQuality, string> = {
  EXCELLENT: "Excellent execution",
  GOOD: "Good execution",
  FAIR: "Fair execution",
  POOR: "Poor execution",
  BLOCKED: "Execution blocked",
};

export const FLAME_HTF_LABEL: Record<ScalpFlameReadHtfContext, string> = {
  ALIGNED: "Bigger trend agrees",
  COUNTER_TREND: "Against bigger trend",
  NEUTRAL: "Bigger trend flat",
  UNKNOWN: "Bigger trend unknown",
};

export const FLAME_SETUP_LABEL: Record<ScalpFlameReadSetupType, string> = {
  BREAKOUT: "Breakout",
  RETEST: "Retest",
  CONTINUATION: "Continuation",
  REJECTION: "Rejection",
  REVERSAL: "Reversal",
  EXHAUSTION: "Exhaustion",
  LIQUIDITY_SWEEP: "Liquidity sweep",
  FAILED_BREAKOUT: "Failed breakout",
  PULLBACK: "Pullback",
  NO_SCALP: "No clear setup",
};

export const RISK_PERSONALITY_LABEL: Record<RiskPersonality, string> = {
  CONSERVATIVE: "Conservative",
  BALANCED: "Balanced",
  AGGRESSIVE: "Aggressive",
  OWNER_ADMIN: "Owner / Admin",
};

// ── Manage-side labels (Phase 2: add-ons, baskets, exit) ───────────────────
// Plain-English only. Raw enum tokens stay in data-* attributes, never visible.

export const ADD_ON_LABEL: Record<ScalpAddOnVerdictRecommendation, string> = {
  ADD_OK: "Adding looks fine",
  ADD_WITH_CAUTION: "Add carefully",
  HOLD: "Hold what you have",
  DO_NOT_ADD: "Do not add",
};

export const ADD_ON_TONE: Record<ScalpAddOnVerdictRecommendation, string> = {
  ADD_OK: "bg-emerald-500/20 text-emerald-300 border-emerald-500/40",
  ADD_WITH_CAUTION: "bg-amber-500/20 text-amber-300 border-amber-500/40",
  HOLD: "bg-zinc-500/20 text-zinc-300 border-zinc-500/40",
  DO_NOT_ADD: "bg-rose-500/20 text-rose-300 border-rose-500/40",
};

export const EXIT_URGENCY_LABEL: Record<ScalpExitVerdictUrgency, string> = {
  NONE: "All calm",
  WATCH: "Keep an eye on it",
  PROTECT_PROFIT: "Protect your profit",
  CLOSE_LATEST: "Consider closing the last add",
  CLOSE_PARTIAL: "Consider closing part",
  CLOSE_ALL: "Consider closing all",
  EMERGENCY: "Urgent — review now",
};

export const EXIT_URGENCY_TONE: Record<ScalpExitVerdictUrgency, string> = {
  NONE: "bg-emerald-500/20 text-emerald-300 border-emerald-500/40",
  WATCH: "bg-sky-500/20 text-sky-300 border-sky-500/40",
  PROTECT_PROFIT: "bg-amber-500/20 text-amber-300 border-amber-500/40",
  CLOSE_LATEST: "bg-amber-500/20 text-amber-300 border-amber-500/40",
  CLOSE_PARTIAL: "bg-orange-500/20 text-orange-300 border-orange-500/40",
  CLOSE_ALL: "bg-rose-500/20 text-rose-300 border-rose-500/40",
  EMERGENCY: "bg-rose-500/20 text-rose-300 border-rose-500/40",
};

export const EXIT_ACTION_LABEL: Record<ScalpExitVerdictAction, string> = {
  HOLD: "Hold",
  PROTECT: "Protect profit",
  CLOSE_LATEST: "Close last add",
  CLOSE_PARTIAL: "Close part",
  CLOSE_ALL: "Close all",
};

export const RISK_PERSONALITY_OPTIONS: RiskPersonality[] = [
  "CONSERVATIVE",
  "BALANCED",
  "AGGRESSIVE",
];

export function flameChaseTone(level: ScalpFlameReadChaseRisk): string {
  if (level === "LOW") return "text-emerald-300";
  if (level === "MEDIUM") return "text-amber-300";
  return "text-rose-300";
}

export function flameRunwayTone(level: ScalpFlameReadRunway): string {
  if (level === "CLEAR") return "text-emerald-300";
  if (level === "MODERATE") return "text-sky-300";
  if (level === "TIGHT") return "text-amber-300";
  return "text-zinc-400";
}

// ── AWAITING_DATA reason split + engine timeframe (owner screenshot 2026-10-27) ─
//
// The scalp engine returns AWAITING_DATA for four different reasons. Three are
// genuine feed/data reasons; NO_SPECS means the feed passed every check (live,
// sufficient) but the broker's symbol details (lot size, point value) are not
// available — e.g. no MT5 bridge has synced them — so no scalp can be sized.
// Before this split the page rendered NO_SPECS as "Feed limited — The live feed
// isn't fully confirmed" next to DATA "Live, confirmed candles."

type ScalpReasonCarrier = { status: ScalpResultStatus; rejectReason?: string | null };

/** AWAITING_DATA because broker symbol details are missing (NOT a feed reason). */
export function isScalpAwaitingBrokerSpecs(r: ScalpReasonCarrier): boolean {
  return r.status === "AWAITING_DATA" && r.rejectReason === "NO_SPECS";
}

/**
 * AWAITING_DATA for a feed/data reason. Fail-closed: an AWAITING_DATA result
 * with no (or an unknown) reason — e.g. from an older server — counts as a feed
 * reason for the card's own gating.
 */
export function isScalpAwaitingFeed(r: ScalpReasonCarrier): boolean {
  return r.status === "AWAITING_DATA" && !isScalpAwaitingBrokerSpecs(r);
}

/** True when the AWAITING_DATA reason is one the server explicitly named. */
export function hasKnownScalpRejectReason(r: ScalpReasonCarrier): boolean {
  return (
    r.rejectReason === "NO_SCANNER_READ" ||
    r.rejectReason === "NOT_LIVE" ||
    r.rejectReason === "INSUFFICIENT_DATA" ||
    r.rejectReason === "NO_SPECS"
  );
}

/** Status chip copy that names the real reason for an AWAITING_DATA result. */
export function scalpStatusLabel(r: ScalpReasonCarrier): string {
  if (isScalpAwaitingBrokerSpecs(r)) return "Broker symbol details needed";
  return SCALP_STATUS_LABEL[r.status];
}

/**
 * The engine timeframe the Focus scalp reads when the server does not say
 * (older servers). Mirrors the server's SCALP_TIMEFRAME; the server now stamps
 * `timeframe` on every Focus result, which always wins.
 */
export const SCALP_ENGINE_FALLBACK_TIMEFRAME = "M5";

const CANONICAL_TO_BUS: Record<string, string> = {
  M1: "1m",
  M5: "5m",
  M15: "15m",
  M30: "30m",
  H1: "1h",
  H4: "4h",
  H8: "8h",
  D1: "1d",
  W1: "1w",
};

/** Canonical engine timeframe ("M5") for a scalp result. */
export function scalpEngineTimeframe(r: { timeframe?: string | null }): string {
  const tf = typeof r.timeframe === "string" ? r.timeframe.trim().toUpperCase() : "";
  return tf || SCALP_ENGINE_FALLBACK_TIMEFRAME;
}

/**
 * The scanner-bus timeframe ("5m") a scalp result's lifted verdict is keyed
 * under, so the header adopts it ONLY when the user views the timeframe the
 * engine actually read. Null when the engine timeframe has no visible chip —
 * the caller then publishes nothing rather than guessing a key.
 */
export function scalpBusTimeframe(r: { timeframe?: string | null }): string | null {
  return CANONICAL_TO_BUS[scalpEngineTimeframe(r)] ?? null;
}

/** Plain-English minutes label ("5-minute") for the engine timeframe, or null. */
export function scalpTimeframeWords(r: { timeframe?: string | null }): string | null {
  const m = /^M(\d+)$/.exec(scalpEngineTimeframe(r));
  return m ? `${m[1]}-minute` : null;
}
