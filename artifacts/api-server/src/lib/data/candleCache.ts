// ── Persisted candle cache (Task #432) ───────────────────────────────────────
//
// DB-backed read/write layer over the `market_candles` table. Gives every
// symbol/timeframe deep, scrollable history that ACCUMULATES across requests
// instead of resetting to a shallow in-memory window.
//
// Honesty / safety scope (must hold):
//   - MARKET-DATA / TELEMETRY ONLY. Never touches execution, the 16-gate live
//     pipeline, `arx_live_*` tables, balances, or fills.
//   - Never fabricates bars. It only stores what a real provider returned and
//     reads back exactly what was stored.
//   - Dedupe + upsert by (symbol, timeframe, source, barTime): re-fetching a
//     window updates OHLCV in place; it never inserts duplicates.
//   - One coherent SOURCE per read. A read is always scoped to a single source
//     so synthetic-scaled and broker-native bars are never mixed in one series.
//
// The canonical wire shape is the existing `Candle` ({ time: ISO, o,h,l,c,v? }).
// On disk we store barTime as a timezone-aware timestamp; adapters convert.

import { and, asc, desc, eq, lt, sql } from "drizzle-orm";
import { db, marketCandlesTable } from "@workspace/db";
import type { Candle } from "./types.js";

/** A bar is valid only when OHLC are finite, strictly positive, and consistent
 *  (high >= max(o,c), low <= min(o,c), high >= low). Mirrors the EA-ingest guard
 *  so a malformed/garbage bar can never be persisted into the cache. */
export function isValidCacheOhlc(c: {
  open: number;
  high: number;
  low: number;
  close: number;
}): boolean {
  const { open, high, low, close } = c;
  if (![open, high, low, close].every((n) => Number.isFinite(n))) return false;
  if (open <= 0 || high <= 0 || low <= 0 || close <= 0) return false;
  if (high < low) return false;
  if (high < Math.max(open, close)) return false;
  if (low > Math.min(open, close)) return false;
  return true;
}

function toBarTime(iso: string): Date | null {
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? null : d;
}

function rowToCandle(r: {
  barTime: Date;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number | null;
}): Candle {
  return {
    time: r.barTime.toISOString(),
    open: r.open,
    high: r.high,
    low: r.low,
    close: r.close,
    ...(r.volume != null ? { volume: r.volume } : {}),
  };
}

export interface CacheCoverage {
  source: string;
  count: number;
  oldest: string | null;
  newest: string | null;
  /** Most recent write time across the series (cache freshness signal). */
  lastWriteAt: string | null;
}

export interface ReadCachedResult {
  candles: Candle[]; // ascending by time
  count: number;
  oldest: string | null;
  newest: string | null;
  /** Whether older bars exist in the cache beyond what this page returned. */
  hasOlderInCache: boolean;
}

/**
 * Upsert a window of candles for one (symbol, timeframe, source). Deduplicates
 * by barTime within the batch (last write wins) and ON CONFLICT updates OHLCV in
 * place so a re-fetched window never creates duplicate rows. Invalid bars are
 * dropped (never stored). Returns the number of bars written.
 */
export async function upsertCandles(
  symbol: string,
  timeframe: string,
  source: string,
  candles: Candle[],
): Promise<{ written: number; rejected: number }> {
  const sym = symbol.trim().toUpperCase();
  const byTime = new Map<string, (typeof marketCandlesTable.$inferInsert)>();
  let rejected = 0;
  for (const c of candles) {
    if (!isValidCacheOhlc(c)) {
      rejected += 1;
      continue;
    }
    const barTime = toBarTime(c.time);
    if (!barTime) {
      rejected += 1;
      continue;
    }
    const key = barTime.toISOString();
    byTime.set(key, {
      symbol: sym,
      timeframe,
      source,
      barTime,
      open: c.open,
      high: c.high,
      low: c.low,
      close: c.close,
      volume: c.volume ?? null,
      updatedAt: new Date(),
    });
  }
  const rows = [...byTime.values()];
  if (rows.length === 0) return { written: 0, rejected };

  // Chunk to keep the parameter count well under Postgres' 65535 bind limit
  // (10 columns/row → ~6500 rows max; 1000 is comfortably safe).
  const CHUNK = 1000;
  for (let i = 0; i < rows.length; i += CHUNK) {
    const slice = rows.slice(i, i + CHUNK);
    await db
      .insert(marketCandlesTable)
      .values(slice)
      .onConflictDoUpdate({
        target: [
          marketCandlesTable.symbol,
          marketCandlesTable.timeframe,
          marketCandlesTable.source,
          marketCandlesTable.barTime,
        ],
        set: {
          open: sql`excluded.open`,
          high: sql`excluded.high`,
          low: sql`excluded.low`,
          close: sql`excluded.close`,
          volume: sql`excluded.volume`,
          updatedAt: sql`now()`,
        },
      });
  }
  return { written: rows.length, rejected };
}

/**
 * Read cached candles for one (symbol, timeframe, source), oldest-first
 * (ascending), optionally only those strictly OLDER than `before`. Returns up to
 * `limit` bars plus oldest/newest and whether still-older bars exist in cache.
 *
 * The `before` cursor selects bars with barTime < before, then we take the
 * NEWEST `limit` of those (so paging back keeps contiguous windows) and return
 * them ascending.
 */
export async function readCachedCandles(args: {
  symbol: string;
  timeframe: string;
  source: string;
  before?: string | null;
  limit: number;
}): Promise<ReadCachedResult> {
  const sym = args.symbol.trim().toUpperCase();
  const limit = Math.max(1, Math.min(5000, args.limit));
  const conds = [
    eq(marketCandlesTable.symbol, sym),
    eq(marketCandlesTable.timeframe, args.timeframe),
    eq(marketCandlesTable.source, args.source),
  ];
  if (args.before) {
    const beforeDate = toBarTime(args.before);
    if (beforeDate) conds.push(lt(marketCandlesTable.barTime, beforeDate));
  }
  // Pull the newest `limit` rows that satisfy the cursor (descending), then
  // reverse to ascending. Fetch one extra to detect older-than-page bars.
  const rows = await db
    .select()
    .from(marketCandlesTable)
    .where(and(...conds))
    .orderBy(desc(marketCandlesTable.barTime))
    .limit(limit + 1);

  const hasOlderInCache = rows.length > limit;
  const page = (hasOlderInCache ? rows.slice(0, limit) : rows)
    .map(rowToCandle)
    .sort((a, b) => a.time.localeCompare(b.time));

  return {
    candles: page,
    count: page.length,
    oldest: page.length > 0 ? page[0]!.time : null,
    newest: page.length > 0 ? page[page.length - 1]!.time : null,
    hasOlderInCache,
  };
}

/**
 * Coverage summary for one (symbol, timeframe, source): total bar count, oldest
 * and newest bar time, and the most recent write time (cache freshness). Used by
 * the history service to decide whether deep-fetch is needed and to stamp honest
 * depth metadata. Read-only aggregate — never mutates.
 */
export async function getCacheCoverage(
  symbol: string,
  timeframe: string,
  source: string,
): Promise<CacheCoverage> {
  const sym = symbol.trim().toUpperCase();
  const rows = await db
    .select({
      count: sql<number>`cast(count(*) as int)`,
      oldest: sql<Date | null>`min(${marketCandlesTable.barTime})`,
      newest: sql<Date | null>`max(${marketCandlesTable.barTime})`,
      lastWrite: sql<Date | null>`max(${marketCandlesTable.updatedAt})`,
    })
    .from(marketCandlesTable)
    .where(
      and(
        eq(marketCandlesTable.symbol, sym),
        eq(marketCandlesTable.timeframe, timeframe),
        eq(marketCandlesTable.source, source),
      ),
    );
  const r = rows[0];
  const toIso = (d: Date | null | undefined): string | null =>
    d ? new Date(d).toISOString() : null;
  return {
    source,
    count: r?.count ?? 0,
    oldest: toIso(r?.oldest),
    newest: toIso(r?.newest),
    lastWriteAt: toIso(r?.lastWrite),
  };
}

/**
 * Which sources have cached bars for (symbol, timeframe), deepest coverage
 * first. Lets a paginated read that did not specify a source pick the same
 * coherent series the initial page used. Read-only.
 */
export async function listCachedSources(
  symbol: string,
  timeframe: string,
): Promise<Array<{ source: string; count: number; oldest: string | null; newest: string | null }>> {
  const sym = symbol.trim().toUpperCase();
  const rows = await db
    .select({
      source: marketCandlesTable.source,
      count: sql<number>`cast(count(*) as int)`,
      oldest: sql<Date | null>`min(${marketCandlesTable.barTime})`,
      newest: sql<Date | null>`max(${marketCandlesTable.barTime})`,
    })
    .from(marketCandlesTable)
    .where(
      and(
        eq(marketCandlesTable.symbol, sym),
        eq(marketCandlesTable.timeframe, timeframe),
      ),
    )
    .groupBy(marketCandlesTable.source)
    .orderBy(desc(sql`count(*)`));
  return rows.map((r) => ({
    source: r.source,
    count: r.count,
    oldest: r.oldest ? new Date(r.oldest).toISOString() : null,
    newest: r.newest ? new Date(r.newest).toISOString() : null,
  }));
}

/** Test/diagnostic helper — delete all cached rows for one symbol (any tf/source).
 *  Used by the cache unit test to clean up its synthetic symbol fail-closed. */
export async function __deleteCachedSymbol(symbol: string): Promise<number> {
  const sym = symbol.trim().toUpperCase();
  const res = await db
    .delete(marketCandlesTable)
    .where(eq(marketCandlesTable.symbol, sym))
    .returning({ id: marketCandlesTable.id });
  return res.length;
}

/** Ascending-order read helper used by tests/diagnostics for a full series dump
 *  (no cursor). Capped. */
export async function readAllCached(
  symbol: string,
  timeframe: string,
  source: string,
  limit = 5000,
): Promise<Candle[]> {
  const sym = symbol.trim().toUpperCase();
  const rows = await db
    .select()
    .from(marketCandlesTable)
    .where(
      and(
        eq(marketCandlesTable.symbol, sym),
        eq(marketCandlesTable.timeframe, timeframe),
        eq(marketCandlesTable.source, source),
      ),
    )
    .orderBy(asc(marketCandlesTable.barTime))
    .limit(limit);
  return rows.map(rowToCandle);
}
