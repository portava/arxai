// CHART TRENDLINE OVERLAY — display-only producer (Task #651).
//
// Turns the EXISTING trendline truth verdict (Task #649) into a slim, drawable,
// honesty-folded overlay for the ARX native chart. It COMPOSES the existing pure
// producers — `detectTrendlines` (engine) → `resolveTrendlineTruth` (domain
// contract) — and never re-derives geometry or invents a second verdict.
//
// HARD BOUNDARY:
//  - Display-only. This module produces NO trade affordance, touches NO live
//    execution gate, the 23-gate dispatch, the MT5 bridge, or any kill switch.
//  - No new data source: it reads the SAME normalized candle window the chart
//    intelligence already fetched. It never fabricates a bar, a point, or a line.
//  - Fail closed on honesty: when the feed is not live-confirmed (contextOnly),
//    the window is insufficient, or no trendline is detected, it emits NOTHING
//    drawable (`visible:false`, empty geometry) so the frontend cannot leak an
//    overlay onto an unconfirmed feed.
//
// Geometry is anchored in TIME (Unix seconds) so the frontend draws straight
// segments directly on the chart's time scale. keyPoint indices are mapped to
// candle `openTime` via the SAME `isComplete && !isForming` filter the detector
// uses, so an endpoint's time is always a real candle time.
import { detectTrendlines } from "./engines/trendlineEngine.js";
import type { NormalizedChartCandle } from "./candleNormalization.js";
import {
  resolveTrendlineTruth,
  type ActiveTrendline,
  type TrendlineBias,
  type TrendlineCategory,
  type TrendlineChangeKind,
  type TrendlineContext,
  type TrendlineDisplayContext,
  type TrendlineStatus,
} from "@workspace/domain/market";

/** A single time/price anchor on the chart's time scale (Unix seconds). */
export interface ChartTrendlinePoint {
  /** Bar open time, Unix seconds (UTC) — always a real candle time. */
  time: number;
  price: number;
}

/** One drawable straight segment derived from a detected trendline rail. */
export interface ChartTrendlineSegment {
  /** Stable key (channel rails suffix the base id with ":rail"). */
  id: string;
  name: string;
  category: TrendlineCategory;
  bias: TrendlineBias;
  status: TrendlineStatus;
  /** True for the dominant trendline (drawn with emphasis). */
  dominant: boolean;
  start: ChartTrendlinePoint;
  end: ChartTrendlinePoint;
}

/** A break / retest / reclaim / false-break point on the dominant line. */
export interface ChartTrendlineMarker {
  time: number;
  price: number;
  kind: TrendlineChangeKind;
  bias: TrendlineBias;
  label: string;
}

/**
 * Drawable, honesty-folded trendline overlay for the chart. The frontend draws
 * `lines` / `markers` ONLY when `visible` is true.
 */
export interface ChartTrendlineOverlay {
  /** True only when the geometry may be drawn (live-confirmed + has lines). */
  visible: boolean;
  /** The verdict's display fold fired (feed not live-confirmed / capped). */
  contextOnly: boolean;
  /** Window too short for ANY trendline (fail closed). */
  insufficient: boolean;
  status: TrendlineStatus;
  bias: TrendlineBias;
  lines: ChartTrendlineSegment[];
  markers: ChartTrendlineMarker[];
  note: string | null;
}

/** The chart's ALREADY-DECIDED honesty + structural facts (never recomputed here). */
export interface ChartTrendlineOverlayFacts {
  /** True only when the feed is genuinely live-confirmed (clean + fresh). */
  feedConfirmed: boolean;
  /** True when the feed is delayed/stale. */
  feedStale: boolean;
  /** True when sufficiency already allows showing a trade setup. */
  sufficiencyAllowsSetup: boolean;
  /** True when the chart-read structural confidence is LOW. */
  chartReadConfidenceLow: boolean;
}

const EMPTY_OVERLAY: ChartTrendlineOverlay = {
  visible: false,
  contextOnly: false,
  insufficient: true,
  status: "none",
  bias: "neutral",
  lines: [],
  markers: [],
  note: null,
};

// The detector emits these change kinds; only structural transitions are drawn
// as on-chart markers. Acceleration/flattening are slope-only (no point).
const MARKER_LABELS: Partial<Record<TrendlineChangeKind, string>> = {
  break: "Break",
  retest: "Retest",
  reclaim: "Reclaim",
  failure: "False break",
};

/**
 * Build the display-only trendline overlay from the SAME normalized candle window
 * the chart intelligence already holds. Returns an honest empty overlay on an
 * insufficient window, when no trendline is detected, or when the feed honesty
 * fold (contextOnly) says the geometry must not be drawn.
 */
export function buildChartTrendlineOverlay(
  candles: NormalizedChartCandle[],
  facts: ChartTrendlineOverlayFacts,
): ChartTrendlineOverlay {
  // Reconstruct the EXACT array the detector indexes against so a keyPoint index
  // maps to a real candle openTime. The engine drops a trailing forming bar.
  const closed = candles.filter((c) => c.isComplete && !c.isForming);

  const detection = detectTrendlines(candles);
  if (detection.insufficient) {
    return {
      ...EMPTY_OVERLAY,
      insufficient: true,
      note: "Insufficient closed candles for trendline geometry.",
    };
  }
  if (detection.trendlines.length === 0) {
    return {
      ...EMPTY_OVERLAY,
      insufficient: false,
      note: "No trendline detected on the current window.",
    };
  }

  const context: TrendlineContext = {
    // Conservative structural context: we do NOT claim trend/momentum alignment
    // here (those only colour the verdict's supportive nudge, never geometry or
    // visibility). Neutral defaults keep the overlay honest and decoupled.
    trend: "neutral",
    nearSupportResistance: false,
    distanceToSrAtr: null,
    momentumAligned: false,
    volatilityAtr: null,
  };
  const display: TrendlineDisplayContext = {
    feedConfirmed: facts.feedConfirmed,
    feedStale: facts.feedStale,
    sufficiencyAllowsSetup: facts.sufficiencyAllowsSetup,
    chartReadConfidenceLow: facts.chartReadConfidenceLow,
  };

  const verdict = resolveTrendlineTruth(
    detection.trendlines,
    context,
    display,
    detection.trendlineChange,
    detection.patternChange,
  );

  const lastIndex = closed.length - 1;
  // openTime is an ISO 8601 string (bar open); the chart's time scale wants Unix
  // seconds. Convert here so every emitted point is a real candle time in seconds.
  const timeAt = (index: number): number | null => {
    if (!Number.isInteger(index) || index < 0 || index > lastIndex) return null;
    const t = closed[index]?.openTime;
    if (typeof t !== "string") return null;
    const ms = new Date(t).getTime();
    return Number.isFinite(ms) ? Math.floor(ms / 1000) : null;
  };
  const finitePrice = (p: number | null | undefined): p is number =>
    typeof p === "number" && Number.isFinite(p);

  const dominant = verdict.dominantTrendline;
  const lines: ChartTrendlineSegment[] = [];

  for (const tl of verdict.activeTrendlines) {
    const isDominant = dominant != null && dominant.id === tl.id;
    const rail = buildPrimarySegment(tl, isDominant, lastIndex, timeAt, finitePrice);
    if (rail) lines.push(rail);
    if (tl.category === "channel") {
      const opp = buildChannelRailSegment(tl, isDominant, lastIndex, timeAt, finitePrice);
      if (opp) lines.push(opp);
    }
  }

  const markers = buildMarkers(verdict.trendlineChange, dominant, timeAt(lastIndex), finitePrice);

  const contextOnly = verdict.scannerTruthImpact.contextOnly;
  const visible = !contextOnly && verdict.status !== "none" && lines.length > 0;

  if (!visible) {
    // Fail closed: never hand the frontend geometry it must not draw.
    return {
      visible: false,
      contextOnly,
      insufficient: false,
      status: verdict.status,
      bias: verdict.bias,
      lines: [],
      markers: [],
      note: contextOnly
        ? "Trendlines hidden — feed is not live-confirmed (context only)."
        : "No drawable trendline geometry.",
    };
  }

  return {
    visible: true,
    contextOnly: false,
    insufficient: false,
    status: verdict.status,
    bias: verdict.bias,
    lines,
    markers,
    note: null,
  };
}

/**
 * Primary rail: a straight segment from the earliest rail keyPoint (anchor) to the
 * line's price at the latest closed bar (`currentLevel`). Both points lie on the
 * fitted line, so the segment is the real geometry — never an invented shape.
 */
function buildPrimarySegment(
  tl: ActiveTrendline,
  dominant: boolean,
  lastIndex: number,
  timeAt: (index: number) => number | null,
  finitePrice: (p: number | null | undefined) => p is number,
): ChartTrendlineSegment | null {
  const railPoints = tl.keyPoints.filter((k) => k.role !== "channel_rail");
  const anchor = railPoints[0];
  if (!anchor) return null;

  const startTime = timeAt(anchor.index);
  const endTime = timeAt(lastIndex);
  if (startTime == null || endTime == null || startTime === endTime) return null;
  if (!finitePrice(anchor.price)) return null;

  // Prefer the contract's currentLevel; fall back to extending the anchor along
  // the fitted slope (still real geometry, no fabrication).
  const endPrice = finitePrice(tl.currentLevel)
    ? tl.currentLevel
    : anchor.price + tl.slope * (lastIndex - anchor.index);
  if (!finitePrice(endPrice)) return null;

  return {
    id: tl.id,
    name: tl.name,
    category: tl.category,
    bias: tl.bias,
    status: tl.status,
    dominant,
    start: { time: startTime, price: round(anchor.price) },
    end: { time: endTime, price: round(endPrice) },
  };
}

/**
 * Opposite channel rail: a line PARALLEL to the primary rail (same slope) anchored
 * to the detector's single `channel_rail` keyPoint. The detector only stores one
 * opposite-rail point, so the rail is reconstructed from that real point + slope.
 */
function buildChannelRailSegment(
  tl: ActiveTrendline,
  dominant: boolean,
  lastIndex: number,
  timeAt: (index: number) => number | null,
  finitePrice: (p: number | null | undefined) => p is number,
): ChartTrendlineSegment | null {
  const rail = tl.keyPoints.find((k) => k.role === "channel_rail");
  if (!rail || !finitePrice(rail.price)) return null;

  const startTime = timeAt(rail.index);
  const endTime = timeAt(lastIndex);
  if (startTime == null || endTime == null || startTime === endTime) return null;

  const endPrice = rail.price + tl.slope * (lastIndex - rail.index);
  if (!finitePrice(endPrice)) return null;

  return {
    id: `${tl.id}:rail`,
    name: `${tl.name} (channel rail)`,
    category: tl.category,
    bias: tl.bias,
    status: tl.status,
    dominant,
    start: { time: startTime, price: round(rail.price) },
    end: { time: endTime, price: round(endPrice) },
  };
}

/**
 * Build the break/retest/reclaim/false-break markers from the dominant line's
 * change block. Anchored to the latest closed bar (where the change printed).
 */
function buildMarkers(
  change: { kind: TrendlineChangeKind; bias: TrendlineBias; confirmationLevel: number | null },
  dominant: ActiveTrendline | null,
  lastTime: number | null,
  finitePrice: (p: number | null | undefined) => p is number,
): ChartTrendlineMarker[] {
  const label = MARKER_LABELS[change.kind];
  if (!label || lastTime == null) return [];
  const price = finitePrice(change.confirmationLevel)
    ? change.confirmationLevel
    : dominant != null && finitePrice(dominant.currentLevel)
      ? dominant.currentLevel
      : null;
  if (!finitePrice(price)) return [];
  return [
    {
      time: lastTime,
      price: round(price),
      kind: change.kind,
      bias: change.bias,
      label,
    },
  ];
}

function round(n: number): number {
  return Math.round(n * 1e8) / 1e8;
}
