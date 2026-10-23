// Phase 1 — Server adapter for the Live-Position Truth resolver.
//
// Builds the pure `PositionTruthInput` from the two row shapes Ruby/Eleanor and
// the open-trade surfaces actually read — `live_positions` (USER_OWNED_MT5) and
// `shared_trade_attribution` (SHARED_MASTER_MT5) — and splits a batch into
// verified-vs-unsynced/incomplete buckets for callers.
//
// This is the ONLY place that translates DB rows into the trust contract, so the
// resolver stays pure and every caller (Ruby tools, totals checks, tests) shares
// one mapping. It is read-only and block-only: it never mutates rows and never
// grants execution.

import { and, eq, ne, isNull, or, sql } from "drizzle-orm";
import { db } from "@workspace/db";
import {
  mt5ConnectionTable,
  livePositionsTable,
  sharedTradeAttributionTable,
} from "@workspace/db/schema";
import {
  resolvePositionTruth,
  type PositionTruthInput,
  type PositionTruthVerdict,
  type PositionFreshness,
} from "@workspace/domain/live-position";
import { classifyRow, isSnapshotReliable } from "./positionFreshness.js";
import type { LivePosition, SharedTradeAttributionRow } from "@workspace/db/schema";

// Same window the open-position view uses (comfortably longer than EA cadence).
const STALE_MS = 90_000;

const TERMINAL_LIVE_POSITION_STATUS = new Set([
  "CLOSED",
  "STOP_LOSS_HIT",
  "TAKE_PROFIT_HIT",
  "MANUALLY_CLOSED",
]);
const TERMINAL_ATTRIBUTION_STATUS = new Set(["closed", "rejected", "failed", "cancelled"]);

/**
 * Is the user's latest broker snapshot recent enough to trust freshness? Mirrors
 * the open-position view: max `last_positions_snapshot_at` across the user's
 * non-revoked, non-demo bridges. Returns false when no bridge has ever synced.
 */
export async function getUserSnapshotReliable(userId: number, now = Date.now()): Promise<boolean> {
  const rows = await db
    .select({ t: sql<string | null>`max(${mt5ConnectionTable.lastPositionsSnapshotAt})` })
    .from(mt5ConnectionTable)
    .where(and(
      eq(mt5ConnectionTable.userId, userId),
      ne(mt5ConnectionTable.status, "revoked"),
      or(isNull(mt5ConnectionTable.accountType), ne(mt5ConnectionTable.accountType, "demo")),
    ));
  const snapshotAtMs = rows[0]?.t ? new Date(rows[0].t).getTime() : null;
  return isSnapshotReliable(snapshotAtMs, STALE_MS, now);
}

function freshnessFor(lastSyncMs: number | null, snapshotReliable: boolean, now: number): PositionFreshness {
  return classifyRow(lastSyncMs, { windowMs: STALE_MS, now, snapshotReliable }).freshness;
}

/** Build the truth input from a `live_positions` (USER_OWNED_MT5) row. */
export function truthInputFromLivePosition(
  r: LivePosition,
  opts: { snapshotReliable: boolean; now?: number },
): PositionTruthInput {
  const now = opts.now ?? Date.now();
  const lastSyncMs = r.lastSyncedAt ? new Date(r.lastSyncedAt).getTime() : null;
  return {
    rowKind: "live_position",
    brokerTicket: r.brokerPositionId ?? null,
    symbol: r.symbol ?? null,
    side: r.direction ?? null,
    volume: r.lotSize ?? null,
    entryPrice: r.entryPrice ?? null,
    currentPrice: r.currentPrice ?? null,
    unrealizedPnl: r.unrealizedProfitLoss ?? null,
    // A user-owned live_positions row inherently originates from the user's own
    // MT5 bridge sync; the source is known whenever a broker ticket is present.
    bridgeAccountSource: r.brokerPositionId ? "user_owned_mt5" : null,
    openedAtMs: r.openedAt ? new Date(r.openedAt).getTime() : null,
    lastUpdateAtMs: lastSyncMs,
    freshness: freshnessFor(lastSyncMs, opts.snapshotReliable, now),
    // User-owned positions are directly attributed to the owning user row.
    attributionConfirmed: r.userId != null,
    closed: r.closedAt != null || TERMINAL_LIVE_POSITION_STATUS.has(r.status),
  };
}

/** Build the truth input from a `shared_trade_attribution` (SHARED_MASTER) row. */
export function truthInputFromAttribution(
  r: SharedTradeAttributionRow,
  opts: { now?: number },
): PositionTruthInput {
  const now = opts.now ?? Date.now();
  // Shared-master rows carry no per-user last-sync timestamp; the reconciler
  // stamps `updatedAt` on every P&L/state apply, so it is the best freshness
  // proxy. There is no per-user broker snapshot marker for shared netting.
  const lastSyncMs = r.updatedAt ? new Date(r.updatedAt).getTime() : null;
  return {
    rowKind: "shared_attribution",
    brokerTicket: r.mt5PositionTicket ?? null,
    symbol: r.symbol ?? null,
    side: r.side ?? null,
    volume: r.lotSize ?? null,
    entryPrice: r.entryPrice ?? null,
    // Shared master is netting — there is no broker-confirmed per-user current
    // price, so it is intentionally absent. Such rows therefore surface as
    // attributed-but-incomplete (real exposure, advice withheld) rather than
    // fully verified, which is the honest, conservative outcome.
    currentPrice: null,
    unrealizedPnl: r.pnl ?? null,
    bridgeAccountSource: r.mt5PositionTicket ? `shared_master_${r.sharedMasterAccountId}` : null,
    openedAtMs: r.openedAt ? new Date(r.openedAt).getTime() : null,
    lastUpdateAtMs: lastSyncMs,
    freshness: freshnessFor(lastSyncMs, /* snapshotReliable */ true, now),
    // The attribution row IS the per-user attribution; it is confirmed once the
    // broker filled it (status moved to "open"). A pending row is not confirmed.
    attributionConfirmed: r.status === "open",
    closed: r.closedAt != null || TERMINAL_ATTRIBUTION_STATUS.has(r.status),
  };
}

export interface TruthSplit<T> {
  /** Fully verified live positions — advice allowed. */
  verified: Array<{ row: T; verdict: PositionTruthVerdict }>;
  /** Real broker exposure but not fully verifiable yet — advice withheld, still
   *  counts toward exposure/risk totals. */
  incomplete: Array<{ row: T; verdict: PositionTruthVerdict }>;
  /** Not broker-confirmed (no ticket) / scanner / pending / closed — excluded
   *  from every total and from all advice. Diagnostic/repair visibility only. */
  unsynced: Array<{ row: T; verdict: PositionTruthVerdict }>;
}

/**
 * Split classified rows into verified / incomplete / unsynced buckets. Verified
 * rows may receive advice; the other two never do. `incomplete` still counts
 * toward exposure (real broker ticket); `unsynced` is excluded from all totals.
 */
export function splitByTruth<T>(
  items: Array<{ row: T; verdict: PositionTruthVerdict }>,
): TruthSplit<T> {
  const split: TruthSplit<T> = { verified: [], incomplete: [], unsynced: [] };
  for (const it of items) {
    if (it.verdict.isVerifiedLive) split.verified.push(it);
    else if (it.verdict.category === "attributed_but_incomplete_position") split.incomplete.push(it);
    else split.unsynced.push(it);
  }
  return split;
}

/** Classify a single live_positions row (convenience for one-row callers). */
export function classifyLivePosition(
  r: LivePosition,
  opts: { snapshotReliable: boolean; now?: number },
): PositionTruthVerdict {
  return resolvePositionTruth(truthInputFromLivePosition(r, opts));
}

/** Classify a single shared_trade_attribution row (convenience). */
export function classifyAttribution(
  r: SharedTradeAttributionRow,
  opts: { now?: number },
): PositionTruthVerdict {
  return resolvePositionTruth(truthInputFromAttribution(r, opts));
}

/**
 * Classify a user-scoped trade key ("lp_<id>" | "att_<id>") straight from the DB
 * into a truth verdict. This is the SINGLE entry every advisory tool uses to
 * decide whether it may speak about a row, so the trust contract is enforced in
 * exactly one place. Returns null when the key is malformed or the row does not
 * exist / does not belong to the user (caller maps that to trade-not-found).
 */
export async function classifyTradeKey(
  userId: number,
  tradeKey: string,
  now = Date.now(),
): Promise<PositionTruthVerdict | null> {
  const k = (tradeKey ?? "").toString().trim();
  if (k.startsWith("lp_")) {
    const id = Number(k.slice(3));
    if (!Number.isFinite(id) || id <= 0) return null;
    const [r] = await db.select().from(livePositionsTable)
      .where(and(eq(livePositionsTable.id, id), eq(livePositionsTable.userId, userId))).limit(1);
    if (!r) return null;
    const snapshotReliable = await getUserSnapshotReliable(userId, now);
    return classifyLivePosition(r, { snapshotReliable, now });
  }
  if (k.startsWith("att_")) {
    const id = Number(k.slice(4));
    if (!Number.isFinite(id) || id <= 0) return null;
    const [r] = await db.select().from(sharedTradeAttributionTable)
      .where(and(eq(sharedTradeAttributionTable.id, id), eq(sharedTradeAttributionTable.userId, userId))).limit(1);
    if (!r) return null;
    return classifyAttribution(r, { now });
  }
  return null;
}
