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
import {
  classifyHeartbeatAt,
  heartbeatIsOnline,
} from "@workspace/domain/broker-health/heartbeatPolicy";
import type { ProtectiveHoldReason } from "@workspace/domain/self-trade";

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
  /** Source observation time of the quote (broker tick time), never fetch time. */
  observedAt: unknown;
  source: string | null;
  /** Broker SYMBOL_POINT for converting distances to points; null when unknown. */
  point: unknown;
  /** Present when the quote or spec could not be read. */
  error?: string | null;
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
    return refuseEntry("ENTRY_FRESH_QUOTE_UNAVAILABLE", obs?.error ?? "no quote observation");
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

// ── Protective action: fresh, sweep-provenance evidence for the exact row ────
//
// Stricter than evaluatePositionObservation, never looser. The protective path
// starts from an ordinary hold and may only act on a row that a COMPLETE
// terminal sweep wrote strictly after that hold. The same 90 s window applies;
// there is no separate protective window.

export type ProtectiveObservationReason = Extract<
  ProtectiveHoldReason,
  | `PROTECTIVE_OBSERVATION_${string}`
  | "PROTECTIVE_POSITION_ABSENT_AT_BROKER"
  | "PROTECTIVE_SWEEP_MARKER_STALE"
  | "PROTECTIVE_BRIDGE_OFFLINE"
>;

export interface ProtectiveObservationRow {
  lastSyncedAt: unknown;
  /** Only the complete sweep writes this equal to lastSyncedAt (routes/mt5Live.ts). */
  lastReliableSnapshotAt: unknown;
  brokerAbsentSnapshotCount: unknown;
  closedAt: unknown;
  reconcileState: unknown;
  currentPrice: unknown;
  entryPrice: unknown;
  volume: unknown;
  /** Detail only. */
  brokerTicket?: unknown;
  firstBrokerAbsentAt?: unknown;
}

export interface ProtectiveObservationConnection {
  lastPositionsSnapshotAt: unknown;
  lastHeartbeat: unknown;
}

export interface ProtectiveObservationInput {
  row: ProtectiveObservationRow;
  connection: ProtectiveObservationConnection | null | undefined;
  /** The hold time: the observation must be strictly newer (manager wait loop). */
  mustBeAfterMs?: number | null;
  /** The claimed evidence time: the locked row may not precede it (final claim). */
  mustNotPrecedeMs?: number | null;
  commandEventTimes?: readonly unknown[];
  nowMs: number;
  maxAgeMs?: number;
}

export type ProtectiveObservationVerdict =
  | { ok: true; observedAtMs: number; ageMs: number; sweepAtMs: number }
  | { ok: false; reason: ProtectiveObservationReason; detail: Record<string, unknown> };

const heartbeatValue = (v: unknown): Date | string | number | null =>
  v instanceof Date || typeof v === "string" || typeof v === "number" ? v : null;

export function evaluateProtectiveObservation(
  input: ProtectiveObservationInput,
): ProtectiveObservationVerdict {
  const maxAgeMs = input.maxAgeMs ?? POSITION_OBSERVATION_MAX_AGE_MS;
  const row = input.row;
  const no = (
    reason: ProtectiveObservationReason,
    detail: Record<string, unknown>,
  ): ProtectiveObservationVerdict => ({ ok: false, reason, detail });
  const iso = (ms: number) => new Date(ms).toISOString();

  // 1. Still an open, unreconciled row.
  if (row.closedAt != null || row.reconcileState != null)
    return no("PROTECTIVE_OBSERVATION_POSITION_CLOSED", {
      closedAt: row.closedAt instanceof Date ? row.closedAt.toISOString() : row.closedAt,
      reconcileState: row.reconcileState,
    });
  // 2. Usable, current row time (same parsing as the ordinary rule).
  const age = classifyObservationAge(row.lastSyncedAt, input.nowMs, maxAgeMs);
  if (!age.ok)
    return no(
      age.kind === "FUTURE"
        ? "PROTECTIVE_OBSERVATION_FUTURE_DATED"
        : age.kind === "STALE"
          ? "PROTECTIVE_OBSERVATION_STALE"
          : "PROTECTIVE_OBSERVATION_TIMESTAMP_INVALID",
      {
        detail: age.detail,
        ageMs: age.kind === "STALE" ? input.nowMs - (parseObservationTime(row.lastSyncedAt) ?? 0) : undefined,
        ms: age.kind === "FUTURE" ? (parseObservationTime(row.lastSyncedAt) ?? 0) - input.nowMs : undefined,
      },
    );
  const observedAtMs = age.atMs;
  // 3. Written by a complete sweep, not a reconciler.
  if (parseObservationTime(row.lastReliableSnapshotAt) !== observedAtMs)
    return no("PROTECTIVE_OBSERVATION_NOT_FROM_SWEEP", {
      observedAt: iso(observedAtMs),
      lastReliableSnapshotAt: describe(row.lastReliableSnapshotAt),
    });
  // 4. The latest complete sweep listed the ticket.
  if (row.brokerAbsentSnapshotCount !== 0)
    return no("PROTECTIVE_POSITION_ABSENT_AT_BROKER", {
      ticket: row.brokerTicket,
      count: row.brokerAbsentSnapshotCount,
      firstAbsentAt:
        row.firstBrokerAbsentAt instanceof Date
          ? row.firstBrokerAbsentAt.toISOString()
          : row.firstBrokerAbsentAt,
    });
  // 5. Strictly newer than the hold / not before the claimed evidence. A bound
  //    that is present but unusable refuses (fail closed).
  if (input.mustBeAfterMs != null) {
    const bound = input.mustBeAfterMs;
    if (!Number.isFinite(bound) || !(observedAtMs > bound))
      return no("PROTECTIVE_OBSERVATION_NOT_NEWER", {
        observedAt: iso(observedAtMs),
        heldAt: Number.isFinite(bound) ? iso(bound) : describe(bound),
      });
  }
  if (input.mustNotPrecedeMs != null) {
    const bound = input.mustNotPrecedeMs;
    if (!Number.isFinite(bound) || !(observedAtMs >= bound))
      return no("PROTECTIVE_OBSERVATION_NOT_NEWER", {
        observedAt: iso(observedAtMs),
        heldAt: Number.isFinite(bound) ? iso(bound) : describe(bound),
      });
  }
  // 6. After every broker-affecting command on the ticket.
  for (const event of input.commandEventTimes ?? []) {
    if (event == null) continue;
    const eventMs = parseObservationTime(event);
    if (eventMs == null || eventMs >= observedAtMs)
      return no("PROTECTIVE_OBSERVATION_PREDATES_COMMAND", {
        observedAt: iso(observedAtMs),
        eventAt: eventMs == null ? describe(event) : iso(eventMs),
      });
  }
  // 7. The bridge's complete-sweep marker covers the row and is itself current.
  const conn = input.connection;
  const sweepAtMs = conn ? parseObservationTime(conn.lastPositionsSnapshotAt) : null;
  const marker = sweepAtMs == null ? null : classifyObservationAge(sweepAtMs, input.nowMs, maxAgeMs);
  if (sweepAtMs == null || sweepAtMs < observedAtMs || !marker || !marker.ok)
    return no("PROTECTIVE_SWEEP_MARKER_STALE", {
      observedAt: iso(observedAtMs),
      sweepAt: sweepAtMs == null ? describe(conn?.lastPositionsSnapshotAt) : iso(sweepAtMs),
      ageMs: sweepAtMs == null ? undefined : input.nowMs - sweepAtMs,
    });
  // 8. The bridge is online (fresh or degraded); "fresh" is required separately before a claim.
  const heartbeat = classifyHeartbeatAt(heartbeatValue(conn!.lastHeartbeat), input.nowMs);
  if (!heartbeatIsOnline(heartbeat)) {
    const hbMs = parseObservationTime(conn!.lastHeartbeat);
    return no("PROTECTIVE_BRIDGE_OFFLINE", {
      heartbeat,
      ageMs: hbMs == null ? undefined : input.nowMs - hbMs,
    });
  }
  // 9. Usable price and size.
  if (!positive(row.currentPrice) || !positive(row.entryPrice) || !positive(row.volume))
    return no("PROTECTIVE_OBSERVATION_PRICE_INVALID", {
      detail: `currentPrice=${describe(row.currentPrice)} entryPrice=${describe(row.entryPrice)} volume=${describe(row.volume)}`,
    });
  return { ok: true, observedAtMs, ageMs: age.ageMs, sweepAtMs };
}
