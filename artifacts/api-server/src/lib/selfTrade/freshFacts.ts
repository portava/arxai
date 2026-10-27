// Fresh facts immediately before an autonomous self-trade command is committed.
//
// Admission, draft and the final claim already re-check agent authority, funding,
// settings and setup expiry (entryAuthority.ts). Those are database facts. This
// module covers the facts that live OUTSIDE the database row and move on their
// own: the executable quote, the spread, where price is relative to the
// decision's entry zone and stop, and how old the broker position observation is.
//
// Rules (all pure; callers gather inputs and decide where to refuse):
// - Only refuses. A pass never relaxes the Risk Governor, the Phase B gates, the
//   EA pre-trade guard or any other check.
// - Fail closed with a structured reason on missing, malformed, non-finite,
//   future-dated or stale inputs. A missing timestamp is never replaced by "now".
// - Thresholds are existing contracts, not new tuning (see the constants below).
//
// No I/O here. `observeAgentEntryMarket` in liveCommandPipeline gathers the
// quote/spec outside any lock; the claim evaluates the result after acquiring its
// authority locks so time spent waiting counts against freshness.

import { CLOCK_DRIFT_WARN_SECONDS } from "@workspace/domain/safety-contracts/clockDrift";
import { DEFAULT_PRE_TRADE_GUARD_LIMITS } from "@workspace/domain/safety-contracts/preTradeBrokerGuard";
import type { EaQuoteSupply } from "./eaQuoteSupply.js";

/** The EA pre-trade guard's own quote-age bound (preTradeBrokerGuard.ts). */
export const ENTRY_QUOTE_MAX_AGE_MS = DEFAULT_PRE_TRADE_GUARD_LIMITS.maxQuoteAgeMs;
/** The EA pre-trade guard's spread bound in broker points. */
export const ENTRY_MAX_SPREAD_POINTS = DEFAULT_PRE_TRADE_GUARD_LIMITS.maxSpreadPoints;
/** The EA pre-trade guard's deviation bound, applied outside the entry zone. */
export const ENTRY_MAX_ZONE_DEVIATION_POINTS =
  DEFAULT_PRE_TRADE_GUARD_LIMITS.maxDeviationPoints;
/**
 * Position rows refreshed within this window are broker-confirmed (positionTruthAdapter
 * STALE_MS, also used by tradeHealthService, scalpManageService and mePositionsUnified).
 */
export const POSITION_OBSERVATION_MAX_AGE_MS = 90_000;

/**
 * A timestamp ahead of the server clock cannot prove freshness. Tolerance is the
 * smaller of the freshness window itself and the clock-drift WARN contract (30s):
 * an offset larger than the window would make the age unknowable.
 */
export function futureToleranceMs(maxAgeMs: number): number {
  return Math.min(maxAgeMs, CLOCK_DRIFT_WARN_SECONDS * 1000);
}

export type TimestampVerdict =
  | { ok: true; ageMs: number; atMs: number }
  | { ok: false; kind: "INVALID" | "FUTURE" | "STALE"; detail: string };

/** Strictly parse an observation time: a finite, positive Date/ISO string/epoch ms. */
export function parseObservationTime(value: unknown): number | null {
  let ms: number;
  if (value instanceof Date) ms = value.getTime();
  else if (typeof value === "number") ms = value;
  else if (typeof value === "string" && value.trim() !== "") {
    // Only date strings; a bare numeric string is ambiguous (seconds vs ms).
    if (/^\s*-?\d+(\.\d+)?\s*$/.test(value)) return null;
    ms = Date.parse(value);
  } else return null;
  return Number.isFinite(ms) && ms > 0 ? ms : null;
}

export function classifyObservationAge(
  value: unknown,
  nowMs: number,
  maxAgeMs: number,
): TimestampVerdict {
  if (!Number.isFinite(nowMs) || nowMs <= 0)
    return { ok: false, kind: "INVALID", detail: "server clock invalid" };
  if (!Number.isFinite(maxAgeMs) || maxAgeMs < 0)
    return { ok: false, kind: "INVALID", detail: "freshness bound invalid" };
  const atMs = parseObservationTime(value);
  if (atMs == null)
    return { ok: false, kind: "INVALID", detail: `timestamp=${describe(value)}` };
  const ageMs = nowMs - atMs;
  if (ageMs < -futureToleranceMs(maxAgeMs))
    return { ok: false, kind: "FUTURE", detail: `timestamp ${-ageMs}ms ahead of server` };
  if (ageMs > maxAgeMs)
    return { ok: false, kind: "STALE", detail: `age ${ageMs}ms > max ${maxAgeMs}ms` };
  return { ok: true, ageMs: Math.max(0, ageMs), atMs };
}

/** An ISO time verbatim; anything else through `describe`. */
function showTime(value: unknown): string {
  return typeof value === "string" ? value : describe(value);
}

function describe(value: unknown): string {
  if (value === undefined) return "undefined";
  if (typeof value === "number" || typeof value === "boolean" || value === null)
    return String(value);
  if (value instanceof Date) return "InvalidDate";
  if (typeof value === "string") return JSON.stringify(value.slice(0, 40));
  return typeof value;
}

const positive = (v: unknown): v is number =>
  typeof v === "number" && Number.isFinite(v) && v > 0;

// ── Entry: quote, spread and price at the final dispatch claim ──────────────

/** Raw, unvalidated observation gathered just before the claim transaction. */
export interface EntryMarketObservation {
  bid: unknown;
  ask: unknown;
  /** EA observation time of the quote (UTC), never fetch or receive time. */
  observedAt: unknown;
  source: string | null;
  /** Broker SYMBOL_POINT for converting distances to points; null when unknown. */
  point: unknown;
  /**
   * Diagnostic: the broker trade server's clock minus the EA's UTC clock at the
   * tick (e.g. +10_800_000 on a GMT+3 server). Recorded, never evaluated.
   */
  brokerClockOffsetMs?: number | null;
  /** The command row's ARX-internal symbol the observation was requested for. */
  requestedSymbol?: string;
  /** The broker-native name the quote and spec were read under; null if unresolved. */
  brokerSymbol?: string | null;
  /** The bridge connection whose quote partition was read; null when unknown. */
  bridgeConnectionId?: number | null;
  /** The dispatch bridge's heartbeat-reported EA version; null when unknown. */
  eaVersion?: string | null;
  /**
   * Set on a missing-quote observation: whether that EA build streams broker
   * quotes at all (pure lookup, eaQuoteSupply.ts). Explains the refusal; never
   * changes it.
   */
  eaQuoteSupply?: EaQuoteSupply | null;
  /**
   * How the bridge's partition came to hold this tick (mt5Provider
   * `recordMt5Tick`): first sight, latest re-post, re-post count and the
   * feed's previous post. null when the quote was written without it, which
   * the claim refuses: such a timestamp is not a tick observation time.
   */
  tickProvenance?: EntryTickProvenance | null;
  /** Present when the quote or spec could not be read. */
  error?: string | null;
}

/** Raw (unvalidated) tick provenance as the observer copies it from the store. */
export interface EntryTickProvenance {
  /** EA UTC time at which this exact tick was first seen in the bridge's partition. */
  firstSeenAt: unknown;
  /** EA UTC time of its most recent (re-)post. */
  lastPostedAt: unknown;
  /** Identical re-posts since first sight. */
  reposts: unknown;
  /** EA UTC time of the partition's last post before this tick appeared; null if none. */
  priorPostAt: unknown;
}

/**
 * The longest silence of the bridge's feed before a tick's first sight that
 * still bounds when the tick occurred. The EA sweeps every 2 s; a tick first
 * seen within this much of the feed's previous post occurred inside that gap,
 * so `now - firstSeenAt` under-states its true age by at most the gap. A tick
 * that follows a longer silence (feed restart, terminal down over a weekend)
 * can have occurred at any point in it and is refused. Same bound as the age
 * window, so the true age of an accepted tick is at most twice the window.
 */
export const ENTRY_QUOTE_MAX_FEED_GAP_MS = ENTRY_QUOTE_MAX_AGE_MS;

/** Operator-facing detail for ENTRY_FRESH_QUOTE_UNAVAILABLE: what was read where, and why the EA may have nothing. */
export function describeQuoteUnavailable(obs: EntryMarketObservation | null | undefined): string {
  if (obs == null) return "no quote observation";
  const parts = [obs.error ?? "no quote observation"];
  if (obs.brokerSymbol != null || obs.requestedSymbol != null) {
    const broker = obs.brokerSymbol ?? "unresolved";
    parts.push(
      obs.requestedSymbol != null && obs.requestedSymbol !== obs.brokerSymbol
        ? `symbol ${broker} (requested ${obs.requestedSymbol})`
        : `symbol ${broker}`,
    );
  }
  parts.push(obs.bridgeConnectionId != null ? `bridge ${obs.bridgeConnectionId}` : "bridge unknown");
  if (obs.eaQuoteSupply?.note) parts.push(obs.eaQuoteSupply.note);
  return parts.join("; ");
}

export type EntryFreshReason =
  | "ENTRY_FRESH_QUOTE_UNAVAILABLE"
  | "ENTRY_FRESH_QUOTE_TIMESTAMP_INVALID"
  | "ENTRY_FRESH_QUOTE_FUTURE_DATED"
  | "ENTRY_FRESH_QUOTE_STALE"
  | "ENTRY_FRESH_QUOTE_PRICES_INVALID"
  | "ENTRY_FRESH_SPREAD_UNMEASURABLE"
  | "ENTRY_FRESH_SPREAD_TOO_WIDE"
  | "ENTRY_FRESH_DECISION_PRICE_MISSING"
  | "ENTRY_FRESH_STOP_CROSSED"
  | "ENTRY_FRESH_PRICE_MOVED";

export interface EntryFreshFacts {
  quoteAgeMs: number;
  bid: number;
  ask: number;
  spreadPoints: number;
  executablePrice: number;
  zoneDeviationPoints: number;
  source: string | null;
  /** Diagnostic copy of the observation's broker-clock offset; null when unknown. */
  brokerClockOffsetMs: number | null;
  /** Identical EA re-posts of the accepted tick before the claim. */
  quoteReposts: number;
  /** Silence of the feed before the tick's first sight (firstSeenAt − priorPostAt). */
  quoteFeedGapMs: number;
}

export type EntryFreshVerdict =
  | { ok: true; facts: EntryFreshFacts }
  | { ok: false; reason: EntryFreshReason; detail: string };

export interface EntryFreshInput {
  side: string;
  stopLoss: number | null;
  /** The decision thesis persisted in the admission snapshot. */
  thesis: unknown;
  observation: EntryMarketObservation | null | undefined;
  nowMs: number;
}

const refuseEntry = (reason: EntryFreshReason, detail: string): EntryFreshVerdict => ({
  ok: false,
  reason,
  detail,
});

function zoneOf(thesis: unknown): { lo: number; hi: number } | null {
  const zone =
    thesis != null && typeof thesis === "object"
      ? (thesis as { entryZone?: unknown }).entryZone
      : null;
  if (zone == null || typeof zone !== "object") return null;
  const { from, to } = zone as { from?: unknown; to?: unknown };
  if (!positive(from) || !positive(to)) return null;
  return { lo: Math.min(from, to), hi: Math.max(from, to) };
}

/**
 * The decision priced its stop distance and size from the thesis entry zone, and
 * only approved automatic entry while price was inside it (evaluateEntryZone
 * AT_ENTRY). At the final claim the executable side of a fresh quote must still be
 * inside that zone, allowing the EA's own deviation bound beyond its edges.
 */
export function evaluateEntryFreshFacts(input: EntryFreshInput): EntryFreshVerdict {
  const obs = input.observation;
  if (obs == null || obs.error)
    return refuseEntry("ENTRY_FRESH_QUOTE_UNAVAILABLE", describeQuoteUnavailable(obs));
  const age = classifyObservationAge(obs.observedAt, input.nowMs, ENTRY_QUOTE_MAX_AGE_MS);
  if (!age.ok)
    return refuseEntry(
      age.kind === "FUTURE"
        ? "ENTRY_FRESH_QUOTE_FUTURE_DATED"
        : age.kind === "STALE"
          ? "ENTRY_FRESH_QUOTE_STALE"
          : "ENTRY_FRESH_QUOTE_TIMESTAMP_INVALID",
      age.detail,
    );
  // The age above is `now − firstSeenAt`. It bounds the tick's age only when the
  // feed's previous post bounds when the tick occurred (see
  // ENTRY_QUOTE_MAX_FEED_GAP_MS); otherwise the quote may be the broker's frozen
  // last tick first seen just now, and "stale" is the honest verdict.
  const prov = obs.tickProvenance;
  if (prov == null)
    return refuseEntry(
      "ENTRY_FRESH_QUOTE_TIMESTAMP_INVALID",
      "no tick provenance: quote was not written by the bridge tick ingest",
    );
  const firstSeenMs = parseObservationTime(prov.firstSeenAt);
  if (firstSeenMs == null || firstSeenMs !== age.atMs)
    return refuseEntry(
      "ENTRY_FRESH_QUOTE_TIMESTAMP_INVALID",
      `tick provenance firstSeenAt=${describe(prov.firstSeenAt)} does not match observedAt=${describe(obs.observedAt)}`,
    );
  const reposts =
    typeof prov.reposts === "number" && Number.isInteger(prov.reposts) && prov.reposts >= 0
      ? prov.reposts
      : null;
  if (reposts == null)
    return refuseEntry(
      "ENTRY_FRESH_QUOTE_TIMESTAMP_INVALID",
      `tick provenance reposts=${describe(prov.reposts)}`,
    );
  const repostNote =
    reposts > 0 ? `, re-posted ${reposts} time${reposts === 1 ? "" : "s"} to ${showTime(prov.lastPostedAt)}` : "";
  if (prov.priorPostAt == null)
    return refuseEntry(
      "ENTRY_FRESH_QUOTE_STALE",
      `tick age unbounded: first tick this bridge posted for the symbol, first seen ${showTime(prov.firstSeenAt)}${repostNote}; no earlier post bounds when it occurred`,
    );
  const priorPostMs = parseObservationTime(prov.priorPostAt);
  if (priorPostMs == null)
    return refuseEntry(
      "ENTRY_FRESH_QUOTE_TIMESTAMP_INVALID",
      `tick provenance priorPostAt=${describe(prov.priorPostAt)}`,
    );
  const feedGapMs = firstSeenMs - priorPostMs;
  if (feedGapMs < 0 || feedGapMs > ENTRY_QUOTE_MAX_FEED_GAP_MS)
    return refuseEntry(
      "ENTRY_FRESH_QUOTE_STALE",
      `tick age unbounded: the feed's previous post was ${feedGapMs}ms before this tick was first seen ${showTime(prov.firstSeenAt)} (max ${ENTRY_QUOTE_MAX_FEED_GAP_MS}ms)${repostNote}; it may have occurred anywhere in that gap`,
    );
  const { bid, ask } = obs;
  if (!positive(bid) || !positive(ask) || ask < bid)
    return refuseEntry(
      "ENTRY_FRESH_QUOTE_PRICES_INVALID",
      `bid=${describe(bid)} ask=${describe(ask)}`,
    );
  if (!positive(obs.point))
    return refuseEntry("ENTRY_FRESH_SPREAD_UNMEASURABLE", `point=${describe(obs.point)}`);
  const point = obs.point;
  const spreadPoints = (ask - bid) / point;
  if (spreadPoints > ENTRY_MAX_SPREAD_POINTS)
    return refuseEntry(
      "ENTRY_FRESH_SPREAD_TOO_WIDE",
      `spread=${spreadPoints.toFixed(1)}pt > max ${ENTRY_MAX_SPREAD_POINTS}pt`,
    );
  if (input.side !== "BUY" && input.side !== "SELL")
    return refuseEntry("ENTRY_FRESH_DECISION_PRICE_MISSING", `side=${describe(input.side)}`);
  const zone = zoneOf(input.thesis);
  if (!zone || !positive(input.stopLoss))
    return refuseEntry(
      "ENTRY_FRESH_DECISION_PRICE_MISSING",
      `entryZone=${zone ? "ok" : "missing"} stopLoss=${describe(input.stopLoss)}`,
    );
  const buy = input.side === "BUY";
  // A long is stopped out at the bid, a short at the ask.
  if (buy ? bid <= input.stopLoss : ask >= input.stopLoss)
    return refuseEntry(
      "ENTRY_FRESH_STOP_CROSSED",
      `${buy ? "bid" : "ask"}=${buy ? bid : ask} already through stop ${input.stopLoss}`,
    );
  const executablePrice = buy ? ask : bid;
  const outside =
    executablePrice < zone.lo
      ? zone.lo - executablePrice
      : executablePrice > zone.hi
        ? executablePrice - zone.hi
        : 0;
  const zoneDeviationPoints = outside / point;
  if (zoneDeviationPoints > ENTRY_MAX_ZONE_DEVIATION_POINTS)
    return refuseEntry(
      "ENTRY_FRESH_PRICE_MOVED",
      `${buy ? "ask" : "bid"}=${executablePrice} is ${zoneDeviationPoints.toFixed(1)}pt outside entry zone ${zone.lo}-${zone.hi} (max ${ENTRY_MAX_ZONE_DEVIATION_POINTS}pt)`,
    );
  return {
    ok: true,
    facts: {
      quoteAgeMs: age.ageMs,
      bid,
      ask,
      spreadPoints,
      executablePrice,
      zoneDeviationPoints,
      source: obs.source,
      brokerClockOffsetMs:
        typeof obs.brokerClockOffsetMs === "number" && Number.isFinite(obs.brokerClockOffsetMs)
          ? obs.brokerClockOffsetMs
          : null,
      quoteReposts: reposts,
      quoteFeedGapMs: feedGapMs,
    },
  };
}

// ── Management: broker position observation before acting ───────────────────

export type PositionObservationReason =
  | "MANAGEMENT_OBSERVATION_TIMESTAMP_INVALID"
  | "MANAGEMENT_OBSERVATION_FUTURE_DATED"
  | "MANAGEMENT_OBSERVATION_STALE"
  | "MANAGEMENT_OBSERVATION_PRICE_INVALID"
  | "MANAGEMENT_OBSERVATION_PREDATES_COMMAND";

export type PositionObservationVerdict =
  | { ok: true; ageMs: number }
  | { ok: false; reason: PositionObservationReason; detail: string };

export interface PositionObservationInput {
  lastSyncedAt: unknown;
  /** Omit when only the timestamp matters (the final claim compares geometry itself). */
  currentPrice?: unknown;
  /**
   * Broker-affecting events on this ticket (entry fill, sent/filled/rejected
   * management commands). The observation must be newer than every one of them;
   * a malformed event time is treated as unknown and refuses.
   */
  commandEventTimes?: readonly unknown[];
  nowMs: number;
  maxAgeMs?: number;
}

export function evaluatePositionObservation(
  input: PositionObservationInput,
): PositionObservationVerdict {
  const maxAgeMs = input.maxAgeMs ?? POSITION_OBSERVATION_MAX_AGE_MS;
  const age = classifyObservationAge(input.lastSyncedAt, input.nowMs, maxAgeMs);
  if (!age.ok)
    return {
      ok: false,
      reason:
        age.kind === "FUTURE"
          ? "MANAGEMENT_OBSERVATION_FUTURE_DATED"
          : age.kind === "STALE"
            ? "MANAGEMENT_OBSERVATION_STALE"
            : "MANAGEMENT_OBSERVATION_TIMESTAMP_INVALID",
      detail: age.detail,
    };
  if ("currentPrice" in input && !positive(input.currentPrice))
    return {
      ok: false,
      reason: "MANAGEMENT_OBSERVATION_PRICE_INVALID",
      detail: `currentPrice=${describe(input.currentPrice)}`,
    };
  for (const event of input.commandEventTimes ?? []) {
    if (event == null) continue; // that event has not happened
    const eventMs = parseObservationTime(event);
    if (eventMs == null || eventMs >= age.atMs)
      return {
        ok: false,
        reason: "MANAGEMENT_OBSERVATION_PREDATES_COMMAND",
        detail:
          eventMs == null
            ? `command event time=${describe(event)}`
            : `observation ${new Date(age.atMs).toISOString()} not after command event ${new Date(eventMs).toISOString()}`,
      };
  }
  return { ok: true, ageMs: age.ageMs };
}
