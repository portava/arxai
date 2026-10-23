// ── CHART PATTERN TRUTH — DISPLAY / DECISION-SUPPORT CONTRACT (Phase 2) ───────
//
// SHARED, PURE definition of "what chart pattern (if any) is on this
// symbol/timeframe, how confident/confirmed is it, and how may that pattern
// COLOUR the existing Scanner Truth read?". The detector (api-server) produces
// the raw `DetectedPattern[]`; this contract folds them — together with the
// caller's ALREADY-DECIDED feed/sufficiency/chart-read facts — into one
// `PatternTruthVerdict` that the Scanner, Ruby, and Scalp Builder all consume so
// they can never contradict each other about a pattern.
//
// This module is PURE: no IO, no DB, no HTTP, no clock, no role/privilege input.
// Same inputs ⇒ same verdict.
//
// ── SAFETY: PATTERN TRUTH IS A *CHILD INPUT*, DISPLAY-ONLY ───────────────────
// A pattern may only RAISE-WITHIN-CAP or LOWER what the user SEES — setup
// quality, display confidence (bounded by the caller's existing caps),
// explanation wording, edge score, chase/too-late classification, and
// conditional-vs-confirmed labelling. A pattern may NEVER:
//   • independently produce READY_NOW / "ready now" / "valid now" wording,
//   • override historical-only / feed-limited / unconfirmed-feed status,
//   • override a low-confidence chart read, trade-health eligibility, or a risk
//     gate,
//   • influence live-execution permission, broker dispatch, the kill switch,
//     owner/admin overrides, or the final trade-execution button.
// The verdict therefore exposes ONLY display hints (`scannerTruthImpact`,
// confidence ceilings, wording). It carries NO execution-permission field, and
// the import-boundary CI guard keeps every execution/safety module from reading
// the display-only readability flags this layer is built to respect. The caller
// ALWAYS ANDs a positive impact with the real feed/sufficiency/risk state — a
// pattern can only ever make the existing verdict the SAME or MORE conservative,
// except for a small, cap-bounded supportive nudge that is itself gated on a
// genuinely confirmed pattern *and* a live-confirmed feed.

export type PatternCategory =
  | "reversal"
  | "continuation"
  | "breakout_retest"
  | "candlestick"
  | "structure"
  | "scalp_flare";

export type PatternBias = "bullish" | "bearish" | "neutral";

/**
 * Lifecycle status of a pattern.
 *   none         → nothing detected (the common case; never downgrades).
 *   forming      → geometry present but the confirmation trigger has NOT fired.
 *   confirmed    → the confirmation trigger fired on closed candles.
 *   failed       → the confirmation attempt failed (e.g. failed breakout).
 *   exhausted    → confirmed but extended/late — chasing is dangerous.
 *   invalidated  → price violated the invalidation level.
 */
export type PatternStatus =
  | "none"
  | "forming"
  | "confirmed"
  | "failed"
  | "exhausted"
  | "invalidated";

export type PatternQuality = "high" | "medium" | "low" | "none";

/** How clean an entry would be RIGHT NOW relative to the pattern's trigger. */
export type PatternEntryTiming = "early" | "clean" | "late" | "dangerous" | "none";

export type PatternRiskBand = "low" | "medium" | "high";

/** Stable display hint describing how a pattern colours the Scanner Truth read. */
export type PatternScannerLabelHint =
  | "none" // no detected pattern — no wording change
  | "context_only" // feed historical/unconfirmed → pattern is context only
  | "forming_setup" // forming → "forming setup / needs confirmation"
  | "needs_confirmation" // forming on an otherwise-clean read
  | "too_late_chase" // exhausted/late → "too late to chase"
  | "mixed_conditional" // pattern conflicts with chart read / HTF bias
  | "limited_room" // target sits inside nearby S/R
  | "failed_setup" // failed/invalidated → no setup
  | "supportive"; // confirmed + aligned → may nudge quality within caps

export interface PatternLevels {
  /** Trigger that confirms the pattern (e.g. neckline / flag break). */
  confirmation: number | null;
  /** Structural level whose violation invalidates the pattern. */
  invalidation: number | null;
  /** Measured-move target(s), nearest first. */
  targets: number[];
}

export interface DetectedPatternKeyPoint {
  index: number;
  price: number;
  role: string; // e.g. "head", "left_shoulder", "neckline", "flagpole_high"
}

/** One pattern the detector measured on the candles (raw, pre-display-fold). */
export interface DetectedPattern {
  /** Stable machine key, e.g. "head_and_shoulders". */
  id: string;
  /** Human label, e.g. "Head & Shoulders". */
  name: string;
  category: PatternCategory;
  bias: PatternBias;
  status: PatternStatus;
  /** Raw geometric confidence 0–100 BEFORE any display cap. */
  confidence: number;
  quality: PatternQuality;
  levels: PatternLevels;
  keyPoints: DetectedPatternKeyPoint[];
  /** Measurable conditions that were satisfied (for explanation + audit). */
  rationale: string[];
  /** Known ways this pattern fails (surfaced as honest warnings). */
  failureModes: string[];
  /** Minimum closed candles this pattern needs to be detectable. */
  minCandles: number;
  entryTiming: PatternEntryTiming;
  /** Risk that an apparent breakout is a false one. */
  falseBreakoutRisk: PatternRiskBand;
}

export interface PatternContext {
  /** Higher-timeframe / structural trend bias the read already established. */
  trend: PatternBias;
  /** True when price is at/into a meaningful S/R level. */
  nearSupportResistance: boolean;
  /** Distance to the nearest blocking S/R in ATR units (null if unknown). */
  distanceToSrAtr: number | null;
  /** True when momentum agrees with the pattern bias. */
  momentumAligned: boolean;
  /** ATR used for geometry normalization (null if unknown). */
  volatilityAtr: number | null;
}

export interface PatternRrContext {
  /** Reward:risk to the nearest target using confirmation/invalidation. */
  rewardRiskRatio: number | null;
  /** True when the nearest target sits inside nearby S/R (limited room). */
  limitedRoom: boolean;
}

/**
 * DISPLAY-ONLY downgrade/within-cap hints. The caller folds these into the
 * existing Scanner Truth verdict. EVERY field can only make the read the same or
 * MORE conservative, except `edgeAdjustment`/`confidenceFloorOk`, which may add a
 * small bounded nudge ONLY when `supportive` (a confirmed pattern on a
 * live-confirmed feed). NONE of these is an execution permission.
 */
export interface PatternScannerImpact {
  labelHint: PatternScannerLabelHint;
  /** Hard ceiling for display confidence (0–100); the caller never raises above it. */
  confidenceCeiling: number;
  /** Hard ceiling for display quality; the caller never raises above it. */
  qualityCeiling: PatternQuality;
  /** Forces conditional-vs-confirmed wording ("if X then" rather than "valid now"). */
  conditional: boolean;
  /** Feed historical/unconfirmed → all pattern wording is context only. */
  contextOnly: boolean;
  /**
   * Bounded edge-score adjustment in [-25, +10]. Positive ONLY when supportive
   * (confirmed pattern + live-confirmed feed + aligned); otherwise ≤ 0.
   */
  edgeAdjustment: number;
  /** True only for `supportive`: the caller MAY (still within its own caps) let
   *  a confirmed-pattern read keep a higher band. Never grants READY_NOW. */
  supportive: boolean;
}

export interface PatternTruthVerdict {
  detectedPatterns: DetectedPattern[];
  dominantPattern: DetectedPattern | null;
  bias: PatternBias;
  /** Display confidence 0–100 AFTER caps (never exceeds the dominant raw value). */
  confidence: number;
  quality: PatternQuality;
  status: PatternStatus;
  confirmationLevel: number | null;
  invalidationLevel: number | null;
  targets: number[];
  context: PatternContext;
  rrContext: PatternRrContext;
  falseBreakoutRisk: PatternRiskBand;
  /** True when entry now would be a chase (exhausted / late). */
  chaseRisk: boolean;
  /** Why display confidence/quality was capped, or null when nothing capped it. */
  confidenceCapReason: string | null;
  scannerTruthImpact: PatternScannerImpact;
  /** Plain-language explanation (pre feed-honesty neutralization at the surface). */
  rubyExplanation: string;
  warnings: string[];
}

/**
 * The caller's ALREADY-DECIDED display facts. Passed as primitives so this pure
 * contract never imports the sufficiency / trade-health / feed modules (keeping
 * it decoupled and the import boundary clean). Each flag describes the read the
 * pattern is colouring — the pattern NEVER recomputes them.
 */
export interface PatternDisplayContext {
  /** True when the feed is genuinely live-confirmed (LIVE + FULL read). */
  feedConfirmed: boolean;
  /** True when the feed is delayed/stale (read uses last closed bars only). */
  feedStale: boolean;
  /** True when sufficiency already allows showing a trade setup (canShowTradeSetup). */
  sufficiencyAllowsSetup: boolean;
  /** True when the chart-read structural confidence is LOW. */
  chartReadConfidenceLow: boolean;
}

const QUALITY_RANK: Record<PatternQuality, number> = {
  none: 0,
  low: 1,
  medium: 2,
  high: 3,
};

const STATUS_RANK: Record<PatternStatus, number> = {
  none: 0,
  failed: 1,
  invalidated: 1,
  exhausted: 2,
  forming: 3,
  confirmed: 4,
};

function minQuality(a: PatternQuality, b: PatternQuality): PatternQuality {
  return QUALITY_RANK[a] <= QUALITY_RANK[b] ? a : b;
}

function clampConfidence(n: number): number {
  if (!Number.isFinite(n)) return 0;
  return Math.max(0, Math.min(100, Math.round(n)));
}

/**
 * Pick the dominant pattern: highest status rank first (confirmed > forming >
 * exhausted > failed/invalidated), then highest raw confidence. Deterministic
 * tie-break on the stable id so the same input always yields the same dominant.
 */
function pickDominant(patterns: DetectedPattern[]): DetectedPattern | null {
  if (patterns.length === 0) return null;
  return [...patterns].sort((a, b) => {
    const s = STATUS_RANK[b.status] - STATUS_RANK[a.status];
    if (s !== 0) return s;
    const c = b.confidence - a.confidence;
    if (c !== 0) return c;
    return a.id.localeCompare(b.id);
  })[0]!;
}

const CONTEXT_ONLY_CONF_CAP = 35;
const FORMING_CONF_CAP = 60;
const EXHAUSTED_CONF_CAP = 40;

/**
 * Build the ONE shared pattern verdict from the detector's raw patterns + the
 * caller's display facts. The result's `scannerTruthImpact` is downgrade-only
 * (with a small bounded supportive nudge gated on a confirmed pattern AND a
 * live-confirmed feed). It can never make the read MORE permissive than the
 * feed/sufficiency already allow.
 */
export function resolvePatternTruth(
  detectedPatterns: DetectedPattern[],
  context: PatternContext,
  display: PatternDisplayContext,
): PatternTruthVerdict {
  const dominant = pickDominant(detectedPatterns);
  const warnings: string[] = [];

  if (!dominant) {
    return {
      detectedPatterns,
      dominantPattern: null,
      bias: "neutral",
      confidence: 0,
      quality: "none",
      status: "none",
      confirmationLevel: null,
      invalidationLevel: null,
      targets: [],
      context,
      rrContext: { rewardRiskRatio: null, limitedRoom: false },
      falseBreakoutRisk: "low",
      chaseRisk: false,
      confidenceCapReason: null,
      scannerTruthImpact: {
        labelHint: "none",
        confidenceCeiling: 100,
        qualityCeiling: "high",
        conditional: false,
        contextOnly: false,
        edgeAdjustment: 0,
        supportive: false,
      },
      rubyExplanation: "No clear chart pattern on this timeframe yet.",
      warnings,
    };
  }

  const status = dominant.status;
  const bias = dominant.bias;
  const contextOnly = !display.feedConfirmed || display.feedStale || !display.sufficiencyAllowsSetup;

  // Conflicts with the established chart-read / HTF trend.
  const conflictsWithTrend =
    context.trend !== "neutral" && bias !== "neutral" && context.trend !== bias;

  // RR + limited-room (target inside nearby S/R).
  const limitedRoom = computeLimitedRoom(dominant, context);
  const rewardRiskRatio = computeRewardRisk(dominant);
  if (limitedRoom) {
    warnings.push("Nearest target sits inside nearby support/resistance — limited room.");
  }

  // ── Display caps + label, downgrade-only (highest-precedence cap wins) ──────
  let confidenceCeiling = 100;
  let qualityCeiling: PatternQuality = "high";
  let conditional = false;
  let edgeAdjustment = 0;
  let supportive = false;
  let labelHint: PatternScannerLabelHint = "none";
  let confidenceCapReason: string | null = null;
  let chaseRisk = false;

  if (status === "failed" || status === "invalidated") {
    labelHint = "failed_setup";
    confidenceCeiling = Math.min(confidenceCeiling, 20);
    qualityCeiling = "none";
    conditional = true;
    edgeAdjustment = -25;
    confidenceCapReason =
      status === "invalidated"
        ? "Pattern invalidated — price violated the invalidation level."
        : "Pattern failed — the confirmation attempt did not hold.";
    warnings.push(confidenceCapReason);
  } else if (status === "exhausted") {
    labelHint = "too_late_chase";
    chaseRisk = true;
    confidenceCeiling = Math.min(confidenceCeiling, EXHAUSTED_CONF_CAP);
    qualityCeiling = minQuality(qualityCeiling, "low");
    conditional = true;
    edgeAdjustment = -15;
    confidenceCapReason = "Pattern is late/exhausted — entering now would be a chase.";
    warnings.push(confidenceCapReason);
  } else if (status === "forming") {
    labelHint = display.chartReadConfidenceLow ? "forming_setup" : "needs_confirmation";
    confidenceCeiling = Math.min(confidenceCeiling, FORMING_CONF_CAP);
    qualityCeiling = minQuality(qualityCeiling, display.chartReadConfidenceLow ? "low" : "medium");
    conditional = true;
    edgeAdjustment = -5;
    confidenceCapReason = "Pattern is forming, not confirmed — waiting for the trigger.";
  } else if (status === "confirmed") {
    // A confirmed pattern MAY nudge the read up — but ONLY if the feed is
    // genuinely live-confirmed, sufficiency allows a setup, momentum agrees, it
    // does not conflict with the trend, and room is not limited. Otherwise it
    // stays neutral/supportive-context. It can never produce READY_NOW itself.
    const canSupport =
      !contextOnly &&
      context.momentumAligned &&
      !conflictsWithTrend &&
      !limitedRoom &&
      !display.chartReadConfidenceLow;
    if (canSupport) {
      labelHint = "supportive";
      supportive = true;
      edgeAdjustment = 10;
    } else {
      labelHint = "needs_confirmation";
      conditional = true;
      qualityCeiling = minQuality(qualityCeiling, "medium");
    }
  }

  // Conflict downgrade (applies on top of the lifecycle band).
  if (conflictsWithTrend && status !== "failed" && status !== "invalidated") {
    labelHint = "mixed_conditional";
    conditional = true;
    supportive = false;
    edgeAdjustment = Math.min(edgeAdjustment, -10);
    qualityCeiling = minQuality(qualityCeiling, "medium");
    const reason = "Pattern bias conflicts with the chart read / higher-timeframe trend.";
    confidenceCapReason ??= reason;
    warnings.push(reason);
  }

  // Limited room downgrade (cap quality, never block on its own).
  if (limitedRoom && status !== "failed" && status !== "invalidated") {
    if (labelHint === "supportive" || labelHint === "none") labelHint = "limited_room";
    supportive = false;
    edgeAdjustment = Math.min(edgeAdjustment, 0);
    qualityCeiling = minQuality(qualityCeiling, "medium");
    confidenceCapReason ??= "Target room is limited by nearby support/resistance.";
  }

  // Feed not live-confirmed → patterns are CONTEXT ONLY. Highest-precedence cap.
  if (contextOnly) {
    labelHint = status === "none" ? "none" : "context_only";
    confidenceCeiling = Math.min(confidenceCeiling, CONTEXT_ONLY_CONF_CAP);
    qualityCeiling = minQuality(qualityCeiling, "low");
    conditional = true;
    supportive = false;
    edgeAdjustment = Math.min(edgeAdjustment, 0);
    confidenceCapReason = display.feedStale
      ? "Feed is delayed — pattern shown as context only, not live-confirmed."
      : !display.sufficiencyAllowsSetup
        ? "Not enough live data — pattern shown as context only."
        : "Feed not live-confirmed — pattern shown as context only.";
    warnings.push(confidenceCapReason);
  }

  const confidence = Math.min(clampConfidence(dominant.confidence), confidenceCeiling);
  const quality = minQuality(dominant.quality, qualityCeiling);

  const rubyExplanation = buildPatternExplanation({
    dominant,
    status,
    labelHint,
    contextOnly,
    conflictsWithTrend,
    limitedRoom,
    chaseRisk,
    rewardRiskRatio,
  });

  return {
    detectedPatterns,
    dominantPattern: dominant,
    bias,
    confidence,
    quality,
    status,
    confirmationLevel: dominant.levels.confirmation,
    invalidationLevel: dominant.levels.invalidation,
    targets: dominant.levels.targets,
    context,
    rrContext: { rewardRiskRatio, limitedRoom },
    falseBreakoutRisk: dominant.falseBreakoutRisk,
    chaseRisk,
    confidenceCapReason,
    scannerTruthImpact: {
      labelHint,
      confidenceCeiling,
      qualityCeiling,
      conditional,
      contextOnly,
      edgeAdjustment,
      supportive,
    },
    rubyExplanation,
    warnings: dedupe([...warnings, ...dominant.failureModes]),
  };
}

function computeRewardRisk(p: DetectedPattern): number | null {
  const { confirmation, invalidation, targets } = p.levels;
  const target = targets[0];
  if (
    confirmation == null ||
    invalidation == null ||
    target == null ||
    !Number.isFinite(confirmation) ||
    !Number.isFinite(invalidation) ||
    !Number.isFinite(target)
  ) {
    return null;
  }
  const risk = Math.abs(confirmation - invalidation);
  const reward = Math.abs(target - confirmation);
  if (risk <= 0) return null;
  return Math.round((reward / risk) * 100) / 100;
}

function computeLimitedRoom(p: DetectedPattern, context: PatternContext): boolean {
  // Limited room when the nearest target is within ~1 ATR of a blocking S/R that
  // the price must pass through, signalled by the caller via nearSupportResistance
  // + a small ATR distance to the next level.
  if (!context.nearSupportResistance) return false;
  if (context.distanceToSrAtr == null) return false;
  return context.distanceToSrAtr <= 1;
}

function buildPatternExplanation(args: {
  dominant: DetectedPattern;
  status: PatternStatus;
  labelHint: PatternScannerLabelHint;
  contextOnly: boolean;
  conflictsWithTrend: boolean;
  limitedRoom: boolean;
  chaseRisk: boolean;
  rewardRiskRatio: number | null;
}): string {
  const { dominant, status, contextOnly, conflictsWithTrend, limitedRoom, chaseRisk } = args;
  const name = dominant.name;
  const dir =
    dominant.bias === "bullish" ? "bullish" : dominant.bias === "bearish" ? "bearish" : "neutral";

  const parts: string[] = [];
  switch (status) {
    case "forming":
      parts.push(`${name} (${dir}) is forming, not fully confirmed yet.`);
      break;
    case "confirmed":
      parts.push(`${name} (${dir}) has confirmed on closed candles.`);
      break;
    case "exhausted":
      parts.push(`${name} (${dir}) already played out — it looks late/exhausted.`);
      break;
    case "failed":
      parts.push(`${name} (${dir}) failed — the breakout did not hold.`);
      break;
    case "invalidated":
      parts.push(`${name} (${dir}) is invalidated — price broke the invalidation level.`);
      break;
    default:
      parts.push(`${name} (${dir}).`);
  }

  if (dominant.levels.confirmation != null) {
    parts.push(`Confirms on a break/hold of ${dominant.levels.confirmation}.`);
  }
  if (dominant.levels.invalidation != null) {
    parts.push(`Invalidates if price goes through ${dominant.levels.invalidation}.`);
  }
  if (conflictsWithTrend) {
    parts.push("It works against the higher-timeframe trend, so treat it as conditional.");
  }
  if (limitedRoom) {
    parts.push("There is limited room to the next support/resistance.");
  }
  if (chaseRisk) {
    parts.push("Avoid chasing — wait for a fresh setup or a pullback.");
  }
  if (contextOnly) {
    parts.push("Feed is not live-confirmed, so treat this pattern as context only.");
  }
  return parts.join(" ");
}

function dedupe(xs: string[]): string[] {
  return [...new Set(xs.filter((x) => x && x.trim().length > 0))];
}
