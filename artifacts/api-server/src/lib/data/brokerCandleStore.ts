// ── Broker-native candle store + backfill state machine (Task #469, Phase A) ──
//
// The server-side service behind the EA-facing batch ingest endpoint
//   POST /api/mt5/candles/ingest   (X-MT5-Bridge-Token: <per-user token>)
//
// It EXTENDS the existing MT5 candle ingestion foundation rather than building a
// parallel path:
//   - it writes the durable, bridge-scoped `broker_candles` system of record
//     (full provenance, pinned timeframe enum, closed-bar finalization), and
//   - it maintains the `broker_candle_backfill_status` state machine, and
//   - it MIRRORS accepted CLOSED bars into the existing `market_candles` cache
//     (source "mt5_broker") + the in-memory `mt5Provider` series, so the chart/
//     scanner read path keeps reading broker-native bars with no source-priority
//     change (that is Phase B and out of scope here).
//
// SAFETY / HONESTY (must hold):
//   - MARKET-DATA / TELEMETRY ONLY. No execution, no 16-gate, no `arx_live_*`,
//     no balances, margin, or fills.
//   - Never fabricates. Invalid bars are dropped; a STALE/replayed transport is
//     refused; an empty/all-invalid payload never clears an existing good
//     series; a CONFLICTING finalized bar is rejected, never silently
//     overwritten; a FORMING bar is never mirrored into the live read path.
//   - Per-user isolation: every row carries the bridge owner's `userId` and the
//     unique key is bridge-scoped, so one account's bars can never collide with
//     another's.
//   - The EA producer side is UNTESTABLE in this environment, so the contract is
//     validated server-side via crafted, real-shaped payloads (see the test).

import { z } from "zod/v4";
import { and, desc, eq } from "drizzle-orm";
import {
  db,
  brokerCandlesTable,
  brokerCandleBackfillStatusTable,
  type NewBrokerCandle,
} from "@workspace/db";
import type { Candle } from "./types.js";
import { isValidCacheOhlc, upsertCandles, getCacheCoverage } from "./candleCache.js";
import { depthTargetDaysFor } from "./providerRoutingMap.js";

// The literal producer label for EA CopyRates pushes.
export const BROKER_CANDLE_SOURCE = "mt5_ea";
// The label under which mirrored bars land in the generic `market_candles`
// cache, so the existing router slot stays broker-native and provenance-coherent
// with the live MT5 feed.
export const MT5_BROKER_MIRROR_SOURCE = "mt5_broker";

// ── Canonical MT5 timeframe enum ──────────────────────────────────────────────
//
// The ONLY timeframes this store accepts. An unknown timeframe is rejected at
// ingest (never silently stored under a guessed bucket). This is the canonical
// 21-value MT5 set (M1…MN1); the store was previously pinned to six.
export const BROKER_TIMEFRAMES = [
  "M1", "M2", "M3", "M4", "M5", "M6", "M10", "M12", "M15", "M20", "M30",
  "H1", "H2", "H3", "H4", "H6", "H8", "H12",
  "D1", "W1", "MN1",
] as const;
export type BrokerTimeframe = (typeof BROKER_TIMEFRAMES)[number];

/**
 * Milliseconds per bar for each canonical timeframe.
 *
 * Intraday + D1 are fixed-width in UTC. W1 is exactly 7 days (MT5 weekly bars
 * open on the same weekday and advance by 7d). MN1 is a CALENDAR month and is
 * therefore NOT fixed-width — we use a 31-day UPPER BOUND so that the DERIVED
 * closed-bar fallback (`openMs + tfMs <= now`) never finalizes a monthly bar
 * EARLY: a shorter real month (28–30d) simply stays "forming" a few extra days,
 * which is the safe direction. The EA's explicit `isClosed` flag still wins when
 * sent. Exported so the market-data router reuses ONE source of truth (no drift).
 */
export const TIMEFRAME_MS: Record<BrokerTimeframe, number> = {
  M1: 60_000,
  M2: 2 * 60_000,
  M3: 3 * 60_000,
  M4: 4 * 60_000,
  M5: 5 * 60_000,
  M6: 6 * 60_000,
  M10: 10 * 60_000,
  M12: 12 * 60_000,
  M15: 15 * 60_000,
  M20: 20 * 60_000,
  M30: 30 * 60_000,
  H1: 60 * 60_000,
  H2: 2 * 60 * 60_000,
  H3: 3 * 60 * 60_000,
  H4: 4 * 60 * 60_000,
  H6: 6 * 60 * 60_000,
  H8: 8 * 60 * 60_000,
  H12: 12 * 60 * 60_000,
  D1: 24 * 60 * 60_000,
  W1: 7 * 24 * 60 * 60_000,
  MN1: 31 * 24 * 60 * 60_000,
};

// Accepted aliases → canonical timeframe. Anything not resolvable returns null
// (rejected at ingest). Keys are matched case-INSENSITIVELY (lowercased) EXCEPT
// the "1m" (one minute) vs "1M" (one month) pair, which collide once folded and
// are resolved case-sensitively in normalizeBrokerTimeframe BEFORE this lookup.
//
// Bare-number convention: NEW bare numbers use MINUTES (30→M30, 120→H2, 180→H3,
// 360→H6, 480→H8, 720→H12). The PRE-EXISTING bare aliases below are a historical
// mixed seconds/minutes set and are left untouched for backwards compatibility.
// An ambiguous bare value (e.g. "12") is intentionally NOT mapped → rejected.
const TIMEFRAME_ALIASES: Record<string, BrokerTimeframe> = {
  m1: "M1", "1m": "M1", "1": "M1", "60": "M1",
  m2: "M2", "2m": "M2",
  m3: "M3", "3m": "M3",
  m4: "M4", "4m": "M4",
  m5: "M5", "5m": "M5", "5": "M5", "300": "M5",
  m6: "M6", "6m": "M6",
  m10: "M10", "10m": "M10",
  m12: "M12", "12m": "M12",
  m15: "M15", "15m": "M15", "15": "M15", "900": "M15",
  m20: "M20", "20m": "M20",
  m30: "M30", "30m": "M30", "30": "M30",
  h1: "H1", "1h": "H1", "60m": "H1", "3600": "H1",
  h2: "H2", "2h": "H2", "120": "H2",
  h3: "H3", "3h": "H3", "180": "H3",
  h4: "H4", "4h": "H4", "240m": "H4", "240": "H4", "14400": "H4",
  h6: "H6", "6h": "H6", "360": "H6",
  h8: "H8", "8h": "H8", "480": "H8",
  h12: "H12", "12h": "H12", "720": "H12",
  d1: "D1", "1d": "D1", d: "D1", daily: "D1", "1day": "D1", "1440": "D1",
  w1: "W1", "1w": "W1", w: "W1", weekly: "W1", "1week": "W1",
  mn1: "MN1", mn: "MN1", monthly: "MN1", "1mo": "MN1", "1mn": "MN1", "1month": "MN1",
};

/** Normalize any EA timeframe token to a canonical BrokerTimeframe, or null. */
export function normalizeBrokerTimeframe(tf: string | null | undefined): BrokerTimeframe | null {
  const raw = (tf ?? "").trim();
  if (!raw) return null;
  // Case-SENSITIVE collision: MetaTrader writes "1m" for one MINUTE and "1M"
  // for one MONTH. The alias table is lowercase-keyed and would collapse the
  // pair, so resolve it explicitly BEFORE any case-folding.
  if (raw === "1m") return "M1";
  if (raw === "1M") return "MN1";
  const upper = raw.toUpperCase();
  if ((BROKER_TIMEFRAMES as readonly string[]).includes(upper)) {
    return upper as BrokerTimeframe;
  }
  return TIMEFRAME_ALIASES[raw.toLowerCase()] ?? null;
}

// ── Ingest contract ───────────────────────────────────────────────────────────

/** Maximum bars the EA may send in a single ingest batch. */
export const MAX_BARS_PER_INGEST_BATCH = 5000;

/**
 * Body-parser byte limit for `POST /api/mt5/candles/ingest` (Task #500).
 *
 * A full legitimate batch is up to MAX_BARS_PER_INGEST_BATCH bars at the
 * `barSchema` shape. The worst-case serialized bar (every optional field
 * present: openTime/time/closeTime + OHLC + tick/real/volume + spread + the two
 * closed flags) is ~290 bytes, so a 5000-bar batch tops out around ~1.5 MB.
 * 4 MiB gives a comfortable margin for envelope/overhead and future field
 * growth while staying bounded. This is sized deliberately to the worst
 * legitimate batch — NOT an arbitrary "bigger" number — and the regression test
 * (scripts/src/brokerCandleIngestTest.ts) fails if it ever drops below a
 * measured real 5000-bar batch.
 */
export const CANDLE_INGEST_BODY_LIMIT_BYTES = 4 * 1024 * 1024;

const barSchema = z.object({
  // The EA may send the bar OPEN time as `openTime` (preferred) or `time`
  // (legacy sync shape). Either is accepted; one MUST be present.
  openTime: z.union([z.string(), z.number()]).optional(),
  time: z.union([z.string(), z.number()]).optional(),
  closeTime: z.union([z.string(), z.number()]).optional(),
  open: z.number(),
  high: z.number(),
  low: z.number(),
  close: z.number(),
  tickVolume: z.number().optional(),
  realVolume: z.number().optional(),
  volume: z.number().optional(),
  spread: z.number().optional(),
  // Explicit closed-bar flag. When absent, finalization is DERIVED from the bar
  // age vs the timeframe interval (see resolveIsClosed).
  isClosed: z.boolean().optional(),
  isFinal: z.boolean().optional(),
});

export const BrokerCandleIngestSchema = z.object({
  symbol: z.string().min(1),
  brokerSymbol: z.string().min(1).optional(),
  timeframe: z.string().min(1),
  accountNumber: z.union([z.string(), z.number()]).optional(),
  terminalId: z.string().optional(),
  source: z.string().optional(),
  eaVersion: z.string().optional(),
  brokerServerTime: z.union([z.string(), z.number()]).optional(),
  /** EA signals the broker has no older bars beyond this window. */
  brokerLimited: z.boolean().optional(),
  /** Transport send time — used to refuse a stale/replayed push. */
  sentAt: z.union([z.string(), z.number()]).optional(),
  bars: z.array(barSchema).max(MAX_BARS_PER_INGEST_BATCH),
});

export type BrokerCandleIngest = z.infer<typeof BrokerCandleIngestSchema>;

export interface LatestStoredEntry {
  symbol: string;
  brokerSymbol: string;
  timeframe: BrokerTimeframe;
  latestOpenTimeUtc: string | null;
  barsStored: number;
}

export type BackfillStatusValue =
  | "NOT_STARTED"
  | "BUILDING"
  | "PARTIAL"
  | "COMPLETE"
  | "BROKER_LIMITED"
  | "ERROR";

export interface NextBackfillHint {
  symbol: string;
  brokerSymbol: string;
  timeframe: BrokerTimeframe;
  status: BackfillStatusValue;
  oldestStoredAt: string | null;
  /** UTC time the next CopyRates page should END at (one interval before oldest). */
  suggestedEndTimeUtc: string | null;
  reason: string;
}

export interface BrokerCandleIngestResult {
  ok: boolean;
  acceptedBars: number;
  rejectedBars: number;
  /** Honest top-level note when the whole request was refused (and why). */
  note?: string;
  latestStoredBySymbolTimeframe: LatestStoredEntry[];
  nextBackfillHints: NextBackfillHint[];
}

// Stale-push thresholds — same posture as the live-tail / history sync paths. A
// backfill legitimately contains OLD bars, so freshness is judged by the
// TRANSPORT timestamp (`sentAt`), never per-bar age.
const STALE_PUSH_MAX_PAST_MS = 5 * 60_000;
const STALE_PUSH_MAX_FUTURE_MS = 2 * 60_000;

// A series whose newest bar finalized within this long counts as actively
// BUILDING; older than this with the target unmet reads PARTIAL (paused).
const BUILDING_FRESH_MS = 10 * 60_000;

const MS_PER_DAY = 24 * 60 * 60_000;

// ── Pure backfill state-machine evaluator ─────────────────────────────────────

export interface ComputeBackfillInput {
  barsStored: number;
  oldestStoredAt: Date | null;
  newestStoredAt: Date | null;
  targetDays: number;
  lastIngestAt: Date | null;
  hadError?: boolean;
  brokerLimited?: boolean;
  now?: number;
}

export interface ComputeBackfillOutput {
  status: BackfillStatusValue;
  reason: string;
  coverageDays: number | null;
}

/**
 * Pure function: derive the backfill status from stored coverage + signals.
 * Precedence: ERROR > NOT_STARTED > COMPLETE > BROKER_LIMITED > BUILDING >
 * PARTIAL. Deterministic and side-effect free for direct unit testing.
 */
export function computeBackfillStatus(input: ComputeBackfillInput): ComputeBackfillOutput {
  const now = input.now ?? Date.now();
  if (input.hadError) {
    return { status: "ERROR", reason: "ingest_error_recorded", coverageDays: null };
  }
  if (input.barsStored <= 0) {
    return { status: "NOT_STARTED", reason: "no_bars_stored", coverageDays: 0 };
  }
  const coverageDays =
    input.oldestStoredAt && input.newestStoredAt
      ? Math.max(0, (input.newestStoredAt.getTime() - input.oldestStoredAt.getTime()) / MS_PER_DAY)
      : 0;
  if (coverageDays >= input.targetDays) {
    return { status: "COMPLETE", reason: "depth_target_met", coverageDays };
  }
  if (input.brokerLimited) {
    return { status: "BROKER_LIMITED", reason: "broker_has_no_older_bars", coverageDays };
  }
  const ingestFresh =
    input.lastIngestAt != null && now - input.lastIngestAt.getTime() <= BUILDING_FRESH_MS;
  if (ingestFresh) {
    return { status: "BUILDING", reason: "actively_streaming", coverageDays };
  }
  return { status: "PARTIAL", reason: "streaming_paused_target_unmet", coverageDays };
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function parseTime(v: string | number | null | undefined): Date | null {
  if (v == null) return null;
  const d = new Date(v);
  return Number.isNaN(d.getTime()) ? null : d;
}

/**
 * Decide whether a bar is a finalized (closed) bar. An explicit EA flag wins;
 * otherwise a bar is closed once its CLOSE instant (open + one interval) is at
 * or before now. The single newest still-open bucket reads as forming.
 */
function resolveIsClosed(
  openMs: number,
  tfMs: number,
  explicit: boolean | undefined,
  now: number,
): boolean {
  if (explicit != null) return explicit;
  return openMs + tfMs <= now;
}

interface NormalizedBar {
  openTime: Date;
  closeTime: Date;
  open: number;
  high: number;
  low: number;
  close: number;
  tickVolume: number | null;
  realVolume: number | null;
  spread: number | null;
  isClosedBar: boolean;
}

/** OHLC near-equality for idempotent re-send detection (float tolerance). */
function ohlcEqual(a: { open: number; high: number; low: number; close: number },
  b: { open: number; high: number; low: number; close: number }): boolean {
  const eq = (x: number, y: number) => Math.abs(x - y) <= Math.max(1e-9, Math.abs(x) * 1e-9);
  return eq(a.open, b.open) && eq(a.high, b.high) && eq(a.low, b.low) && eq(a.close, b.close);
}

// ── Ingest ────────────────────────────────────────────────────────────────────

export interface IngestContext {
  userId: number;
  bridgeConnectionId: number;
  /** Account number from the bridge row (provenance fallback). */
  accountNumber?: string | null;
}

/**
 * Validate and ingest a batch of broker candles into the durable broker store,
 * apply the closed-bar finalization rule per bar, maintain the per-series
 * backfill status, and mirror accepted CLOSED bars into the read-path cache +
 * in-memory provider. Returns an honest summary; never throws on a malformed
 * bar (those are counted as rejected).
 *
 * `now` is injectable for deterministic testing of the stale-push + closed-bar
 * derivation.
 */
export async function ingestBrokerCandles(
  payload: BrokerCandleIngest,
  ctx: IngestContext,
  opts?: { now?: number },
): Promise<BrokerCandleIngestResult> {
  const now = opts?.now ?? Date.now();
  const symbol = payload.symbol.trim().toUpperCase();
  const brokerSymbol = (payload.brokerSymbol ?? payload.symbol).trim();
  const accountNumber =
    payload.accountNumber != null ? String(payload.accountNumber) : ctx.accountNumber ?? null;
  const source = payload.source?.trim() || BROKER_CANDLE_SOURCE;
  const terminalId = payload.terminalId ?? null;
  const brokerServerTime = parseTime(payload.brokerServerTime ?? null);

  const empty: BrokerCandleIngestResult = {
    ok: true,
    acceptedBars: 0,
    rejectedBars: payload.bars.length,
    latestStoredBySymbolTimeframe: [],
    nextBackfillHints: [],
  };

  // ── Pinned timeframe enum — reject unknown at ingest ─────────────────────────
  const timeframe = normalizeBrokerTimeframe(payload.timeframe);
  if (!timeframe) {
    return { ...empty, note: "unsupported_timeframe" };
  }
  const tfMs = TIMEFRAME_MS[timeframe];

  // ── Stale/replayed transport guard (fail-closed on unparsable timestamp) ─────
  if (payload.sentAt != null) {
    const sentMs = new Date(payload.sentAt).getTime();
    if (Number.isNaN(sentMs)) return { ...empty, note: "invalid_push_timestamp" };
    const skew = now - sentMs;
    if (skew > STALE_PUSH_MAX_PAST_MS || skew < -STALE_PUSH_MAX_FUTURE_MS) {
      return { ...empty, note: "stale_push_timestamp" };
    }
  }

  // ── Normalize → validate → dedupe by open time (last write wins) ─────────────
  const byTime = new Map<string, NormalizedBar>();
  let rejected = 0;
  for (const b of payload.bars) {
    if (!isValidCacheOhlc(b)) {
      rejected += 1;
      continue;
    }
    const openTime = parseTime(b.openTime ?? b.time);
    if (!openTime) {
      rejected += 1;
      continue;
    }
    const openMs = openTime.getTime();
    const closeTime = parseTime(b.closeTime ?? null) ?? new Date(openMs + tfMs);
    const isClosedBar = resolveIsClosed(openMs, tfMs, b.isClosed ?? b.isFinal, now);
    byTime.set(openTime.toISOString(), {
      openTime,
      closeTime,
      open: b.open,
      high: b.high,
      low: b.low,
      close: b.close,
      tickVolume: b.tickVolume ?? b.volume ?? null,
      realVolume: b.realVolume ?? null,
      spread: b.spread ?? null,
      isClosedBar,
    });
  }

  if (byTime.size === 0) {
    // Nothing storable — never clear an existing good series.
    return { ...empty, rejectedBars: rejected, note: "no_valid_bars" };
  }

  const incoming = [...byTime.values()].sort(
    (a, b) => a.openTime.getTime() - b.openTime.getTime(),
  );

  // ── Closed-bar finalization rule (per bar, against the existing stored row) ──
  let accepted = 0;
  const mirrorClosed: Candle[] = [];
  for (const bar of incoming) {
    const existing = await db
      .select()
      .from(brokerCandlesTable)
      .where(
        and(
          eq(brokerCandlesTable.bridgeConnectionId, ctx.bridgeConnectionId),
          eq(brokerCandlesTable.brokerSymbol, brokerSymbol),
          eq(brokerCandlesTable.timeframe, timeframe),
          eq(brokerCandlesTable.openTimeUtc, bar.openTime),
        ),
      )
      .limit(1);
    const prev = existing[0];

    let qualityStatus: string;
    let qualityReason: string | null;

    if (!prev) {
      qualityStatus = "accepted";
      qualityReason = bar.isClosedBar ? "new_closed" : "new_forming";
    } else if (!prev.isClosedBar && !bar.isClosedBar) {
      qualityStatus = "accepted";
      qualityReason = "forming_update";
    } else if (!prev.isClosedBar && bar.isClosedBar) {
      qualityStatus = "finalized";
      qualityReason = "finalized";
    } else if (prev.isClosedBar && bar.isClosedBar) {
      if (ohlcEqual(prev, bar)) {
        qualityStatus = "idempotent";
        qualityReason = "idempotent";
      } else {
        // A finalized bar's OHLC is immutable — refuse a conflicting close.
        rejected += 1;
        continue;
      }
    } else {
      // prev closed, incoming forming → a regression; refuse.
      rejected += 1;
      continue;
    }

    const row: NewBrokerCandle = {
      userId: ctx.userId,
      bridgeConnectionId: ctx.bridgeConnectionId,
      accountNumber,
      brokerSymbol,
      symbol,
      timeframe,
      openTimeUtc: bar.openTime,
      closeTimeUtc: bar.closeTime,
      open: bar.open,
      high: bar.high,
      low: bar.low,
      close: bar.close,
      tickVolume: bar.tickVolume,
      realVolume: bar.realVolume,
      spread: bar.spread,
      source,
      terminalId,
      isClosedBar: bar.isClosedBar,
      brokerServerTime: brokerServerTime ?? undefined,
      qualityStatus,
      qualityReason,
      updatedAt: new Date(),
    };

    await db
      .insert(brokerCandlesTable)
      .values(row)
      .onConflictDoUpdate({
        target: [
          brokerCandlesTable.bridgeConnectionId,
          brokerCandlesTable.brokerSymbol,
          brokerCandlesTable.timeframe,
          brokerCandlesTable.openTimeUtc,
        ],
        set: {
          open: row.open,
          high: row.high,
          low: row.low,
          close: row.close,
          closeTimeUtc: row.closeTimeUtc,
          tickVolume: row.tickVolume,
          realVolume: row.realVolume,
          spread: row.spread,
          isClosedBar: row.isClosedBar,
          brokerServerTime: row.brokerServerTime,
          qualityStatus: row.qualityStatus,
          qualityReason: row.qualityReason,
          updatedAt: new Date(),
        },
      });
    accepted += 1;

    // Only finalized bars are eligible to feed the live read path — a forming
    // bar must never masquerade as a final bar downstream.
    if (bar.isClosedBar) {
      mirrorClosed.push({
        time: bar.openTime.toISOString(),
        open: bar.open,
        high: bar.high,
        low: bar.low,
        close: bar.close,
        ...(bar.tickVolume != null ? { volume: bar.tickVolume } : {}),
      });
    }
  }

  // ── Mirror accepted CLOSED bars into the read path (cache + provider) ─────────
  // This is the existing foundation, NOT a source-priority change: the
  // "mt5_broker" cache slot and the in-memory provider series already exist and
  // are read by the chart/scanner router.
  if (mirrorClosed.length > 0) {
    await upsertCandles(symbol, timeframe, MT5_BROKER_MIRROR_SOURCE, mirrorClosed);
    const { mergeCandleFromMT5 } = await import("./providers/mt5Provider.js");
    for (const c of mirrorClosed) mergeCandleFromMT5(symbol, c, timeframe);
  }

  // ── Maintain the per-series backfill status from the full stored extent ───────
  const extent = await db
    .select({
      openTimeUtc: brokerCandlesTable.openTimeUtc,
    })
    .from(brokerCandlesTable)
    .where(
      and(
        eq(brokerCandlesTable.bridgeConnectionId, ctx.bridgeConnectionId),
        eq(brokerCandlesTable.brokerSymbol, brokerSymbol),
        eq(brokerCandlesTable.timeframe, timeframe),
      ),
    );
  const barsStored = extent.length;
  let oldest: Date | null = null;
  let newest: Date | null = null;
  for (const r of extent) {
    const t = r.openTimeUtc instanceof Date ? r.openTimeUtc : new Date(r.openTimeUtc);
    if (!oldest || t < oldest) oldest = t;
    if (!newest || t > newest) newest = t;
  }
  const targetDays = depthTargetDaysFor(timeframe);
  const computed = computeBackfillStatus({
    barsStored,
    oldestStoredAt: oldest,
    newestStoredAt: newest,
    targetDays,
    lastIngestAt: new Date(now),
    brokerLimited: payload.brokerLimited === true,
    now,
  });

  await db
    .insert(brokerCandleBackfillStatusTable)
    .values({
      userId: ctx.userId,
      bridgeConnectionId: ctx.bridgeConnectionId,
      brokerSymbol,
      symbol,
      timeframe,
      status: computed.status,
      statusReason: computed.reason,
      oldestStoredAt: oldest,
      newestStoredAt: newest,
      barsStored,
      targetDays,
      coverageDays: computed.coverageDays,
      lastIngestAt: new Date(now),
      updatedAt: new Date(),
    })
    .onConflictDoUpdate({
      target: [
        brokerCandleBackfillStatusTable.bridgeConnectionId,
        brokerCandleBackfillStatusTable.brokerSymbol,
        brokerCandleBackfillStatusTable.timeframe,
      ],
      set: {
        symbol,
        status: computed.status,
        statusReason: computed.reason,
        oldestStoredAt: oldest,
        newestStoredAt: newest,
        barsStored,
        targetDays,
        coverageDays: computed.coverageDays,
        lastIngestAt: new Date(now),
        updatedAt: new Date(),
      },
    });

  const latestStored: LatestStoredEntry = {
    symbol,
    brokerSymbol,
    timeframe,
    latestOpenTimeUtc: newest ? newest.toISOString() : null,
    barsStored,
  };

  // ── Next-backfill hint: page OLDER only while the series can still grow ───────
  const needsOlder = computed.status !== "COMPLETE" && computed.status !== "BROKER_LIMITED";
  const hint: NextBackfillHint = {
    symbol,
    brokerSymbol,
    timeframe,
    status: computed.status,
    oldestStoredAt: oldest ? oldest.toISOString() : null,
    suggestedEndTimeUtc:
      needsOlder && oldest ? new Date(oldest.getTime() - tfMs).toISOString() : null,
    reason: needsOlder
      ? "fetch_older_history_ending_before_oldest"
      : computed.status === "BROKER_LIMITED"
        ? "broker_has_no_older_bars"
        : "depth_target_met",
  };

  return {
    ok: true,
    acceptedBars: accepted,
    rejectedBars: rejected,
    latestStoredBySymbolTimeframe: [latestStored],
    nextBackfillHints: [hint],
  };
}

// ── Coverage diagnostics (Task #470) ─────────────────────────────────────────
//
// Read-only aggregate for the admin Market Data diagnostics page: per-series
// backfill status (from the state-machine table) joined with the bars actually
// mirrored into the generic cache slot the router reads. MARKET-DATA / TELEMETRY
// ONLY — never touches execution, the 16-gate pipeline, `arx_live_*`, balances,
// or fills. Never fabricates: it reports exactly what is stored.

export interface BrokerCandleCoverageRow {
  userId: number;
  bridgeConnectionId: number;
  brokerSymbol: string;
  symbol: string;
  timeframe: string;
  status: BackfillStatusValue;
  statusReason: string | null;
  oldestStoredAt: string | null;
  newestStoredAt: string | null;
  barsStored: number;
  targetDays: number | null;
  coverageDays: number | null;
  retryCount: number;
  lastError: string | null;
  lastIngestAt: string | null;
  updatedAt: string | null;
  /** Bars actually present in the router-read mirror slot for this series. */
  mirroredCacheBars: number;
  /** Newest mirrored bar time (what the router would serve as "live"). */
  mirroredNewestAt: string | null;
  /** Most recent write into the mirror slot (cache freshness). */
  mirroredLastWriteAt: string | null;
}

export interface BrokerCandleCoverageSummary {
  rows: BrokerCandleCoverageRow[];
  statusCounts: Record<BackfillStatusValue, number>;
  totalSeries: number;
  totalBarsStored: number;
  totalMirroredCacheBars: number;
}

const ALL_BACKFILL_STATUSES: BackfillStatusValue[] = [
  "NOT_STARTED",
  "BUILDING",
  "PARTIAL",
  "COMPLETE",
  "BROKER_LIMITED",
  "ERROR",
];

function toIso(d: Date | null | undefined): string | null {
  return d ? new Date(d).toISOString() : null;
}

/**
 * Per-series broker-candle coverage + backfill status, newest activity first.
 * Optionally filtered to one symbol. `limit` bounds the row count (default 200).
 */
export async function getBrokerCandleCoverage(opts?: {
  symbol?: string;
  limit?: number;
}): Promise<BrokerCandleCoverageSummary> {
  const limit = Math.min(Math.max(opts?.limit ?? 200, 1), 1000);
  const symFilter = opts?.symbol?.trim().toUpperCase();

  const where = symFilter
    ? eq(brokerCandleBackfillStatusTable.symbol, symFilter)
    : undefined;

  const baseRows = await db
    .select()
    .from(brokerCandleBackfillStatusTable)
    .where(where)
    .orderBy(desc(brokerCandleBackfillStatusTable.updatedAt))
    .limit(limit);

  const statusCounts: Record<BackfillStatusValue, number> = {
    NOT_STARTED: 0,
    BUILDING: 0,
    PARTIAL: 0,
    COMPLETE: 0,
    BROKER_LIMITED: 0,
    ERROR: 0,
  };
  let totalBarsStored = 0;
  let totalMirroredCacheBars = 0;

  const rows: BrokerCandleCoverageRow[] = [];
  for (const r of baseRows) {
    const status = (ALL_BACKFILL_STATUSES as string[]).includes(r.status)
      ? (r.status as BackfillStatusValue)
      : "NOT_STARTED";
    statusCounts[status] += 1;
    totalBarsStored += r.barsStored ?? 0;

    let mirrored: { count: number; newest: string | null; lastWriteAt: string | null } = {
      count: 0,
      newest: null,
      lastWriteAt: null,
    };
    try {
      const cov = await getCacheCoverage(r.symbol, r.timeframe, MT5_BROKER_MIRROR_SOURCE);
      mirrored = { count: cov.count, newest: cov.newest, lastWriteAt: cov.lastWriteAt };
    } catch {
      // Coverage probe failure is non-fatal — report zero mirror bars honestly.
    }
    totalMirroredCacheBars += mirrored.count;

    rows.push({
      userId: r.userId,
      bridgeConnectionId: r.bridgeConnectionId,
      brokerSymbol: r.brokerSymbol,
      symbol: r.symbol,
      timeframe: r.timeframe,
      status,
      statusReason: r.statusReason ?? null,
      oldestStoredAt: toIso(r.oldestStoredAt),
      newestStoredAt: toIso(r.newestStoredAt),
      barsStored: r.barsStored ?? 0,
      targetDays: r.targetDays ?? null,
      coverageDays: r.coverageDays ?? null,
      retryCount: r.retryCount ?? 0,
      lastError: r.lastError ?? null,
      lastIngestAt: toIso(r.lastIngestAt),
      updatedAt: toIso(r.updatedAt),
      mirroredCacheBars: mirrored.count,
      mirroredNewestAt: mirrored.newest,
      mirroredLastWriteAt: mirrored.lastWriteAt,
    });
  }

  return {
    rows,
    statusCounts,
    totalSeries: rows.length,
    totalBarsStored,
    totalMirroredCacheBars,
  };
}
