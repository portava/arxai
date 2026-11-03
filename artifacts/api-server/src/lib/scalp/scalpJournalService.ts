// Ruby Flame Scalp — journal + personality service (Phase 3, DB side).
//
// Records every scalp basket's lifecycle, finalizes it on close with an honest
// result + plain-English after-action review, and rolls a per-symbol
// personality that feeds a bounded, tightening-only nudge back into the engine.
//
// SAFETY / honesty:
//  - Per-user isolation: EVERY read and write below is scoped by userId. No row
//    from another user is ever read or returned.
//  - Additive only: this module records what already happened. It NEVER places,
//    modifies, sizes or closes an order, and never touches trade/order/position
//    truth tables (it only READS arx_live_positions for each leg's last reading).
//  - No fabrication: no broker-realised P/L is recorded, so a closed scalp's
//    P/L is ESTIMATED (the last floating readings of every leg) or UNKNOWN.
//    KNOWN is reserved for a broker-reported realised figure. We never invent
//    a number or a margin.
//  - Learning only ever TIGHTENS (qualityBias ≤ 0, minQualityDelta ≥ 0).

import { livePositionLedger, livePositionColumns } from "../positions/ledger.js";
import { and, eq, inArray, desc, isNotNull, sql } from "drizzle-orm";
import {
  db,
  scalpJournalEntriesTable,
  scalpSymbolPersonalityTable,
  type ScalpJournalEntry,
  type ScalpSymbolPersonality,
} from "@workspace/db";
import {
  applyPersonalityDelta,
  computeQualityBias,
  deriveResult,
  deriveReview,
  findContinuedEntry,
  higherUrgency,
  storedLegTickets,
  unionLegTickets,
  EMPTY_PERSONALITY_COUNTS,
  type JournalEntrySnapshot,
  type PersonalityClosedTrade,
  type PersonalityCounts,
  type ScalpJournalResult,
} from "./scalpJournal.js";
import type { ScalpExitUrgency } from "./scalpTypes.js";

function num(v: unknown): v is number {
  return typeof v === "number" && Number.isFinite(v);
}

/** Account modes that own a journal. PAPER/NONE never record. */
export type JournalAccountMode = "LIVE_SHARED" | "DEMO";

const REVERSAL_STAGES = new Set(["FAILED", "REVERSAL_RISK", "EXHAUSTED", "WEAKENING"]);
function stageReversed(stage: string | null): boolean {
  return stage != null && REVERSAL_STAGES.has(stage);
}

// ── Recording (called as a side-effect from getScalpBaskets) ─────────────────

export interface ObservationSnapshot extends JournalEntrySnapshot {
  /** Broker tickets of the open legs (LIVE realized-P/L matching). */
  legTickets: string[];
}

/**
 * Record the current open baskets for a user and finalize any that have since
 * closed. Idempotent per poll: an existing OPEN entry is updated in place; a
 * brand-new basket inserts an entry with its at-entry snapshot; an OPEN entry
 * whose basket is no longer present is finalized (closed) with result + review,
 * and folded into the per-symbol personality.
 *
 * Best-effort: any failure is swallowed so journaling can never break the live
 * baskets feed. Scoped strictly to (userId, accountMode).
 */
export async function recordScalpBasketsObservation(
  userId: number,
  accountMode: JournalAccountMode,
  snapshots: ObservationSnapshot[],
): Promise<void> {
  try {
    const now = new Date();
    const dbOpen = await db.select().from(scalpJournalEntriesTable).where(and(
      eq(scalpJournalEntriesTable.userId, userId),
      eq(scalpJournalEntriesTable.accountMode, accountMode),
      eq(scalpJournalEntriesTable.status, "OPEN"),
    ));
    const openKeys = new Set(snapshots.map((s) => s.basketKey));
    const stillOpenIds = new Set<number>();

    // 1) Upsert each currently-open basket. A basket whose oldest leg closed
    //    has a new first-leg key but is the same scalp: it continues its OPEN
    //    entry (matched by a shared ticket) instead of starting a new one.
    for (const s of snapshots) {
      const continued = findContinuedEntry(dbOpen, s);
      if (continued) {
        await updateOpenEntry(userId, continued, s, now);
        stillOpenIds.add(continued.id);
      } else {
        await upsertOpenEntry(userId, accountMode, s, now);
      }
    }

    // 2) Finalize entries that are OPEN in the DB but no longer present live.
    for (const row of dbOpen) {
      if (stillOpenIds.has(row.id) || openKeys.has(row.basketKey)) continue;
      await finalizeClosedEntry(userId, accountMode, row, now);
    }
  } catch {
    // Journaling is advisory — never let it break the baskets response.
  }
}

async function upsertOpenEntry(
  userId: number,
  accountMode: JournalAccountMode,
  s: ObservationSnapshot,
  now: Date,
): Promise<void> {
  const existing = await db.select().from(scalpJournalEntriesTable).where(and(
    eq(scalpJournalEntriesTable.userId, userId),
    eq(scalpJournalEntriesTable.basketKey, s.basketKey),
  )).limit(1);

  if (existing.length === 0) {
    await db.insert(scalpJournalEntriesTable).values({
      userId,
      accountMode,
      symbol: s.symbol,
      displayName: s.displayName,
      assetClass: s.assetClass,
      isSynthetic: s.isSynthetic,
      direction: s.direction,
      timeframe: s.timeframe,
      scalpMode: s.scalpMode,
      setupType: s.setupType,
      basketKey: s.basketKey,
      legTickets: s.legTickets,
      entryCount: s.entryCount,
      addOnCount: s.addOnCount,
      averageEntry: s.averageEntry,
      breakEvenPrice: s.breakEvenPrice,
      scoreAtEntry: s.scoreAtEntry,
      flameStageAtEntry: s.flameStageAtEntry,
      flameAgeAtEntry: s.flameAgeAtEntry,
      entryTimingAtEntry: s.entryTimingAtEntry,
      chaseRiskAtEntry: s.chaseRiskAtEntry,
      spreadPointsAtEntry: s.spreadPointsAtEntry,
      executionLatencyAtEntry: s.executionLatencyAtEntry,
      htfContextAtEntry: s.htfContextAtEntry,
      whyNowAtEntry: s.whyNowAtEntry,
      maxExitUrgency: s.maxExitUrgency,
      lastFlameStage: s.flameStageAtEntry,
      flameContinued: s.flameContinued,
      lastFloatingPl: s.lastFloatingPl,
      lastCurrentPrice: s.lastCurrentPrice,
      result: "OPEN",
      status: "OPEN",
      observationCount: 1,
      openedAt: s.openedAtMs != null ? new Date(s.openedAtMs) : now,
      createdAt: now,
      updatedAt: now,
    }).onConflictDoNothing({
      target: [scalpJournalEntriesTable.userId, scalpJournalEntriesTable.basketKey],
    });
    return;
  }

  await updateOpenEntry(userId, existing[0]!, s, now);
}

async function updateOpenEntry(
  userId: number,
  prev: ScalpJournalEntry,
  s: ObservationSnapshot,
  now: Date,
): Promise<void> {
  // Update the evolving fields only — keep the at-entry snapshot frozen. The
  // leg tickets and the add-on count only grow: a leg closed early is still
  // part of this scalp, and its result is read from its ticket when the scalp
  // closes. entryCount stays the legs open at this observation, the legs the
  // last floating reading covers.
  const maxUrg = higherUrgency(prev.maxExitUrgency as ScalpExitUrgency, s.maxExitUrgency);
  await db.update(scalpJournalEntriesTable).set({
    legTickets: unionLegTickets(prev.legTickets, s.legTickets),
    entryCount: s.entryCount,
    addOnCount: Math.max(prev.addOnCount, s.addOnCount),
    averageEntry: s.averageEntry,
    breakEvenPrice: s.breakEvenPrice,
    maxExitUrgency: maxUrg,
    lastFlameStage: s.flameStageAtEntry,
    flameContinued: s.flameContinued,
    lastFloatingPl: s.lastFloatingPl,
    lastCurrentPrice: s.lastCurrentPrice,
    observationCount: sql`${scalpJournalEntriesTable.observationCount} + 1`,
    updatedAt: now,
  }).where(and(
    eq(scalpJournalEntriesTable.userId, userId),
    eq(scalpJournalEntriesTable.id, prev.id),
  ));
}

async function finalizeClosedEntry(
  userId: number,
  accountMode: JournalAccountMode,
  row: ScalpJournalEntry,
  now: Date,
): Promise<void> {
  // No broker-realised P/L is recorded anywhere: the closing paths only stamp
  // closedAt on arx_live_positions, so its floatingPl is the last floating
  // reading the bridge sent for that leg (no commission/swap, possibly
  // minutes old). Every figure here is therefore an ESTIMATE, never KNOWN.
  //  - LIVE: when every leg ticket has a closed ledger row with a reading,
  //    the estimate is the sum of those last readings (it covers legs that
  //    closed early, and is usually newer than the journal's last poll).
  //  - Otherwise the journal's last floating reading, but only when it
  //    covered every leg: once a leg closed while the scalp stayed open, that
  //    reading misses it and the result is UNKNOWN.
  const tickets = storedLegTickets(row.legTickets);
  const legsClosedEarly = tickets.length > row.entryCount;
  let ledgerReading: number | null = null;
  let exitPrice: number | null = null;
  if (accountMode === "LIVE_SHARED" && tickets.length > 0) {
    const closed = await livePositionLedger.read({
      where: and(
        eq(livePositionColumns.userId, userId),
        inArray(livePositionColumns.brokerTicket, tickets),
        isNotNull(livePositionColumns.closedAt),
      ),
    });
    const readings = new Map<string, number>();
    for (const c of closed) {
      const pl = c.floatingPl != null ? Number(c.floatingPl) : NaN;
      if (c.brokerTicket != null && Number.isFinite(pl)) readings.set(String(c.brokerTicket), pl);
      if (c.currentPrice != null) exitPrice = Number(c.currentPrice);
    }
    if (tickets.every((t) => readings.has(t))) {
      ledgerReading = tickets.reduce((sum, t) => sum + readings.get(t)!, 0);
    }
  }

  const storedLast = row.lastFloatingPl != null ? Number(row.lastFloatingPl) : null;
  const lastFloatingPl = ledgerReading ?? (legsClosedEarly ? null : storedLast);
  const { result, plQuality } = deriveResult({ realizedPl: null, lastFloatingPl });
  // The closed scalp's own legs: every ticket it held, not only the last open ones.
  const entryCount = Math.max(row.entryCount, tickets.length);
  const addOnCount = Math.max(row.addOnCount, entryCount - 1);
  const flameContinued = row.flameContinued ?? false;
  const review = deriveReview({
    result,
    plQuality,
    flameStageAtEntry: row.flameStageAtEntry,
    entryTimingAtEntry: row.entryTimingAtEntry,
    maxExitUrgency: row.maxExitUrgency as ScalpExitUrgency,
    flameContinued,
    addOnCount,
    isSynthetic: row.isSynthetic,
  });

  // Conditional finalize: only the still-OPEN row transitions (idempotent).
  const res = await db.update(scalpJournalEntriesTable).set({
    status: "CLOSED",
    result,
    plQuality,
    realizedPl: null,
    ...(ledgerReading != null ? { lastFloatingPl: ledgerReading } : {}),
    entryCount,
    addOnCount,
    exitPrice: exitPrice ?? row.lastCurrentPrice,
    exitReason: review.exitReason,
    lesson: review.lesson,
    rubyWarnedCorrectly: review.warnedCorrectly,
    closedAt: now,
    updatedAt: now,
  }).where(and(
    eq(scalpJournalEntriesTable.userId, userId),
    eq(scalpJournalEntriesTable.id, row.id),
    eq(scalpJournalEntriesTable.status, "OPEN"),
  )).returning({ id: scalpJournalEntriesTable.id });

  // Only fold personality once — guarded by the conditional update above.
  if (res.length === 0) return;
  if (result === "OPEN") return;

  await foldPersonality(userId, {
    symbol: row.symbol,
    displayName: row.displayName,
    assetClass: row.assetClass,
    isSynthetic: row.isSynthetic,
    closed: {
      result: result as ScalpJournalResult,
      flameReversedAtClose: result === "LOSS" && stageReversed(row.lastFlameStage),
      flameContinued,
      spreadPointsAtEntry: row.spreadPointsAtEntry != null ? Number(row.spreadPointsAtEntry) : null,
      flameAgeAtEntry: row.flameAgeAtEntry,
      scoreAtEntry: row.scoreAtEntry,
      isSynthetic: row.isSynthetic,
    },
  });

}

// ── Per-symbol personality fold ──────────────────────────────────────────────

function rowToCounts(p: ScalpSymbolPersonality): PersonalityCounts {
  return {
    tradesClosed: p.tradesClosed,
    wins: p.wins,
    losses: p.losses,
    breakevens: p.breakevens,
    reversalCount: p.reversalCount,
    fakeoutCount: p.fakeoutCount,
    continuationCount: p.continuationCount,
    avgSpreadPoints: p.avgSpreadPoints != null ? Number(p.avgSpreadPoints) : null,
    avgFlameAgeAtEntry: p.avgFlameAgeAtEntry != null ? Number(p.avgFlameAgeAtEntry) : null,
    avgScoreAtEntry: p.avgScoreAtEntry != null ? Number(p.avgScoreAtEntry) : null,
    sampleCount: p.sampleCount,
    isSynthetic: p.isSynthetic,
  };
}

export async function foldPersonality(
  userId: number,
  args: {
    symbol: string;
    displayName: string | null;
    assetClass: string | null;
    isSynthetic: boolean;
    closed: PersonalityClosedTrade;
  },
): Promise<void> {
  const now = new Date();
  // The fold is a read-modify-write over running counts/averages, so two
  // concurrent closes on the same (user, symbol) could lose an update. We
  // serialize on the personality row: ensure it exists, then SELECT … FOR
  // UPDATE inside a transaction so the second close folds onto the first's
  // committed counts instead of a stale snapshot.
  await db.transaction(async (tx) => {
    await tx.insert(scalpSymbolPersonalityTable).values({
      userId,
      symbol: args.symbol,
      displayName: args.displayName,
      assetClass: args.assetClass,
      isSynthetic: args.isSynthetic,
      createdAt: now,
      updatedAt: now,
    }).onConflictDoNothing({
      target: [scalpSymbolPersonalityTable.userId, scalpSymbolPersonalityTable.symbol],
    });

    const locked = await tx.select().from(scalpSymbolPersonalityTable).where(and(
      eq(scalpSymbolPersonalityTable.userId, userId),
      eq(scalpSymbolPersonalityTable.symbol, args.symbol),
    )).for("update").limit(1);

    const prevCounts = locked[0]
      ? rowToCounts(locked[0])
      : { ...EMPTY_PERSONALITY_COUNTS, isSynthetic: args.isSynthetic };
    const next = applyPersonalityDelta(prevCounts, args.closed);
    const bias = computeQualityBias(next);

    await tx.update(scalpSymbolPersonalityTable).set({
      displayName: args.displayName,
      assetClass: args.assetClass,
      isSynthetic: next.isSynthetic,
      tradesClosed: next.tradesClosed,
      wins: next.wins,
      losses: next.losses,
      breakevens: next.breakevens,
      reversalCount: next.reversalCount,
      fakeoutCount: next.fakeoutCount,
      continuationCount: next.continuationCount,
      avgSpreadPoints: next.avgSpreadPoints,
      avgFlameAgeAtEntry: next.avgFlameAgeAtEntry,
      avgScoreAtEntry: next.avgScoreAtEntry,
      qualityBias: bias.qualityBias,
      minQualityDelta: bias.minQualityDelta,
      sampleCount: next.sampleCount,
      notes: bias.notes,
      updatedAt: now,
    }).where(and(
      eq(scalpSymbolPersonalityTable.userId, userId),
      eq(scalpSymbolPersonalityTable.symbol, args.symbol),
    ));
  });
}

// ── Engine feedback loader ───────────────────────────────────────────────────

export interface LoadedSymbolPersonality {
  qualityBias: number;
  minQualityDelta: number;
  isSynthetic: boolean;
}

/**
 * Bounded, tightening-only nudge for the engine. Returns null when there is no
 * learned personality yet (engine then runs exactly as before). Defensive: any
 * out-of-contract value is clamped to the safe (tightening) side.
 */
export async function loadSymbolPersonality(
  userId: number,
  symbol: string,
): Promise<LoadedSymbolPersonality | null> {
  try {
    const rows = await db.select({
      qualityBias: scalpSymbolPersonalityTable.qualityBias,
      minQualityDelta: scalpSymbolPersonalityTable.minQualityDelta,
      isSynthetic: scalpSymbolPersonalityTable.isSynthetic,
    }).from(scalpSymbolPersonalityTable).where(and(
      eq(scalpSymbolPersonalityTable.userId, userId),
      eq(scalpSymbolPersonalityTable.symbol, symbol),
    )).limit(1);
    const r = rows[0];
    if (!r) return null;
    const qb = Number(r.qualityBias);
    const mqd = Number(r.minQualityDelta);
    return {
      // Clamp to the safe side no matter what is stored (never loosens).
      qualityBias: Number.isFinite(qb) ? Math.min(0, Math.max(-8, qb)) : 0,
      minQualityDelta: Number.isFinite(mqd) ? Math.min(10, Math.max(0, mqd)) : 0,
      isSynthetic: !!r.isSynthetic,
    };
  } catch {
    return null;
  }
}

// ── User-facing reads (all per-user scoped) ──────────────────────────────────

export interface JournalListItem {
  id: number;
  accountMode: string;
  symbol: string;
  displayName: string | null;
  isSynthetic: boolean;
  direction: string;
  timeframe: string;
  setupType: string | null;
  entryCount: number;
  addOnCount: number;
  scoreAtEntry: number | null;
  flameStageAtEntry: string | null;
  entryTimingAtEntry: string | null;
  chaseRiskAtEntry: string | null;
  status: string;
  result: string;
  plQuality: string;
  realizedPl: number | null;
  lastFloatingPl: number | null;
  flameContinued: boolean | null;
  rubyWarnedCorrectly: boolean | null;
  exitReason: string | null;
  lesson: string | null;
  openedAt: string | null;
  closedAt: string | null;
}

function toListItem(r: ScalpJournalEntry): JournalListItem {
  // Rows finalized before the fix above stored the sum of the legs' last
  // floating readings as a KNOWN realised P/L. Nothing has ever recorded a
  // broker-realised figure, so such a row is reported as the estimate it is.
  // The stored row is not changed.
  if (r.plQuality === "KNOWN") {
    const item = toListItemAsStored(r);
    return {
      ...item,
      plQuality: "ESTIMATED",
      lastFloatingPl: item.realizedPl ?? item.lastFloatingPl,
      realizedPl: null,
    };
  }
  return toListItemAsStored(r);
}

function toListItemAsStored(r: ScalpJournalEntry): JournalListItem {
  return {
    id: r.id,
    accountMode: r.accountMode,
    symbol: r.symbol,
    displayName: r.displayName,
    isSynthetic: r.isSynthetic,
    direction: r.direction,
    timeframe: r.timeframe,
    setupType: r.setupType,
    entryCount: r.entryCount,
    addOnCount: r.addOnCount,
    scoreAtEntry: r.scoreAtEntry,
    flameStageAtEntry: r.flameStageAtEntry,
    entryTimingAtEntry: r.entryTimingAtEntry,
    chaseRiskAtEntry: r.chaseRiskAtEntry,
    status: r.status,
    result: r.result,
    plQuality: r.plQuality,
    realizedPl: r.realizedPl != null ? Number(r.realizedPl) : null,
    lastFloatingPl: r.lastFloatingPl != null ? Number(r.lastFloatingPl) : null,
    flameContinued: r.flameContinued,
    rubyWarnedCorrectly: r.rubyWarnedCorrectly,
    exitReason: r.exitReason,
    lesson: r.lesson,
    openedAt: r.openedAt ? new Date(r.openedAt).toISOString() : null,
    closedAt: r.closedAt ? new Date(r.closedAt).toISOString() : null,
  };
}

/** Full per-user journal (newest first). */
export async function getScalpJournal(
  userId: number,
  opts: { limit?: number } = {},
): Promise<{ entries: JournalListItem[]; generatedAt: string }> {
  const limit = Math.max(1, Math.min(200, opts.limit ?? 50));
  const rows = await db.select().from(scalpJournalEntriesTable)
    .where(eq(scalpJournalEntriesTable.userId, userId))
    .orderBy(desc(scalpJournalEntriesTable.updatedAt))
    .limit(limit);
  return { entries: rows.map(toListItem), generatedAt: new Date().toISOString() };
}

/** Recently CLOSED scalps with their after-action review (newest first). */
export async function getScalpAfterActionReviews(
  userId: number,
  opts: { limit?: number } = {},
): Promise<{ reviews: JournalListItem[]; generatedAt: string }> {
  const limit = Math.max(1, Math.min(100, opts.limit ?? 20));
  const rows = await db.select().from(scalpJournalEntriesTable)
    .where(and(
      eq(scalpJournalEntriesTable.userId, userId),
      eq(scalpJournalEntriesTable.status, "CLOSED"),
    ))
    .orderBy(desc(scalpJournalEntriesTable.closedAt))
    .limit(limit);
  return { reviews: rows.map(toListItem), generatedAt: new Date().toISOString() };
}

export interface SymbolPersonalityItem {
  symbol: string;
  displayName: string | null;
  isSynthetic: boolean;
  tradesClosed: number;
  wins: number;
  losses: number;
  breakevens: number;
  winRatePct: number | null;
  reversalCount: number;
  fakeoutCount: number;
  continuationCount: number;
  avgScoreAtEntry: number | null;
  cautious: boolean;
  notes: string | null;
  updatedAt: string | null;
}

/** Per-user, per-symbol personality (most-traded first). Plain-English notes. */
export async function getSymbolPersonalities(
  userId: number,
  opts: { limit?: number } = {},
): Promise<{ symbols: SymbolPersonalityItem[]; generatedAt: string }> {
  const limit = Math.max(1, Math.min(100, opts.limit ?? 50));
  const rows = await db.select().from(scalpSymbolPersonalityTable)
    .where(eq(scalpSymbolPersonalityTable.userId, userId))
    .orderBy(desc(scalpSymbolPersonalityTable.tradesClosed))
    .limit(limit);
  const symbols: SymbolPersonalityItem[] = rows.map((p) => ({
    symbol: p.symbol,
    displayName: p.displayName,
    isSynthetic: p.isSynthetic,
    tradesClosed: p.tradesClosed,
    wins: p.wins,
    losses: p.losses,
    breakevens: p.breakevens,
    winRatePct: p.tradesClosed > 0 ? Math.round((p.wins / p.tradesClosed) * 100) : null,
    reversalCount: p.reversalCount,
    fakeoutCount: p.fakeoutCount,
    continuationCount: p.continuationCount,
    avgScoreAtEntry: p.avgScoreAtEntry != null ? Number(p.avgScoreAtEntry) : null,
    // "Cautious" = Ruby is applying a real tightening nudge here.
    cautious: Number(p.qualityBias) < 0 || Number(p.minQualityDelta) > 0,
    notes: p.notes,
    updatedAt: p.updatedAt ? new Date(p.updatedAt).toISOString() : null,
  }));
  return { symbols, generatedAt: new Date().toISOString() };
}

