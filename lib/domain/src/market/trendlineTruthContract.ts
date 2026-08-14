// ── TRENDLINE TRUTH — DISPLAY / DECISION-SUPPORT CONTRACT (Task #649, Phase 2) ─
//
// SHARED, PURE definition of "what trendline structure (if any) is on this
// symbol/timeframe, how confident/confirmed is it, has it just broken / retested
// / reclaimed / failed, has the trend or pattern just changed, and how may that
// COLOUR the existing Scanner Truth + Pattern Truth read?". The geometry detector
// (api-server) produces the raw `ActiveTrendline[]` + change blocks; this contract
// folds them — together with the caller's ALREADY-DECIDED feed/sufficiency facts —
// into one `TrendlineTruthVerdict` that the Scanner, Ruby, and Pattern Truth all
// consume so they can never contradict each other about a trendline.
//
// This module is PURE: no IO, no DB, no HTTP, no clock, no role/privilege input.
// Same inputs ⇒ same verdict.
//
// ── SAFETY: TRENDLINE TRUTH IS A *CHILD INPUT*, DISPLAY-ONLY ─────────────────
// A trendline (or a trend/pattern change) may only RAISE-WITHIN-CAP or LOWER what
// the user SEES — setup quality, display confidence (bounded by the caller's
// existing caps), explanation wording, edge score, chase/too-late classification,
// break/retest/trap/trend-changed labelling, and conditional-vs-confirmed
// labelling. A trendline may NEVER:
//   • independently produce READY_NOW / "ready now" / "valid now" wording,
//   • override historical-only / feed-limited / unconfirmed-feed status,
//   • override a low-confidence chart read, trade-health eligibility, sufficiency,
//     candle-count, or a risk gate,
//   • influence live-execution permission, broker dispatch, the kill switch,
//     owner/admin overrides, or the final trade-execution button.
// The verdict therefore exposes ONLY display hints (`scannerTruthImpact`,
// confidence ceilings, wording). It carries NO execution-permission field, and
// the import-boundary CI guard keeps every execution/safety module from reading
// the display-only readability surfaces this layer is built to respect. The caller
// ALWAYS ANDs a positive impact with the real feed/sufficiency/risk state — a
// trendline can only ever make the existing verdict the SAME or MORE conservative,
// except for a small, cap-bounded supportive nudge that is itself gated on a
// genuinely confirmed trendline *and* a live-confirmed feed.

export type TrendlineCategory =
  | "trend_support" // a rising/falling line price holds ABOVE (demand)
  | "trend_resistance" // a rising/falling line price holds BELOW (supply)
  | "channel" // two parallel lines bounding a directional move
  | "horizontal"; // a flat support/resistance boundary (range edge)

export type TrendlineBias = "bullish" | "bearish" | "neutral";

/**
 * Lifecycle status of a trendline.
 *   none        → nothing detected (the common case; never downgrades).
 *   forming     → a line fit by ≥2 swings but not yet validated by a 3rd touch.
 *   confirmed   → validated by ≥3 touches and price respecting the line.
 *   broken      → a close beyond the line by an ATR-normalized distance.
 *   retesting   → after a break, price has returned to the broken line.
 *   reclaimed   → after a break, price closed back on the original side.
 *   failed      → a break that immediately reversed (trap / false break).
 *   exhausted   → an over-extended run far from the line — chasing is dangerous.
 */
export type TrendlineStatus =
  | "none"
  | "forming"
  | "confirmed"
  | "broken"
  | "retesting"
  | "reclaimed"
  | "failed"
  | "exhausted";

export type TrendlineQuality = "high" | "medium" | "low" | "none";

export type TrendlineRiskBand = "low" | "medium" | "high";

/** A discrete trendline EVENT the detector observed on the dominant line. */
export type TrendlineChangeKind =
  | "none" // no change event
  | "break" // close beyond the line by an ATR-normalized distance
  | "retest" // price returned to the broken line from the new side
  | "reclaim" // price closed back on the original side after a break
  | "failure" // a break that reversed immediately (trap / false break)
  | "acceleration" // slope steepening — momentum building
  | "flattening"; // slope decaying toward zero — trend losing energy

/** A higher-order structural transition spanning trendlines / patterns. */
export type PatternChangeKind =
  | "none"
  | "confirmation" // a forming structure just confirmed
  | "invalidation" // a structure's invalidation level was violated
  | "failure" // a confirmed breakout turned into a trap
  | "transition" // one structure is morphing into another
  | "exhaustion" // a confirmed move is over-extended / late
  | "reversal_warning" // early evidence the prevailing trend may reverse
  | "trend_shift_bullish" // resistance break + higher lows → up
  | "trend_shift_bearish" // support break + lower highs → down
  | "trend_to_range" // a trend flattened into a range
  | "range_to_trend"; // a range broke into a trend

/** Coarse market posture used to describe a pattern change's from/to. */
export type TrendPosture = "uptrend" | "downtrend" | "range" | "unknown";

/** Stable display hint describing how trendlines colour the Scanner Truth read. */
export type TrendlineScannerLabelHint =
  | "none" // no detected trendline — no wording change
  | "context_only" // feed historical/unconfirmed → trendline is context only
  | "forming_line" // forming → "line forming / needs a confirming touch"
  | "needs_confirmation" // break/retest present but not yet confirmed
  | "break_unconfirmed" // wick-only / not-yet-closed-beyond break
  | "retest_watch" // a broken line is being retested
  | "trap_risk" // failed break / false break (trap)
  | "too_late_chase" // exhausted/over-extended → "too late to chase"
  | "trend_changed" // a trend shift / pattern change just printed
  | "mixed_conditional" // trendline conflicts with chart read / HTF bias
  | "limited_room" // target sits inside nearby S/R
  | "supportive"; // confirmed + aligned → may nudge quality within caps

export interface TrendlineLevels {
  /** Trigger that confirms the trendline read (break/hold level). */
  confirmation: number | null;
  /** Structural level whose violation invalidates the read. */
  invalidation: number | null;
  /** Measured-move / projected target(s), nearest first. */
  targets: number[];
}

export interface TrendlineKeyPoint {
  index: number;
  price: number;
  role: string; // e.g. "anchor", "touch", "break", "retest", "channel_top"
}

/** One trendline the detector measured on the candles (raw, pre-display-fold). */
export interface ActiveTrendline {
  /** Stable machine key — MUST match a `trendlineLibrary` id. */
  id: string;
  /** Human label, e.g. "Ascending Support". */
  name: string;
  category: TrendlineCategory;
  bias: TrendlineBias;
  status: TrendlineStatus;
  /** Raw geometric confidence 0–100 BEFORE any display cap. */
  confidence: number;
  quality: TrendlineQuality;
  /** Swing touches validating the line (≥2; 3+ raises quality). */
  touchCount: number;
  /** Fitted slope per candle index, in price units (sign = direction). */
  slope: number;
  /** The line's price at the latest closed candle (null if unknown). */
  currentLevel: number | null;
  levels: TrendlineLevels;
  keyPoints: TrendlineKeyPoint[];
  /** Measurable conditions that were satisfied (for explanation + audit). */
  rationale: string[];
  /** Known ways this trendline read fails (surfaced as honest warnings). */
  failureModes: string[];
  /** Minimum closed candles this trendline needs to be detectable. */
  minCandles: number;
  /** Risk that an apparent break is a false one. */
  falseBreakoutRisk: TrendlineRiskBand;
}

/** A discrete trendline event block on the dominant line. */
export interface TrendlineChange {
  kind: TrendlineChangeKind;
  /** Direction the change implies (e.g. a support break is bearish). */
  bias: TrendlineBias;
  /** Plain reason, or null when `kind === "none"`. */
  reason: string | null;
  /** Level that confirms the change (close-beyond / retest-hold level). */
  confirmationLevel: number | null;
  /** Level whose violation negates the change. */
  invalidationLevel: number | null;
  /** True only when close-beyond + ATR distance fired (never wick-only). */
  confirmed: boolean;
}

/** A higher-order structural transition block. */
export interface PatternChange {
  kind: PatternChangeKind;
  from: TrendPosture;
  to: TrendPosture;
  /** Plain reason, or null when `kind === "none"`. */
  reason: string | null;
  confirmationLevel: number | null;
  invalidationLevel: number | null;
}

/**
 * DISPLAY-ONLY downgrade/within-cap hints. The caller folds these into the
 * existing Scanner Truth verdict. EVERY field can only make the read the same or
 * MORE conservative, except `edgeAdjustment`/`supportive`, which may add a small
 * bounded nudge ONLY when `supportive` (a confirmed trendline on a live-confirmed
 * feed). NONE of these is an execution permission.
 */
export interface TrendlineScannerImpact {
  labelHint: TrendlineScannerLabelHint;
  /** Hard ceiling for display confidence (0–100); the caller never raises above it. */
  confidenceCeiling: number;
  /** Hard ceiling for display quality; the caller never raises above it. */
  qualityCeiling: TrendlineQuality;
  /** Forces conditional-vs-confirmed wording ("if X then" rather than "valid now"). */
  conditional: boolean;
  /** Feed historical/unconfirmed → all trendline wording is context only. */
  contextOnly: boolean;
  /**
   * Bounded edge-score adjustment in [-25, +10]. Positive ONLY when supportive
   * (confirmed trendline + live-confirmed feed + aligned); otherwise ≤ 0.
   */
  edgeAdjustment: number;
  /** True only for `supportive`: the caller MAY (still within its own caps) let
   *  a confirmed-trendline read keep a higher band. Never grants READY_NOW. */
  supportive: boolean;
}

export interface TrendlineTruthVerdict {
  activeTrendlines: ActiveTrendline[];
  dominantTrendline: ActiveTrendline | null;
  bias: TrendlineBias;
  /** Display confidence 0–100 AFTER caps (never exceeds the dominant raw value). */
  confidence: number;
  quality: TrendlineQuality;
  status: TrendlineStatus;
  confirmationLevel: number | null;
  invalidationLevel: number | null;
  targets: number[];
  trendlineChange: TrendlineChange;
  patternChange: PatternChange;
  falseBreakoutRisk: TrendlineRiskBand;
  /** True when entry now would be a chase (exhausted / over-extended). */
  chaseRisk: boolean;
  /** Why display confidence/quality was capped, or null when nothing capped it. */
  confidenceCapReason: string | null;
  scannerTruthImpact: TrendlineScannerImpact;
  /** Plain-language explanation (pre feed-honesty neutralization at the surface). */
  rubyExplanation: string;
  warnings: string[];
}

export interface TrendlineContext {
  /** Higher-timeframe / structural trend bias the read already established. */
  trend: TrendlineBias;
  /** True when price is at/into a meaningful S/R level. */
  nearSupportResistance: boolean;
  /** Distance to the nearest blocking S/R in ATR units (null if unknown). */
  distanceToSrAtr: number | null;
  /** True when momentum agrees with the trendline bias. */
  momentumAligned: boolean;
  /** ATR used for geometry normalization (null if unknown). */
  volatilityAtr: number | null;
}

/**
 * The caller's ALREADY-DECIDED display facts. Passed as primitives so this pure
 * contract never imports the sufficiency / trade-health / feed modules (keeping
 * it decoupled and the import boundary clean). Each flag describes the read the
 * trendline is colouring — the trendline NEVER recomputes them.
 */
export interface TrendlineDisplayContext {
  /** True when the feed is genuinely live-confirmed (LIVE + FULL read). */
  feedConfirmed: boolean;
  /** True when the feed is delayed/stale (read uses last closed bars only). */
  feedStale: boolean;
  /** True when sufficiency already allows showing a trade setup (canShowTradeSetup). */
  sufficiencyAllowsSetup: boolean;
  /** True when the chart-read structural confidence is LOW. */
  chartReadConfidenceLow: boolean;
}

const QUALITY_RANK: Record<TrendlineQuality, number> = {
  none: 0,
  low: 1,
  medium: 2,
  high: 3,
};

const STATUS_RANK: Record<TrendlineStatus, number> = {
  none: 0,
  failed: 1,
  exhausted: 2,
  broken: 3,
  retesting: 3,
  reclaimed: 3,
  forming: 4,
  confirmed: 5,
};

function minQuality(a: TrendlineQuality, b: TrendlineQuality): TrendlineQuality {
  return QUALITY_RANK[a] <= QUALITY_RANK[b] ? a : b;
}

function clampConfidence(n: number): number {
  if (!Number.isFinite(n)) return 0;
  return Math.max(0, Math.min(100, Math.round(n)));
}

/**
 * Pick the dominant trendline: highest status rank first (confirmed > forming >
 * broken/retesting/reclaimed > exhausted > failed), then more touches, then
 * highest raw confidence. Deterministic tie-break on the stable id.
 */
function pickDominant(lines: ActiveTrendline[]): ActiveTrendline | null {
  if (lines.length === 0) return null;
  return [...lines].sort((a, b) => {
    const s = STATUS_RANK[b.status] - STATUS_RANK[a.status];
    if (s !== 0) return s;
    const t = b.touchCount - a.touchCount;
    if (t !== 0) return t;
    const c = b.confidence - a.confidence;
    if (c !== 0) return c;
    return a.id.localeCompare(b.id);
  })[0]!;
}

const CONTEXT_ONLY_CONF_CAP = 35;
const FORMING_CONF_CAP = 60;
const EXHAUSTED_CONF_CAP = 40;
const UNCONFIRMED_BREAK_CONF_CAP = 50;
const TRAP_CONF_CAP = 25;

const NONE_CHANGE: TrendlineChange = {
  kind: "none",
  bias: "neutral",
  reason: null,
  confirmationLevel: null,
  invalidationLevel: null,
  confirmed: false,
};

const NONE_PATTERN_CHANGE: PatternChange = {
  kind: "none",
  from: "unknown",
  to: "unknown",
  reason: null,
  confirmationLevel: null,
  invalidationLevel: null,
};

/**
 * Build the ONE shared trendline verdict from the detector's raw trendlines +
 * change blocks + the caller's display facts. The result's `scannerTruthImpact`
 * is downgrade-only (with a small bounded supportive nudge gated on a confirmed
 * trendline AND a live-confirmed feed). It can never make the read MORE
 * permissive than the feed/sufficiency already allow.
 */
export function resolveTrendlineTruth(
  activeTrendlines: ActiveTrendline[],
  context: TrendlineContext,
  display: TrendlineDisplayContext,
  trendlineChange: TrendlineChange = NONE_CHANGE,
  patternChange: PatternChange = NONE_PATTERN_CHANGE,
): TrendlineTruthVerdict {
  const dominant = pickDominant(activeTrendlines);
  const warnings: string[] = [];

  if (!dominant) {
    return {
      activeTrendlines,
      dominantTrendline: null,
      bias: "neutral",
      confidence: 0,
      quality: "none",
      status: "none",
      confirmationLevel: null,
      invalidationLevel: null,
      targets: [],
      trendlineChange,
      patternChange,
      falseBreakoutRisk: "low",
      chaseRisk: false,
      confidenceCapReason: null,
      scannerTruthImpact: {
        labelHint: patternChange.kind === "none" ? "none" : "trend_changed",
        confidenceCeiling: 100,
        qualityCeiling: "high",
        conditional: patternChange.kind !== "none",
        contextOnly: false,
        edgeAdjustment: 0,
        supportive: false,
      },
      rubyExplanation:
        patternChange.kind === "none"
          ? "No clear trendline structure on this timeframe yet."
          : `Structure change detected (${patternChange.reason ?? patternChange.kind}).`,
      warnings,
    };
  }

  const status = dominant.status;
  const bias = dominant.bias;
  const contextOnly =
    !display.feedConfirmed || display.feedStale || !display.sufficiencyAllowsSetup;

  // Conflicts with the established chart-read / HTF trend.
  const conflictsWithTrend =
    context.trend !== "neutral" && bias !== "neutral" && context.trend !== bias;

  // RR + limited-room (target inside nearby S/R).
  const limitedRoom = computeLimitedRoom(context);
  if (limitedRoom) {
    warnings.push("Nearest target sits inside nearby support/resistance — limited room.");
  }

  // ── Display caps + label, downgrade-only (highest-precedence cap wins) ──────
  let confidenceCeiling = 100;
  let qualityCeiling: TrendlineQuality = "high";
  let conditional = false;
  let edgeAdjustment = 0;
  let supportive = false;
  let labelHint: TrendlineScannerLabelHint = "none";
  let confidenceCapReason: string | null = null;
  let chaseRisk = false;

  if (status === "failed") {
    labelHint = "trap_risk";
    confidenceCeiling = Math.min(confidenceCeiling, TRAP_CONF_CAP);
    qualityCeiling = "none";
    conditional = true;
    edgeAdjustment = -25;
    confidenceCapReason = "Trendline break failed — price reversed (trap / false break).";
    warnings.push(confidenceCapReason);
  } else if (status === "exhausted") {
    labelHint = "too_late_chase";
    chaseRisk = true;
    confidenceCeiling = Math.min(confidenceCeiling, EXHAUSTED_CONF_CAP);
    qualityCeiling = minQuality(qualityCeiling, "low");
    conditional = true;
    edgeAdjustment = -15;
    confidenceCapReason = "Move is over-extended from the line — entering now would be a chase.";
    warnings.push(confidenceCapReason);
  } else if (status === "broken" || status === "retesting") {
    // A break/retest is only meaningful once confirmed by close-beyond + ATR.
    const confirmed = trendlineChange.confirmed;
    labelHint = status === "retesting" ? "retest_watch" : confirmed ? "needs_confirmation" : "break_unconfirmed";
    confidenceCeiling = Math.min(confidenceCeiling, confirmed ? FORMING_CONF_CAP : UNCONFIRMED_BREAK_CONF_CAP);
    qualityCeiling = minQuality(qualityCeiling, confirmed ? "medium" : "low");
    conditional = true;
    edgeAdjustment = confirmed ? -5 : -10;
    confidenceCapReason = confirmed
      ? "Line broke — waiting for a retest/hold to confirm the new side."
      : "Break is not confirmed (no decisive close beyond the line yet).";
  } else if (status === "reclaimed") {
    labelHint = "needs_confirmation";
    confidenceCeiling = Math.min(confidenceCeiling, FORMING_CONF_CAP);
    qualityCeiling = minQuality(qualityCeiling, "medium");
    conditional = true;
    edgeAdjustment = -5;
    confidenceCapReason = "Line was reclaimed — the prior break did not hold.";
  } else if (status === "forming") {
    labelHint = "forming_line";
    confidenceCeiling = Math.min(confidenceCeiling, FORMING_CONF_CAP);
    qualityCeiling = minQuality(qualityCeiling, display.chartReadConfidenceLow ? "low" : "medium");
    conditional = true;
    edgeAdjustment = -5;
    confidenceCapReason = "Trendline is forming, not yet validated by a third touch.";
  } else if (status === "confirmed") {
    // A confirmed trendline MAY nudge the read up — but ONLY if the feed is
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

  // A printed trend/pattern change downgrades to "trend_changed" wording and
  // forces conditional (the prevailing read is in flux). Never supportive.
  if (patternChange.kind !== "none") {
    if (labelHint === "supportive" || labelHint === "none" || labelHint === "needs_confirmation") {
      labelHint = "trend_changed";
    }
    conditional = true;
    supportive = false;
    edgeAdjustment = Math.min(edgeAdjustment, 0);
    qualityCeiling = minQuality(qualityCeiling, "medium");
    const reason = patternChange.reason ?? "Market structure is changing.";
    confidenceCapReason ??= reason;
    warnings.push(reason);
  }

  // Conflict downgrade (applies on top of the lifecycle band).
  if (conflictsWithTrend && status !== "failed") {
    labelHint = "mixed_conditional";
    conditional = true;
    supportive = false;
    edgeAdjustment = Math.min(edgeAdjustment, -10);
    qualityCeiling = minQuality(qualityCeiling, "medium");
    const reason = "Trendline bias conflicts with the chart read / higher-timeframe trend.";
    confidenceCapReason ??= reason;
    warnings.push(reason);
  }

  // Limited room downgrade (cap quality, never block on its own).
  if (limitedRoom && status !== "failed") {
    if (labelHint === "supportive" || labelHint === "none") labelHint = "limited_room";
    supportive = false;
    edgeAdjustment = Math.min(edgeAdjustment, 0);
    qualityCeiling = minQuality(qualityCeiling, "medium");
    confidenceCapReason ??= "Target room is limited by nearby support/resistance.";
  }

  // Feed not live-confirmed → trendlines are CONTEXT ONLY. Highest-precedence cap.
  if (contextOnly) {
    labelHint = status === "none" ? "none" : "context_only";
    confidenceCeiling = Math.min(confidenceCeiling, CONTEXT_ONLY_CONF_CAP);
    qualityCeiling = minQuality(qualityCeiling, "low");
    conditional = true;
    supportive = false;
    edgeAdjustment = Math.min(edgeAdjustment, 0);
    confidenceCapReason = display.feedStale
      ? "Feed is delayed — trendline shown as context only, not live-confirmed."
      : !display.sufficiencyAllowsSetup
        ? "Not enough live data — trendline shown as context only."
        : "Feed not live-confirmed — trendline shown as context only.";
    warnings.push(confidenceCapReason);
  }

  const confidence = Math.min(clampConfidence(dominant.confidence), confidenceCeiling);
  const quality = minQuality(dominant.quality, qualityCeiling);

  const rubyExplanation = buildTrendlineExplanation({
    dominant,
    status,
    contextOnly,
    conflictsWithTrend,
    limitedRoom,
    chaseRisk,
    trendlineChange,
    patternChange,
  });

  return {
    activeTrendlines,
    dominantTrendline: dominant,
    bias,
    confidence,
    quality,
    status,
    confirmationLevel: dominant.levels.confirmation,
    invalidationLevel: dominant.levels.invalidation,
    targets: dominant.levels.targets,
    trendlineChange,
    patternChange,
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

function computeLimitedRoom(context: TrendlineContext): boolean {
  // Limited room when the nearest target is within ~1 ATR of a blocking S/R that
  // the price must pass through, signalled by the caller via nearSupportResistance
  // + a small ATR distance to the next level.
  if (!context.nearSupportResistance) return false;
  if (context.distanceToSrAtr == null) return false;
  return context.distanceToSrAtr <= 1;
}

function buildTrendlineExplanation(args: {
  dominant: ActiveTrendline;
  status: TrendlineStatus;
  contextOnly: boolean;
  conflictsWithTrend: boolean;
  limitedRoom: boolean;
  chaseRisk: boolean;
  trendlineChange: TrendlineChange;
  patternChange: PatternChange;
}): string {
  const { dominant, status, contextOnly, conflictsWithTrend, limitedRoom, chaseRisk } = args;
  const { trendlineChange, patternChange } = args;
  const name = dominant.name;
  const dir =
    dominant.bias === "bullish" ? "bullish" : dominant.bias === "bearish" ? "bearish" : "neutral";

  const parts: string[] = [];
  switch (status) {
    case "forming":
      parts.push(`${name} (${dir}) is forming on ${dominant.touchCount} touches, not yet validated.`);
      break;
    case "confirmed":
      parts.push(`${name} (${dir}) is confirmed by ${dominant.touchCount} touches.`);
      break;
    case "broken":
      parts.push(`${name} (${dir}) has broken${trendlineChange.confirmed ? " on a decisive close" : " — but not yet confirmed"}.`);
      break;
    case "retesting":
      parts.push(`${name} (${dir}) broke and price is now retesting the line.`);
      break;
    case "reclaimed":
      parts.push(`${name} (${dir}) was reclaimed — the prior break did not hold.`);
      break;
    case "failed":
      parts.push(`${name} (${dir}) break failed — price reversed (trap).`);
      break;
    case "exhausted":
      parts.push(`${name} (${dir}) move is over-extended from the line.`);
      break;
    default:
      parts.push(`${name} (${dir}).`);
  }

  if (patternChange.kind !== "none" && patternChange.reason) {
    parts.push(patternChange.reason);
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
    parts.push("Avoid chasing — wait for a retest or a fresh setup.");
  }
  if (contextOnly) {
    parts.push("Feed is not live-confirmed, so treat this trendline as context only.");
  }
  return parts.join(" ");
}

function dedupe(xs: string[]): string[] {
  return [...new Set(xs.filter((x) => x && x.trim().length > 0))];
}
