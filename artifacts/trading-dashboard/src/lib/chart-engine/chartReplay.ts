import type { ChartCandlesResponse } from "@workspace/api-client-react";
import { validatePreferences, type ChartPreferences } from "./chartWorkspace";
import type { ChartEngineCandle } from "./types";
import { chartIntervalSeconds, chartIntervalLimitation } from "./chartIntervals";

export const MAX_REPLAY_BARS = 5_000;
export const REPLAY_SPEEDS = [0.5, 1, 2, 4, 8] as const;
export interface ReplayBar extends ChartEngineCandle { closeTime: number }
export interface ChartReplaySnapshot {
  readonly id: string;
  readonly ownerId: number;
  readonly symbol: string;
  readonly timeframe: string;
  readonly source: string;
  readonly sourceIdentity: string;
  readonly capturedAt: number;
  readonly lastClosedAt: number;
  readonly gaps: number;
  readonly bars: readonly ReplayBar[];
  readonly preferences: ChartPreferences;
}
export type ReplayCapture = { snapshot: ChartReplaySnapshot; error?: never } | { snapshot?: never; error: string };

/** Freeze observed closed bars only. This is a diagnostic read: the opaque
 * source identity binds the response, but does not invent broker account-era
 * history, trading costs, fills, or missing session bars. No live overlays enter. */
export function captureChartReplay(data: ChartCandlesResponse | undefined, ownerId: number,
  preferences: ChartPreferences, now = Date.now(), expected?: {symbol:string;timeframe:string}): ReplayCapture {
  const unavailable = (error: string): ReplayCapture => ({ error });
  if (!Number.isSafeInteger(ownerId) || ownerId <= 0) return unavailable("Sign in to open a private replay.");
  const evidence = data?.marketEvidence;
  const intervalLimitation = chartIntervalLimitation(data?.timeframe);
  if (intervalLimitation) return unavailable(intervalLimitation);
  const seconds = chartIntervalSeconds(data?.timeframe);
  if (!data || !evidence || !seconds || !Number.isFinite(now)
    || (expected && (expected.symbol !== data.symbol || expected.timeframe !== data.timeframe))
    || evidence.symbol !== data.symbol || evidence.timeframe !== data.timeframe
    || evidence.source !== data.feedStatus?.source || !evidence.source
    || !/^[a-f0-9]{64}$/i.test(evidence.sourceIdentity)
    || ("userId" in evidence && evidence.userId != null && evidence.userId !== ownerId)) {
    return unavailable("Replay needs a source-identified candle window. Refresh the chart and try again.");
  }
  if (!Array.isArray(data.candles) || data.candles.length > MAX_REPLAY_BARS + 1) {
    return unavailable(`Replay accepts at most ${MAX_REPLAY_BARS.toLocaleString()} loaded closed candles.`);
  }
  const bars: ReplayBar[] = [];
  let gaps = 0;
  for (const [index, candle] of data.candles.entries()) {
    if (!candle || candle.symbol !== data.symbol || candle.timeframe !== data.timeframe || candle.source !== evidence.source) {
      return unavailable("The candle window contains a different market, timeframe or source.");
    }
    // A forming tick is never turned into historical OHLC just because the
    // wall clock advances after capture. Require the original closed verdict.
    if (candle.isComplete !== true || candle.isFinal !== true || candle.isForming !== false) {
      // Only the explicitly forming tip may be omitted. Contradictory flags or
      // a hole inside closed history cannot silently become an ordinary gap.
      if (index === data.candles.length - 1 && candle.isComplete === false && candle.isFinal === false && candle.isForming === true) continue;
      return unavailable("Replay needs unambiguous closed candles and at most one forming tip.");
    }
    const time = Date.parse(candle.openTime) / 1000;
    const closeTime = Date.parse(candle.closeTime) / 1000;
    const prices = [candle.open, candle.high, candle.low, candle.close];
    if (!Number.isFinite(time) || time <= 0 || !Number.isFinite(closeTime) || closeTime - time !== seconds
      || closeTime * 1000 > now || prices.some(value => !Number.isFinite(value) || value <= 0)
      || candle.high < Math.max(candle.open,candle.close,candle.low) || candle.low > Math.min(candle.open,candle.close)
      || !["live","demo"].includes(candle.sourceMode)
      || candle.qualityFlags?.some(flag => ["OHLC_INVALID","TIMESTAMP_INVALID","MOCK_DATA","ZERO_VOLUME_GHOST"].includes(flag))) {
      return unavailable("Replay cannot use invalid or incomplete historical candles.");
    }
    const previous = bars.at(-1);
    if (previous && (time <= previous.time || time < previous.closeTime)) return unavailable("Replay needs unique candles in chronological order.");
    if (previous && time > previous.closeTime) gaps++;
    bars.push(Object.freeze({ time, closeTime, open:candle.open, high:candle.high, low:candle.low, close:candle.close }));
  }
  const last = bars.at(-1);
  if (!last || bars.length > MAX_REPLAY_BARS || Date.parse(evidence.lastClosedCandleAt) !== last.closeTime * 1000) {
    return unavailable("Replay needs a complete closed window matching its source evidence.");
  }
  const clonedPreferences = validatePreferences(preferences);
  clonedPreferences.studies.forEach(Object.freeze);
  Object.freeze(clonedPreferences.studies); Object.freeze(clonedPreferences);
  return { snapshot: Object.freeze({ id:crypto.randomUUID(),ownerId,symbol:data.symbol,timeframe:data.timeframe,
    source:evidence.source,sourceIdentity:evidence.sourceIdentity,capturedAt:now,lastClosedAt:last.closeTime,
    gaps,bars:Object.freeze(bars),preferences:clonedPreferences }) };
}

export function replayCount(value: number, total: number): number {
  return Math.max(1,Math.min(total,Number.isFinite(value) ? Math.floor(value) : 1));
}
/** Only the prefix is handed to the renderer/calculators. No future indicator
 * values are precomputed and then cosmetically hidden. */
export function replayPrefix(snapshot: ChartReplaySnapshot, count: number): ReplayBar[] {
  return snapshot.bars.slice(0,replayCount(count,snapshot.bars.length));
}
export function replayCountAtClose(snapshot: ChartReplaySnapshot, closeTime: number): number | null {
  if (!Number.isFinite(closeTime) || closeTime < snapshot.bars[0]!.closeTime || closeTime > snapshot.lastClosedAt) return null;
  let lo=0,hi=snapshot.bars.length;
  while(lo<hi){const mid=(lo+hi)>>>1;if(snapshot.bars[mid]!.closeTime<=closeTime)lo=mid+1;else hi=mid;}
  return lo || null;
}
export function replayDrawingKey(snapshot: ChartReplaySnapshot): string { return `arx.chart.replay.drawings:${snapshot.ownerId}:${snapshot.id}`; }

/** Browser Back can contain URL syntax as well as a route. Parse before using
 * it for a hard reload; slash/backslash and encoded origin escapes fall back. */
export function replayExitUrl(path: string, base: string, origin: string): string {
  const fallback = new URL(`${base}/live-chart`, origin);
  if (!path.startsWith("/")) return fallback.href;
  try {
    const target = new URL(`${base}${path}`, origin);
    return target.origin === fallback.origin ? target.href : fallback.href;
  } catch { return fallback.href; }
}
