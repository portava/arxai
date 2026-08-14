// Historical Comparison Engine — pure domain (no DB, no HTTP, no broker).
//
// Given a current timestamp and an array of historical OHLC candles, this
// engine answers: "what did this same market do at this same time
// yesterday, last week, last month, last year, and five years ago?"
//
// It returns a directional bias only when the sample size is large enough to
// be honest. If candles don't span back to a target window, that window is
// marked unavailable — never faked.
//
// Safety: this module never claims certainty. The bias is a "historical
// preference", not a buy/sell signal. The trade ticket UI surfaces this as
// decision-support, not as a recommendation.

export type WindowLabel =
  | "yesterday"
  | "lastWeek"
  | "lastMonth"
  | "lastYear"
  | "fiveYearsAgo";

export type BiasLabel = "BULLISH" | "BEARISH" | "MIXED" | "INSUFFICIENT_DATA";
export type Confidence = "LOW" | "MEDIUM" | "HIGH";

export interface HistoricalCandle {
  timestamp: number;
  open: number;
  high: number;
  low: number;
  close: number;
}

export interface SameTimeWindow {
  label: WindowLabel;
  targetTime: number;
  candle: HistoricalCandle | null;
  nextCandle: HistoricalCandle | null;
  direction: "UP" | "DOWN" | "FLAT" | null;
  changePct: number | null;
  available: boolean;
  unavailableReason?: string;
}

export interface SetupSummary {
  sampleSize: number;
  winRate: number | null;
  avgMovePct: number | null;
  worstDrawdownPct: number | null;
  bestMovePct: number | null;
  avgTimeToNextCandleMs: number | null;
  confidence: Confidence;
  explanation: string;
}

export interface HistoricalComparisonResult {
  symbol: string;
  timeframe: string;
  generatedAt: number;
  windows: SameTimeWindow[];
  bias: {
    label: BiasLabel;
    bullishCount: number;
    bearishCount: number;
    flatCount: number;
    sampleSize: number;
    confidence: Confidence;
    explanation: string;
  };
  setupSummary: SetupSummary;
  dataQuality: {
    candlesProvided: number;
    oldestCandle: number | null;
    newestCandle: number | null;
    coverageWarnings: string[];
  };
}

const DAY_MS = 24 * 60 * 60 * 1000;

export function buildSameTimeTargets(
  now: number,
): Array<{ label: WindowLabel; targetTime: number }> {
  return [
    { label: "yesterday", targetTime: now - DAY_MS },
    { label: "lastWeek", targetTime: now - 7 * DAY_MS },
    { label: "lastMonth", targetTime: now - 30 * DAY_MS },
    { label: "lastYear", targetTime: now - 365 * DAY_MS },
    { label: "fiveYearsAgo", targetTime: now - 5 * 365 * DAY_MS },
  ];
}

function findCandleAtOrBefore(
  candles: HistoricalCandle[],
  targetTime: number,
): { idx: number; candle: HistoricalCandle } | null {
  if (candles.length === 0) return null;
  if (candles[0]!.timestamp > targetTime) return null;
  let lo = 0;
  let hi = candles.length - 1;
  let best = -1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (candles[mid]!.timestamp <= targetTime) {
      best = mid;
      lo = mid + 1;
    } else {
      hi = mid - 1;
    }
  }
  if (best < 0) return null;
  return { idx: best, candle: candles[best]! };
}

function classifyDirection(a: HistoricalCandle, b: HistoricalCandle):
  { direction: "UP" | "DOWN" | "FLAT"; changePct: number } {
  if (a.close <= 0) return { direction: "FLAT", changePct: 0 };
  const changePct = ((b.close - a.close) / a.close) * 100;
  if (Math.abs(changePct) < 0.01) return { direction: "FLAT", changePct };
  return { direction: changePct > 0 ? "UP" : "DOWN", changePct };
}

export function analyzeHistoricalComparison(args: {
  symbol: string;
  timeframe: string;
  candles: HistoricalCandle[];
  now: number;
}): HistoricalComparisonResult {
  const sorted = [...args.candles].sort((a, b) => a.timestamp - b.timestamp);
  const targets = buildSameTimeTargets(args.now);

  const windows: SameTimeWindow[] = targets.map((t) => {
    const hit = findCandleAtOrBefore(sorted, t.targetTime);
    if (!hit) {
      return {
        label: t.label,
        targetTime: t.targetTime,
        candle: null,
        nextCandle: null,
        direction: null,
        changePct: null,
        available: false,
        unavailableReason: "History does not span back this far",
      };
    }
    const next = sorted[hit.idx + 1] ?? null;
    if (!next) {
      return {
        label: t.label,
        targetTime: t.targetTime,
        candle: hit.candle,
        nextCandle: null,
        direction: null,
        changePct: null,
        available: false,
        unavailableReason: "No following candle to measure direction",
      };
    }
    const { direction, changePct } = classifyDirection(hit.candle, next);
    return {
      label: t.label,
      targetTime: t.targetTime,
      candle: hit.candle,
      nextCandle: next,
      direction,
      changePct,
      available: true,
    };
  });

  const bullishCount = windows.filter((w) => w.direction === "UP").length;
  const bearishCount = windows.filter((w) => w.direction === "DOWN").length;
  const flatCount = windows.filter((w) => w.direction === "FLAT").length;
  const sampleSize = bullishCount + bearishCount + flatCount;

  let label: BiasLabel;
  let explanation: string;
  if (sampleSize === 0) {
    label = "INSUFFICIENT_DATA";
    explanation = "Not enough historical data to form a same-time read.";
  } else if (bullishCount > bearishCount) {
    label = "BULLISH";
    explanation = `${bullishCount} of ${sampleSize} same-time windows moved up.`;
  } else if (bearishCount > bullishCount) {
    label = "BEARISH";
    explanation = `${bearishCount} of ${sampleSize} same-time windows moved down.`;
  } else {
    label = "MIXED";
    explanation = "Same-time history is split — no clear directional preference.";
  }

  let confidence: Confidence;
  if (sampleSize >= 4) confidence = "HIGH";
  else if (sampleSize >= 2) confidence = "MEDIUM";
  else confidence = "LOW";

  const availableWindows = windows.filter(
    (w) => w.available && w.changePct != null && w.candle && w.nextCandle,
  );
  const majorityDirection: "UP" | "DOWN" | null =
    bullishCount > bearishCount ? "UP" : bearishCount > bullishCount ? "DOWN" : null;
  const movesPct = availableWindows.map((w) => w.changePct as number);
  const winRate =
    majorityDirection && availableWindows.length > 0
      ? (availableWindows.filter((w) => w.direction === majorityDirection).length /
          availableWindows.length) *
        100
      : null;
  const avgMovePct =
    movesPct.length > 0
      ? movesPct.reduce((a, b) => a + Math.abs(b), 0) / movesPct.length
      : null;
  const worstDrawdownPct = movesPct.length > 0 ? Math.min(...movesPct) : null;
  const bestMovePct = movesPct.length > 0 ? Math.max(...movesPct) : null;
  const timeDeltas = availableWindows
    .map((w) => (w.nextCandle && w.candle ? w.nextCandle.timestamp - w.candle.timestamp : null))
    .filter((d): d is number => d != null && d > 0);
  const avgTimeToNextCandleMs =
    timeDeltas.length > 0
      ? Math.round(timeDeltas.reduce((a, b) => a + b, 0) / timeDeltas.length)
      : null;

  const setupExplanation =
    availableWindows.length === 0
      ? "No same-time setups available — cannot estimate win rate."
      : `${availableWindows.length} comparable same-time setup(s). ` +
        (winRate != null
          ? `When history matched, the same-time bar moved ${majorityDirection === "UP" ? "up" : "down"} ${winRate.toFixed(0)}% of the time. `
          : "No directional majority. ") +
        (avgMovePct != null ? `Average move ${avgMovePct.toFixed(2)}%.` : "");

  const setupSummary: SetupSummary = {
    sampleSize: availableWindows.length,
    winRate,
    avgMovePct,
    worstDrawdownPct,
    bestMovePct,
    avgTimeToNextCandleMs,
    confidence,
    explanation: setupExplanation,
  };

  const coverageWarnings: string[] = [];
  for (const w of windows) {
    if (!w.available && w.unavailableReason) {
      coverageWarnings.push(`${w.label}: ${w.unavailableReason}`);
    }
  }

  return {
    symbol: args.symbol,
    timeframe: args.timeframe,
    generatedAt: args.now,
    windows,
    bias: {
      label,
      bullishCount,
      bearishCount,
      flatCount,
      sampleSize,
      confidence,
      explanation,
    },
    setupSummary,
    dataQuality: {
      candlesProvided: sorted.length,
      oldestCandle: sorted[0]?.timestamp ?? null,
      newestCandle: sorted[sorted.length - 1]?.timestamp ?? null,
      coverageWarnings,
    },
  };
}
