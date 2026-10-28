// (M) Build M — Multi-Timeframe Analysis Engine (pure domain).
//
// This module is *pure* — no DB, no HTTP, no broker calls. Inputs are arrays
// of OHLC candles per timeframe; outputs are trend snapshots, alignment
// labels, alignment scores, best directional bias, and a human-readable AI
// summary. The api-server's mtfReportService composes these with
// dataManager.getCandles to persist reports.
//
// Design notes:
// - Two existing engines already exist (confidence-gate/multiTimeframeScore,
//   execution-pyramid/multiTimeframe) but they consume an *already-computed*
//   { trend, strength } per timeframe — they do not detect trend from candles.
//   Build M provides the missing detector + the user-facing report shape.
// - Higher timeframes carry more weight (matches existing TF_WEIGHT scheme).
// - SAFETY: this module never claims certainty. The bestBias is "preferred
//   directional bias", not a buy/sell signal. Mixed alignment yields NEUTRAL
//   so the trade plan checklist treats it as a soft warning, not a blocker.
// - TRUTH: a timeframe with fewer than MIN_CANDLES_FOR_TREND candles was not
//   observed. It is reported as INSUFFICIENT_DATA — never as SIDEWAYS — and
//   the report's alignment is INSUFFICIENT_DATA, so "sideways" is never shown
//   for a market whose candles never arrived.
// - TRUTH: an alignment is only a current read when every timeframe's newest
//   bar is current (opened within the last two bars of that timeframe). Each
//   snapshot carries its newest bar time, freshness and serving source; when
//   any timeframe is stale or has no timestamp the report is DATA_NOT_CURRENT
//   with no bias — a weekend series never yields a confident alignment.

export type Trend = "UP" | "DOWN" | "SIDEWAYS" | "INSUFFICIENT_DATA";
export type Bias = "BUY" | "SELL" | "NEUTRAL";

export const ALIGNMENT_LABELS = [
  "STRONG_BULLISH_ALIGNMENT",
  "STRONG_BEARISH_ALIGNMENT",
  "MIXED_ALIGNMENT",
  "LOWER_TIMEFRAME_CONFLICT",
  "HIGHER_TIMEFRAME_WARNING",
  "NO_CLEAR_BIAS",
  "INSUFFICIENT_DATA",
  "DATA_NOT_CURRENT",
] as const;
export type AlignmentLabel = typeof ALIGNMENT_LABELS[number];

// Weight scheme matches both existing engines so downstream consumers stay
// consistent. M5..D1 → 1..5.
export const TIMEFRAME_WEIGHT: Record<string, number> = {
  M1: 1, M5: 1, M15: 2, M30: 2, H1: 3, H4: 4, D1: 5, W1: 6,
};

export interface CandleLike {
  open: number;
  high: number;
  low: number;
  close: number;
  /** Bar open time (ISO string or epoch ms). Needed to say whether a read is current. */
  time?: string | number;
}

/** CURRENT: newest bar opened within two bars; STALE: older; UNKNOWN: no usable time. */
export type TimeframeFreshness = "CURRENT" | "STALE" | "UNKNOWN";

export interface TrendSnapshot {
  trend: Trend;
  strength: number;        // 0..100 — magnitude of move relative to ATR-ish range
  slope: number;           // signed normalized slope of recent closes
  fastSma: number;
  slowSma: number;
  candlesUsed: number;
  /** Newest bar's open time (ISO), or null when the bars carried none. Absent on legacy rows. */
  newestBarTime?: string | null;
  /** Whether the newest bar is current. Absent on legacy rows. */
  freshness?: TimeframeFreshness;
  /** Provider that served the bars ("mt5_broker", "deriv:…"), or null when not reported. */
  source?: string | null;
}

// ── Freshness ────────────────────────────────────────────────────────────

/** Bar interval per timeframe label. */
export const TIMEFRAME_INTERVAL_MS: Record<string, number> = {
  M1: 60_000, M5: 300_000, M15: 900_000, M30: 1_800_000,
  H1: 3_600_000, H4: 14_400_000, D1: 86_400_000, W1: 604_800_000,
};

/** A newest bar older than this many intervals is not a current read. */
export const CURRENT_WITHIN_BARS = 2;

function barTimeMs(t: string | number | undefined): number | null {
  if (t == null) return null;
  const ms = typeof t === "number" ? t : Date.parse(t);
  return Number.isFinite(ms) ? ms : null;
}

/**
 * Freshness of a timeframe from its newest bar. CURRENT only when the bar has
 * a time, the timeframe is known, the time is not in the future (beyond one
 * bar of clock skew) and it opened within CURRENT_WITHIN_BARS intervals.
 */
export function assessTimeframeFreshness(
  timeframe: string,
  newest: CandleLike | null | undefined,
  nowMs: number,
): { freshness: TimeframeFreshness; newestBarTime: string | null; ageMs: number | null } {
  const openMs = barTimeMs(newest?.time);
  const interval = TIMEFRAME_INTERVAL_MS[timeframe];
  const newestBarTime = openMs == null ? null : new Date(openMs).toISOString();
  if (openMs == null || interval == null || !Number.isFinite(nowMs)) {
    return { freshness: "UNKNOWN", newestBarTime, ageMs: null };
  }
  const ageMs = nowMs - openMs;
  if (ageMs < -interval) return { freshness: "UNKNOWN", newestBarTime, ageMs };
  return { freshness: ageMs < CURRENT_WITHIN_BARS * interval ? "CURRENT" : "STALE", newestBarTime, ageMs };
}

const WEEKDAY = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"] as const;
function utcStamp(iso: string): string {
  const d = new Date(iso);
  return `${WEEKDAY[d.getUTCDay()]} ${String(d.getUTCHours()).padStart(2, "0")}:${String(d.getUTCMinutes()).padStart(2, "0")} UTC`;
}
function ageText(ms: number): string {
  const h = ms / 3_600_000;
  if (h >= 48) return `${Math.round(h / 24)}d ago`;
  if (h >= 1) return `${Math.round(h)}h ago`;
  return `${Math.max(1, Math.round(ms / 60_000))}m ago`;
}

// ── Trend detection ──────────────────────────────────────────────────────
// Pure SMA crossover + slope. Strength scales with the absolute slope
// normalized by recent range. Sideways when |slope| is small or fast/slow
// SMAs are within 0.05% of each other.

function sma(values: number[], window: number): number {
  if (values.length < window) return values.reduce((a, b) => a + b, 0) / Math.max(1, values.length);
  let sum = 0;
  for (let i = values.length - window; i < values.length; i++) sum += values[i]!;
  return sum / window;
}

function range(candles: CandleLike[]): number {
  let hi = -Infinity, lo = Infinity;
  for (const c of candles) { if (c.high > hi) hi = c.high; if (c.low < lo) lo = c.low; }
  return Math.max(0, hi - lo);
}

/** Fewest candles a timeframe needs before any trend is reported for it. */
export const MIN_CANDLES_FOR_TREND = 20;

export function detectTrend(candles: CandleLike[]): TrendSnapshot {
  const n = candles.length;
  if (n < MIN_CANDLES_FOR_TREND) {
    return { trend: "INSUFFICIENT_DATA", strength: 0, slope: 0, fastSma: 0, slowSma: 0, candlesUsed: n };
  }
  const closes = candles.map((c) => c.close);
  const fastWin = Math.min(20, Math.floor(n / 3));
  const slowWin = Math.min(50, n - 1);
  const fast = sma(closes, fastWin);
  const slow = sma(closes, slowWin);
  // Slope = % change of close between (n - slowWin) and now.
  const ref = closes[Math.max(0, n - slowWin)]!;
  const slopeRaw = ref === 0 ? 0 : (closes[n - 1]! - ref) / ref;
  const totalRange = range(candles.slice(-slowWin));
  const refPrice = closes[n - 1]!;
  // Strength: |slope| as % of price, scaled so 1% slope ≈ 50 strength.
  const strengthRaw = Math.min(100, Math.abs(slopeRaw) * 5000);
  const flatThreshold = Math.max(0.0005, totalRange / refPrice * 0.05);
  let trend: Trend;
  if (Math.abs(slopeRaw) < flatThreshold || Math.abs(fast - slow) / refPrice < 0.0005) {
    trend = "SIDEWAYS";
  } else if (fast > slow && slopeRaw > 0) {
    trend = "UP";
  } else if (fast < slow && slopeRaw < 0) {
    trend = "DOWN";
  } else {
    trend = "SIDEWAYS"; // disagreement between SMA and slope = no clean trend
  }
  return {
    trend,
    strength: Math.round(strengthRaw),
    slope: Number(slopeRaw.toFixed(6)),
    fastSma: Number(fast.toFixed(6)),
    slowSma: Number(slow.toFixed(6)),
    candlesUsed: n,
  };
}

// ── Alignment + bias ─────────────────────────────────────────────────────

export interface TimeframeReport {
  timeframe: string;
  snapshot: TrendSnapshot;
}

export interface AlignmentResult {
  alignmentScore: number;          // 0..100
  alignmentLabel: AlignmentLabel;
  bestBias: Bias;
  conflictWarning: string | null;
  reasons: string[];
}

// The trader-facing alignment classifier. Designed for the *report*: lower,
// middle, higher TF. Higher TF is the dominant voice.
export function classifyAlignment(
  lower: TimeframeReport,
  middle: TimeframeReport,
  higher: TimeframeReport,
): AlignmentResult {
  const unobserved = [lower, middle, higher].filter((tf) => tf.snapshot.trend === "INSUFFICIENT_DATA");
  if (unobserved.length > 0) {
    const list = unobserved
      .map((tf) => `${tf.timeframe} (${tf.snapshot.candlesUsed} of ${MIN_CANDLES_FOR_TREND} candles)`)
      .join(", ");
    const warning = `Not enough candles to read ${list}. Alignment was not measured — no trend or bias is reported for this symbol.`;
    return {
      alignmentScore: 0,
      alignmentLabel: "INSUFFICIENT_DATA",
      bestBias: "NEUTRAL",
      conflictWarning: warning,
      reasons: [warning],
    };
  }
  const reasons: string[] = [];
  const wL = TIMEFRAME_WEIGHT[lower.timeframe] ?? 1;
  const wM = TIMEFRAME_WEIGHT[middle.timeframe] ?? 2;
  const wH = TIMEFRAME_WEIGHT[higher.timeframe] ?? 4;

  // Score per direction: each TF contributes weight × strength when its trend
  // matches that direction; SIDEWAYS contributes half-weight to both.
  const scoreFor = (dir: "UP" | "DOWN") => {
    let aligned = 0, max = 0;
    for (const [tf, w] of [[lower, wL], [middle, wM], [higher, wH]] as const) {
      max += w * 100;
      if (tf.snapshot.trend === dir) aligned += w * tf.snapshot.strength;
      else if (tf.snapshot.trend === "SIDEWAYS") aligned += (w * tf.snapshot.strength) / 2;
    }
    return max > 0 ? Math.round((aligned / max) * 100) : 0;
  };
  const upScore = scoreFor("UP");
  const downScore = scoreFor("DOWN");
  const alignmentScore = Math.max(upScore, downScore);
  const dominantDir = upScore >= downScore ? "UP" : "DOWN";
  reasons.push(`UP score ${upScore}, DOWN score ${downScore}`);

  // Label classification — order matters; first matching label wins.
  let label: AlignmentLabel = "NO_CLEAR_BIAS";
  let conflictWarning: string | null = null;
  let bestBias: Bias = "NEUTRAL";

  const trends = { L: lower.snapshot.trend, M: middle.snapshot.trend, H: higher.snapshot.trend };
  const allUp   = trends.L === "UP" && trends.M === "UP" && trends.H === "UP";
  const allDown = trends.L === "DOWN" && trends.M === "DOWN" && trends.H === "DOWN";
  const htfDir = trends.H === "UP" ? "BUY" : trends.H === "DOWN" ? "SELL" : "NEUTRAL";

  if (allUp && alignmentScore >= 60) {
    label = "STRONG_BULLISH_ALIGNMENT"; bestBias = "BUY";
    reasons.push("All three timeframes trend UP with strong score.");
  } else if (allDown && alignmentScore >= 60) {
    label = "STRONG_BEARISH_ALIGNMENT"; bestBias = "SELL";
    reasons.push("All three timeframes trend DOWN with strong score.");
  } else if (trends.H !== "SIDEWAYS" && trends.M !== "SIDEWAYS" && trends.L !== "SIDEWAYS"
             && trends.H === trends.M && trends.L !== trends.H) {
    // Higher + middle agree, lower disagrees → LTF noise / pullback risk.
    label = "LOWER_TIMEFRAME_CONFLICT"; bestBias = htfDir;
    conflictWarning = `Lower timeframe (${lower.timeframe}) trends ${trends.L} against the higher-timeframe ${trends.H} bias. Possible pullback or fakeout — wait for ${lower.timeframe} confirmation.`;
    reasons.push(conflictWarning);
  } else if (trends.H !== "SIDEWAYS"
             && ((trends.L === trends.M && trends.M !== trends.H)
                 || (trends.L !== trends.H && trends.M !== trends.H))) {
    // Higher TF disagrees with the lower two → reversal or counter-HTF risk.
    label = "HIGHER_TIMEFRAME_WARNING"; bestBias = htfDir;
    conflictWarning = `Higher timeframe (${higher.timeframe}) trends ${trends.H} against shorter timeframes. Counter-HTF entries carry elevated reversal risk.`;
    reasons.push(conflictWarning);
  } else if (alignmentScore >= 50 && dominantDir !== undefined && trends.H !== "SIDEWAYS") {
    // SAFETY contract (see file header): mixed alignment yields NEUTRAL bias.
    // The dominant direction is surfaced in the warning text for context, but
    // we do not assign a directional bias when timeframes only partially agree.
    label = "MIXED_ALIGNMENT";
    bestBias = "NEUTRAL";
    const dominantWord = dominantDir === "UP" ? "BUY" : "SELL";
    conflictWarning = `Timeframes are partially aligned (dominant direction is ${dominantWord}). No clear directional bias — reduce size or wait for cleaner alignment.`;
    reasons.push(conflictWarning);
  } else {
    label = "NO_CLEAR_BIAS"; bestBias = "NEUTRAL";
    reasons.push("Insufficient alignment across timeframes; no preferred bias.");
  }

  return { alignmentScore, alignmentLabel: label, bestBias, conflictWarning, reasons };
}

/**
 * Downgrade an alignment built from bars that are not current. INSUFFICIENT_DATA
 * keeps precedence (nothing was read). Otherwise any STALE or UNKNOWN timeframe
 * makes the report DATA_NOT_CURRENT with no bias; the measured score and the
 * label the old bars would have earned are kept in the warning, never shown as
 * a current read.
 */
export function applyFreshness(
  lower: TimeframeReport,
  middle: TimeframeReport,
  higher: TimeframeReport,
  result: AlignmentResult,
  nowMs: number,
): AlignmentResult {
  if (result.alignmentLabel === "INSUFFICIENT_DATA") return result;
  const notCurrent = [lower, middle, higher].filter((tf) => tf.snapshot.freshness !== "CURRENT");
  if (notCurrent.length === 0) return result;
  const parts = notCurrent.map((tf) => {
    const t = tf.snapshot.newestBarTime;
    if (!t) return `${tf.timeframe} bars carry no timestamp, so their age could not be checked`;
    if (tf.snapshot.freshness === "UNKNOWN") return `${tf.timeframe} newest bar time (${t}) could not be checked against the clock`;
    return `${tf.timeframe} newest bar opened ${utcStamp(t)} (${ageText(nowMs - Date.parse(t))})`;
  });
  const was = result.alignmentLabel.replace(/_/g, " ").toLowerCase();
  const warning = `Not a current read: ${parts.join("; ")}. On these bars the timeframes showed ${was} (score ${result.alignmentScore}/100), but the market may be closed or the feed stalled, so no bias is given.`;
  return {
    alignmentScore: result.alignmentScore,
    alignmentLabel: "DATA_NOT_CURRENT",
    bestBias: "NEUTRAL",
    conflictWarning: warning,
    reasons: [...result.reasons, warning],
  };
}

// ── AI summary ───────────────────────────────────────────────────────────

export function summarizeAlignment(args: {
  symbol: string;
  lower: TimeframeReport;
  middle: TimeframeReport;
  higher: TimeframeReport;
  result: AlignmentResult;
}): string {
  const { symbol, lower, middle, higher, result } = args;
  if (result.alignmentLabel === "INSUFFICIENT_DATA") {
    const counts = [lower, middle, higher].map((tf) => `${tf.timeframe} ${tf.snapshot.candlesUsed}`).join(", ");
    return `${symbol}: not enough candles to analyse (candles received: ${counts}; ${MIN_CANDLES_FOR_TREND} needed per timeframe). No trend, alignment or bias is reported — the market data source returned too little history for this symbol.`;
  }
  if (result.alignmentLabel === "DATA_NOT_CURRENT") {
    const tfLine = [lower, middle, higher]
      .map((tf) => `${tf.timeframe} ${tf.snapshot.trend} (${tf.snapshot.strength}) as of ${tf.snapshot.newestBarTime ? utcStamp(tf.snapshot.newestBarTime) : "an unknown time"}`)
      .join(", ");
    return `${symbol}: data is not current — ${tfLine}. ${result.conflictWarning ?? ""} No trend, alignment or bias is reported as current. Final execution remains gated by the live-execution safety layer.`;
  }
  const dirText = result.bestBias === "NEUTRAL" ? "no preferred direction" : `${result.bestBias} bias`;
  const tfLine = `${lower.timeframe} ${lower.snapshot.trend} (${lower.snapshot.strength}), ${middle.timeframe} ${middle.snapshot.trend} (${middle.snapshot.strength}), ${higher.timeframe} ${higher.snapshot.trend} (${higher.snapshot.strength})`;
  const labelText = result.alignmentLabel.replace(/_/g, " ").toLowerCase();
  const warn = result.conflictWarning ? ` ${result.conflictWarning}` : "";
  // Mandatory closing disclaimer — never claim guaranteed profit.
  return `${symbol}: ${tfLine}. Alignment score ${result.alignmentScore}/100 (${labelText}); ${dirText}.${warn} This analysis describes observed conditions only — it is not a guarantee and final execution remains gated by the live-execution safety layer.`;
}

// Convenience — build full result given pre-fetched candles per TF.
export function buildReport(args: {
  symbol: string;
  lowerTimeframe: string;
  middleTimeframe: string;
  higherTimeframe: string;
  lowerCandles: CandleLike[];
  middleCandles: CandleLike[];
  higherCandles: CandleLike[];
  /** Clock the bars are judged against (defaults to now). */
  nowMs?: number;
  /** Provider that served each series, carried onto its snapshot. */
  sources?: { lower?: string | null; middle?: string | null; higher?: string | null };
}) {
  const nowMs = args.nowMs ?? Date.now();
  const snap = (tf: string, candles: CandleLike[], source: string | null | undefined): TimeframeReport => {
    const f = assessTimeframeFreshness(tf, candles[candles.length - 1], nowMs);
    return {
      timeframe: tf,
      snapshot: { ...detectTrend(candles), newestBarTime: f.newestBarTime, freshness: f.freshness, source: source ?? null },
    };
  };
  const lower  = snap(args.lowerTimeframe,  args.lowerCandles,  args.sources?.lower);
  const middle = snap(args.middleTimeframe, args.middleCandles, args.sources?.middle);
  const higher = snap(args.higherTimeframe, args.higherCandles, args.sources?.higher);
  const result = applyFreshness(lower, middle, higher, classifyAlignment(lower, middle, higher), nowMs);
  const aiSummary = summarizeAlignment({ symbol: args.symbol, lower, middle, higher, result });
  return { lower, middle, higher, result, aiSummary };
}
