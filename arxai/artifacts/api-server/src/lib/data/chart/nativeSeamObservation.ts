// Native shift-1 / shift-0 observations are quality evidence only. They never
// enter candle storage, analytical arrays, indicators, or order execution.
import type { Candle } from "../types.js";
import type { ChartSeriesAttribution } from "./brokerQuoteBinding.js";
import type { TimeframeTruthResult } from "./candleTruthEngine.js";
import { advanceBarOpen, barCloseMs, barIntervalDistance, isChartTimeframe, type ChartTimeframe } from "./timeframes.js";

export const NATIVE_SEAM_TTL_MS = 180_000;
const FUTURE_MS = 5_000;
type NativeBar = { openTimeEpochMs: number; open: number; high: number; low: number; close: number };
export type NativeSeamObservation = {
  symbol: string; brokerSymbol: string; timeframe: ChartTimeframe;
  collectedAtEpochMs: number; brokerServerTimeEpochMs: number; brokerUtcOffsetMs: number;
  lastClosed: NativeBar; forming: NativeBar;
};
export type NativeSeamWriter = { bridgeConnectionId: number; userId: number };
type Entry = { observation: NativeSeamObservation; receivedAtEpochMs: number };
const observations = new Map<string, Entry>();
const key = (writer: NativeSeamWriter, symbol: string, timeframe: string) =>
  JSON.stringify([writer.userId, writer.bridgeConnectionId, symbol, timeframe]);
const integerTime = (v: unknown): v is number => typeof v === "number" && Number.isSafeInteger(v) && v > 0;
const identity = (v: unknown): v is string => typeof v === "string" && v.length > 0 && v.length <= 128 && v.trim() === v;
function validBar(v: unknown): v is NativeBar {
  if (!v || typeof v !== "object") return false;
  const b = v as NativeBar;
  return integerTime(b.openTimeEpochMs) && [b.open, b.high, b.low, b.close].every(x => Number.isFinite(x) && x > 0)
    && b.high >= Math.max(b.open, b.close, b.low) && b.low <= Math.min(b.open, b.close, b.high);
}
function observationProblem(o: NativeSeamObservation, now: number): string | null {
  if (now - o.collectedAtEpochMs > NATIVE_SEAM_TTL_MS) return "OBSERVATION_STALE";
  if (o.collectedAtEpochMs - now > FUTURE_MS) return "OBSERVATION_FUTURE";
  if (Math.abs(o.brokerServerTimeEpochMs - o.collectedAtEpochMs - o.brokerUtcOffsetMs) > FUTURE_MS) return "CLOCK_CONTRADICTION";
  const currentBrokerTime = now + o.brokerUtcOffsetMs;
  if (o.forming.openTimeEpochMs > o.brokerServerTimeEpochMs || o.forming.openTimeEpochMs > currentBrokerTime + FUTURE_MS
    || barCloseMs(o.forming.openTimeEpochMs, o.timeframe) <= Math.max(o.brokerServerTimeEpochMs, currentBrokerTime)) return "FORMING_BAR_NOT_CURRENT";
  return null;
}

/** Writer identity is passed ONLY by bridge auth, never read from the body. */
export function recordNativeSeamObservation(raw: unknown, writer: NativeSeamWriter, now = Date.now()): { accepted: boolean; reason: string } {
  if (!Number.isSafeInteger(writer.userId) || writer.userId <= 0 || !Number.isSafeInteger(writer.bridgeConnectionId) || writer.bridgeConnectionId <= 0)
    return { accepted: false, reason: "WRITER_UNATTRIBUTED" };
  if (!raw || typeof raw !== "object") return { accepted: false, reason: "OBSERVATION_INVALID" };
  const o = raw as NativeSeamObservation;
  if (!identity(o.symbol) || !identity(o.brokerSymbol) || !isChartTimeframe(o.timeframe)
    || !integerTime(o.collectedAtEpochMs) || !integerTime(o.brokerServerTimeEpochMs)
    || !Number.isSafeInteger(o.brokerUtcOffsetMs) || Math.abs(o.brokerUtcOffsetMs) > 14 * 3_600_000
    || !validBar(o.lastClosed) || !validBar(o.forming)
    || o.lastClosed.openTimeEpochMs >= o.forming.openTimeEpochMs)
    return { accepted: false, reason: "OBSERVATION_INVALID" };
  const problem = observationProblem(o, now);
  if (problem) return { accepted: false, reason: problem };
  const k = key(writer, o.symbol, o.timeframe), previous = observations.get(k);
  if (previous && o.collectedAtEpochMs <= previous.observation.collectedAtEpochMs)
    return { accepted: false, reason: "OBSERVATION_NOT_NEWER" };
  // Bound memory even if an authenticated producer sends arbitrary symbols.
  for (const [id, value] of observations) if (now - value.observation.collectedAtEpochMs > NATIVE_SEAM_TTL_MS) observations.delete(id);
  if (!observations.has(k) && observations.size >= 20_000) return { accepted: false, reason: "OBSERVATION_CAPACITY" };
  // Retain only the validated contract. Arbitrary producer metadata must not
  // turn the entry-count bound into unbounded retained bytes.
  const bar = (b: NativeBar): NativeBar => ({ openTimeEpochMs: b.openTimeEpochMs,
    open: b.open, high: b.high, low: b.low, close: b.close });
  observations.set(k, { observation: { symbol: o.symbol, brokerSymbol: o.brokerSymbol, timeframe: o.timeframe,
    collectedAtEpochMs: o.collectedAtEpochMs, brokerServerTimeEpochMs: o.brokerServerTimeEpochMs,
    brokerUtcOffsetMs: o.brokerUtcOffsetMs, lastClosed: bar(o.lastClosed), forming: bar(o.forming) }, receivedAtEpochMs: now });
  return { accepted: true, reason: "NATIVE_PAIR_OBSERVED" };
}

/** Exact native snapshot bound to this live history. Defensive copy: display
 * callers cannot mutate the evidence store. Never use it as an analytical bar. */
export function readNativeSeamForSeries(symbol: string, timeframe: ChartTimeframe, candles: readonly Candle[], series: ChartSeriesAttribution | null, now = Date.now()): Entry | null {
  if (series?.providerId !== "mt5_broker" || series.subProviderId != null || series.bridgeConnectionId == null || series.userId == null || !series.brokerSymbol) return null;
  const entry = observations.get(key({ bridgeConnectionId: series.bridgeConnectionId, userId: series.userId }, symbol, timeframe));
  if (!entry || observationProblem(entry.observation, now)) return null;
  const o = entry.observation, closed = candles.at(-1);
  if (!closed || o.brokerSymbol !== series.brokerSymbol || closed.brokerSymbol !== o.brokerSymbol
    || Date.parse(closed.time) !== o.lastClosed.openTimeEpochMs
    || !(["open", "high", "low", "close"] as const).every(k => closed[k] === o.lastClosed[k])) return null;
  return structuredClone(entry);
}

/** Attach only seam metadata after exact identity + closed-bar reconciliation.
 * The native forming OHLC stays out of every returned analytical candle. */
export function withNativeSeamEvidence(truth: TimeframeTruthResult, candles: readonly Candle[], series: ChartSeriesAttribution | null, now = Date.now()): TimeframeTruthResult {
  const entry = readNativeSeamForSeries(truth.symbol, truth.timeframe, candles, series, now);
  if (!entry) return truth;
  const o = entry.observation;
  const expectedOpen = barCloseMs(o.lastClosed.openTimeEpochMs, o.timeframe);
  const distance = barIntervalDistance(expectedOpen, o.forming.openTimeEpochMs, o.timeframe);
  // Non-integral native boundaries cannot be silently rounded to a clean seam.
  if (!Number.isSafeInteger(distance) || advanceBarOpen(expectedOpen, o.timeframe, distance) !== o.forming.openTimeEpochMs) return truth;
  return { ...truth, mergeSeam: {
    formingBarDetected: true, formingBarCount: 1,
    gapAtSeam: distance > 0, overlapAtSeam: distance < 0, seamGapIntervals: Math.max(0, distance),
    nativeObservation: { kind: "mt5_shift1_shift0", collectedAtEpochMs: o.collectedAtEpochMs,
      receivedAtEpochMs: entry.receivedAtEpochMs, lastClosedOpenEpochMs: o.lastClosed.openTimeEpochMs,
      formingOpenEpochMs: o.forming.openTimeEpochMs, brokerSymbol: o.brokerSymbol },
  } };
}

export function __resetNativeSeamObservations(): void { observations.clear(); }
