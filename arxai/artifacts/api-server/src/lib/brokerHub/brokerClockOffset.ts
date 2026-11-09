// ── Broker clock offset (per bridge) ─────────────────────────────────────────
//
// An MT5 terminal stamps ticks (MqlTick.time_msc) and bars (MqlRates.time) in
// the BROKER SERVER's clock, which is almost never UTC (most brokers run EET,
// UTC+2 / UTC+3). Until 2026-11-04 the server stored those stamps as UTC
// instants, so on a non-UTC broker every tick read QUOTE_TIME_FUTURE or
// QUOTE_STALE, every bar "opened in the future" and the Truth system could
// never say verified or BOUND (Truth audit T1).
//
// The EA already tells us the offset: the candle-history push carries
// `brokerServerTime` (TimeCurrent) beside `sentAt` (TimeGMT), the heartbeat
// carries `brokerTime` beside `eaTimeGmt`, and every v2 TICK carries the tick's
// broker time beside the envelope's `eaCreatedAtEpochMs` (GMT). This module
// turns those pairs into ONE measured offset per bridge and lets the ingest
// paths convert broker stamps to UTC AT INGEST, recording the measurement that
// was used. No stored history is rewritten later, and nothing here is a gate.
//
// Measurement rules (fail closed):
//   - Real broker offsets are whole multiples of 30 minutes. A sample is
//     rounded to the nearest 30 min and ACCEPTED only when it lies within
//     SAMPLE_TOLERANCE_MS of that multiple. TimeCurrent() is the time of the
//     last tick on any symbol, so on a quiet market a heartbeat sample can lag
//     by minutes or hours; the tolerance rejects most of those, and the mode of
//     the recent accepted samples rejects the rest.
//   - The offset in force is the MODE of the last SAMPLE_WINDOW accepted
//     samples, so one odd sample never moves it.
//   - An offset older than OFFSET_TTL_MS (no sample since) is unknown again.
//   - Unknown stays unknown: a consumer without an offset keeps today's
//     behaviour (no conversion, fail closed on freshness).

export type BrokerClockSampleBasis = "candle_push" | "heartbeat" | "v2_tick";

export interface BrokerClockOffset {
  /** broker clock − UTC, in ms (positive = broker ahead of UTC). */
  offsetMs: number;
  /** When the newest contributing sample was taken (ms, server clock). */
  measuredAtMs: number;
  /** Accepted samples in the window that agree with offsetMs. */
  agreeingSamples: number;
  /** Accepted samples in the window. */
  windowSamples: number;
  basis: BrokerClockSampleBasis;
}

export const BROKER_CLOCK_STEP_MS = 30 * 60_000;
/** A sample must sit within this of a 30-minute multiple to count. */
export const BROKER_CLOCK_SAMPLE_TOLERANCE_MS = 90_000;
export const BROKER_CLOCK_SAMPLE_WINDOW = 24;
/** No sample for this long → the offset is unknown again. */
export const BROKER_CLOCK_OFFSET_TTL_MS = 24 * 60 * 60_000;
/** Provenance note on a series or quote whose stamps were converted to UTC. */
export const BROKER_CLOCK_UTC_CONVERTED_NOTE = "BROKER_CLOCK_UTC_CONVERTED";

export const UNATTRIBUTED_BROKER_CLOCK_KEY = "unattributed";

interface Sample { offsetMs: number; atMs: number; basis: BrokerClockSampleBasis }

const samplesByBridge = new Map<string, Sample[]>();

export function brokerClockKey(bridgeConnectionId: number | null | undefined): string {
  return bridgeConnectionId != null ? String(bridgeConnectionId) : UNATTRIBUTED_BROKER_CLOCK_KEY;
}

/** Round a raw broker−GMT difference to the broker-offset grid, or null when it
 *  is not near a 30-minute multiple (a stale TimeCurrent, a bad clock). */
export function quantizeBrokerClockOffset(rawMs: number): number | null {
  if (!Number.isFinite(rawMs)) return null;
  const q = Math.round(rawMs / BROKER_CLOCK_STEP_MS) * BROKER_CLOCK_STEP_MS;
  if (Math.abs(rawMs - q) > BROKER_CLOCK_SAMPLE_TOLERANCE_MS) return null;
  // Broker clocks live within ±14 h of UTC.
  if (Math.abs(q) > 14 * 60 * 60_000) return null;
  return q;
}

/**
 * Record one (broker clock, GMT clock) pair observed at the same instant by
 * the EA. Returns the quantized sample when accepted, null when rejected.
 */
export function recordBrokerClockSample(input: {
  bridgeConnectionId: number | null | undefined;
  brokerMs: number | null | undefined;
  gmtMs: number | null | undefined;
  basis: BrokerClockSampleBasis;
  nowMs?: number;
}): number | null {
  const { brokerMs, gmtMs } = input;
  if (brokerMs == null || gmtMs == null || !Number.isFinite(brokerMs) || !Number.isFinite(gmtMs)) return null;
  if (brokerMs <= 0 || gmtMs <= 0) return null;
  const q = quantizeBrokerClockOffset(brokerMs - gmtMs);
  if (q == null) return null;
  const key = brokerClockKey(input.bridgeConnectionId);
  const list = samplesByBridge.get(key) ?? [];
  list.push({ offsetMs: q, atMs: input.nowMs ?? Date.now(), basis: input.basis });
  while (list.length > BROKER_CLOCK_SAMPLE_WINDOW) list.shift();
  samplesByBridge.set(key, list);
  return q;
}

/** The offset in force for a bridge, or null when unknown / expired. */
export function getBrokerClockOffset(
  bridgeConnectionId: number | null | undefined,
  nowMs: number = Date.now(),
): BrokerClockOffset | null {
  const list = samplesByBridge.get(brokerClockKey(bridgeConnectionId));
  if (!list || list.length === 0) return null;
  const counts = new Map<number, number>();
  for (const s of list) counts.set(s.offsetMs, (counts.get(s.offsetMs) ?? 0) + 1);
  let mode = list[list.length - 1]!.offsetMs;
  let best = -1;
  for (const [offset, n] of counts) {
    if (n > best || (n === best && offset === list[list.length - 1]!.offsetMs)) { best = n; mode = offset; }
  }
  const agreeing = list.filter((s) => s.offsetMs === mode);
  const newest = agreeing[agreeing.length - 1]!;
  if (nowMs - newest.atMs > BROKER_CLOCK_OFFSET_TTL_MS) return null;
  return {
    offsetMs: mode,
    measuredAtMs: newest.atMs,
    agreeingSamples: agreeing.length,
    windowSamples: list.length,
    basis: newest.basis,
  };
}

/**
 * Convert a broker-clock stamp to UTC with the bridge's measured offset.
 * null when no offset is known (the caller keeps the raw stamp and fails closed).
 */
export function brokerStampToUtcMs(
  bridgeConnectionId: number | null | undefined,
  brokerMs: number,
  nowMs: number = Date.now(),
): { utcMs: number; offset: BrokerClockOffset } | null {
  if (!Number.isFinite(brokerMs)) return null;
  const offset = getBrokerClockOffset(bridgeConnectionId, nowMs);
  if (!offset) return null;
  return { utcMs: brokerMs - offset.offsetMs, offset };
}

/** Parse an EA display stamp as a clock reading in ms: the MQL TimeToString
 *  spelling ("2026.11.04 05:07:07", v154/v15x) or the zone-less ISO spelling
 *  ("2026-11-04T05:07:07", v131 IsoFromTime). The reading is in whatever clock
 *  produced it. A stamp carrying a zone ("Z", "+02:00") is an instant, not a
 *  clock reading, and is rejected (ISO instants have their own parsers). */
export function parseMqlTimeString(value: unknown): number | null {
  if (typeof value !== "string") return null;
  const v = value.trim();
  const m = /^(\d{4})\.(\d{2})\.(\d{2})(?:[ T](\d{2}):(\d{2})(?::(\d{2}))?)?$/.exec(v)
    ?? /^(\d{4})-(\d{2})-(\d{2})(?:[ T](\d{2}):(\d{2})(?::(\d{2}))?)?$/.exec(v);
  if (!m) return null;
  const ms = Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3]), Number(m[4] ?? 0), Number(m[5] ?? 0), Number(m[6] ?? 0));
  return Number.isFinite(ms) ? ms : null;
}

/** Test helper. */
export function __resetBrokerClockOffsets(): void {
  samplesByBridge.clear();
}
