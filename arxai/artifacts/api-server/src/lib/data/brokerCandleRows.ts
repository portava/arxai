// The one read/write layer over the compact broker candle tables
// (broker_candle_series / broker_candle_attrs / broker_candle_bars).
//
// Callers see the same full row the old wide `broker_candles` table held
// (`BrokerCandleRow`). Storage is lossless: values constant for a native
// series are stored once, per-bar text with few distinct values goes through
// a small attribute table, and a time that can be computed from the bar is
// stored NULL with its bit set in `derived`.
//
// Reads are series-first: resolve the native series (a tiny table), then range
// scan one series' bars on the primary key (series_id, open_time_utc). A
// generic join view cannot use that order across series, so it is not offered.

import { and, asc, desc, eq, gte, inArray, lt, lte, sql, type SQL } from "drizzle-orm";
import {
  db,
  brokerCandleSeriesTable,
  brokerCandleAttrsTable,
  brokerCandleBarsTable,
  BAR_DERIVED,
  type BrokerCandle,
  type NewBrokerCandle,
  type BrokerCandleSeries,
  type BrokerCandleAttrs,
  type BrokerCandleBar,
} from "@workspace/db";

/** A full stored candle, as the old wide table held it. `id` is the original
 * broker_candles id for copied rows and null for bars written since. */
export type BrokerCandleRow = Omit<BrokerCandle, "id"> & { id: number | null };

type Db = typeof db;
type Tx = Parameters<Parameters<Db["transaction"]>[0]>[0];
export type Queryable = Db | Tx;

/** Fixed bar lengths. MN1 (calendar month) is absent: never derived. The copy
 * script builds its SQL from this table. */
export const FIXED_TIMEFRAME_SECONDS: Readonly<Record<string, number>> = {
  M1: 60, M2: 120, M3: 180, M4: 240, M5: 300, M6: 360, M10: 600, M12: 720, M15: 900, M20: 1200, M30: 1800,
  H1: 3600, H2: 7200, H3: 10800, H4: 14400, H6: 21600, H8: 28800, H12: 43200, D1: 86400, W1: 604800,
};

const sameTime = (a: Date | null | undefined, b: Date | null | undefined): boolean =>
  a instanceof Date && b instanceof Date && a.getTime() === b.getTime();

// ── Series ──────────────────────────────────────────────────────────────────

export interface SeriesKey {
  bridgeConnectionId: number; historyIdentity: string; brokerSymbol: string; timeframe: string;
}
export interface SeriesAttrs {
  userId: number; symbol: string; accountNumber: string | null; serverName: string | null; clockBasis: string | null;
}

export class SeriesAttributeConflict extends Error {
  constructor(readonly field: keyof SeriesAttrs) { super("BROKER_SERIES_ATTRIBUTE_CONFLICT"); }
}

const SERIES_ATTR_FIELDS = ["userId", "symbol", "accountNumber", "serverName", "clockBasis"] as const;

/** The text PostgreSQL gives `jsonb_build_array(...)::text` for these values
 * (elements separated by ", "), so the copy script can build the same keys in
 * SQL. A test pins the two equal on awkward strings. */
export const jsonbArrayText = (values: (string | number | null)[]): string =>
  `[${values.map((v) => JSON.stringify(v)).join(", ")}]`;

/** Key of the nine values that define a stored series. */
export const seriesKeyOf = (k: SeriesKey, a: SeriesAttrs): string => jsonbArrayText([
  k.bridgeConnectionId, k.historyIdentity, k.brokerSymbol, k.timeframe,
  a.userId, a.symbol, a.accountNumber ?? null, a.serverName ?? null, a.clockBasis ?? null,
]);

async function seriesByKey(q: Queryable, key: string): Promise<BrokerCandleSeries | null> {
  const [row] = await q.select().from(brokerCandleSeriesTable).where(eq(brokerCandleSeriesTable.seriesKey, key)).limit(1);
  return row ?? null;
}

/** All stored series of one native key (normally one; legacy rows may vary). */
export async function getNativeSeries(q: Queryable, key: SeriesKey): Promise<BrokerCandleSeries[]> {
  return findSeries(q, { bridgeConnectionIds: [key.bridgeConnectionId], historyIdentity: key.historyIdentity,
    brokerSymbol: key.brokerSymbol, timeframe: key.timeframe });
}

/** The exact series for these nine values, created on first use. With
 * `strict` (live writes) a native key already stored with other constant
 * values is refused: a series is never silently relabelled or split. */
export async function ensureSeries(q: Queryable, key: SeriesKey, attrs: SeriesAttrs, opts: { strict?: boolean } = {}): Promise<BrokerCandleSeries> {
  const exact = seriesKeyOf(key, attrs);
  if (opts.strict) {
    for (const other of await getNativeSeries(q, key)) {
      if (other.seriesKey === exact) continue;
      const field = SERIES_ATTR_FIELDS.find((f) => (other[f] ?? null) !== (attrs[f] ?? null));
      if (field) throw new SeriesAttributeConflict(field);
    }
  }
  let row = await seriesByKey(q, exact);
  if (!row) {
    await q.insert(brokerCandleSeriesTable).values({ seriesKey: exact, ...key, ...attrs }).onConflictDoNothing();
    row = await seriesByKey(q, exact);
    if (!row) throw new Error("BROKER_SERIES_NOT_CREATED");
  }
  return row;
}

export interface SeriesFilter {
  userId?: number;
  bridgeConnectionIds?: number[];
  historyIdentity?: string;
  brokerSymbol?: string;
  symbol?: string;
  timeframe?: string;
}

export async function findSeries(q: Queryable, f: SeriesFilter): Promise<BrokerCandleSeries[]> {
  const conds: SQL[] = [];
  if (f.userId != null) conds.push(eq(brokerCandleSeriesTable.userId, f.userId));
  if (f.bridgeConnectionIds) {
    if (f.bridgeConnectionIds.length === 0) return [];
    conds.push(inArray(brokerCandleSeriesTable.bridgeConnectionId, f.bridgeConnectionIds));
  }
  if (f.historyIdentity != null) conds.push(eq(brokerCandleSeriesTable.historyIdentity, f.historyIdentity));
  if (f.brokerSymbol != null) conds.push(eq(brokerCandleSeriesTable.brokerSymbol, f.brokerSymbol));
  if (f.symbol != null) conds.push(eq(brokerCandleSeriesTable.symbol, f.symbol));
  if (f.timeframe != null) conds.push(eq(brokerCandleSeriesTable.timeframe, f.timeframe));
  return q.select().from(brokerCandleSeriesTable).where(conds.length ? and(...conds) : undefined)
    .orderBy(asc(brokerCandleSeriesTable.id));
}

// ── Per-bar attributes ──────────────────────────────────────────────────────

export interface BarAttrs {
  source: string; terminalId: string | null; priceBasis: string | null;
  qualityStatus: string; qualityReason: string | null;
}

export const attrsKeyOf = (a: BarAttrs): string =>
  jsonbArrayText([a.source, a.terminalId ?? null, a.priceBasis ?? null, a.qualityStatus, a.qualityReason ?? null]);

/** Ids for each distinct attribute tuple, created on first use. */
export async function ensureAttrs(q: Queryable, list: BarAttrs[]): Promise<Map<string, number>> {
  const byKey = new Map(list.map((a) => [attrsKeyOf(a), a]));
  const ids = new Map<string, number>();
  if (!byKey.size) return ids;
  const keys = [...byKey.keys()];
  const read = async () => {
    for (const r of await q.select({ id: brokerCandleAttrsTable.id, key: brokerCandleAttrsTable.attrsKey })
      .from(brokerCandleAttrsTable).where(inArray(brokerCandleAttrsTable.attrsKey, keys))) ids.set(r.key, r.id);
  };
  await read();
  const missing = keys.filter((k) => !ids.has(k));
  if (missing.length) {
    await q.insert(brokerCandleAttrsTable).values(missing.map((k) => {
      const a = byKey.get(k)!;
      return { attrsKey: k, source: a.source, terminalId: a.terminalId ?? null, priceBasis: a.priceBasis ?? null,
        qualityStatus: a.qualityStatus, qualityReason: a.qualityReason ?? null };
    })).onConflictDoNothing();
    await read();
    if (keys.some((k) => !ids.has(k))) throw new Error("BROKER_ATTRS_NOT_CREATED");
  }
  return ids;
}

async function attrsById(q: Queryable, ids: number[]): Promise<Map<number, BrokerCandleAttrs>> {
  const unique = [...new Set(ids)];
  if (!unique.length) return new Map();
  const rows = await q.select().from(brokerCandleAttrsTable).where(inArray(brokerCandleAttrsTable.id, unique));
  return new Map(rows.map((r) => [r.id, r]));
}

// ── Encode / decode ─────────────────────────────────────────────────────────

/** Times a full row needs to store; computable ones become NULL + a bit. */
export function encodeTimes(timeframe: string, t: {
  openTimeUtc: Date; closeTimeUtc: Date | null; rawOpenTime: Date | null; rawCloseTime: Date | null;
  receivedAt: Date | null; createdAt: Date | null;
}): { derived: number; closeTimeUtc: Date | null; rawOpenTime: Date | null; rawCloseTime: Date | null; createdAt: Date | null } {
  const seconds = FIXED_TIMEFRAME_SECONDS[timeframe];
  const plus = (d: Date) => new Date(d.getTime() + seconds! * 1000);
  let derived = 0;
  const createdDerived = t.receivedAt != null && sameTime(t.createdAt, t.receivedAt);
  if (createdDerived) derived |= BAR_DERIVED.CREATED_AT;
  const closeDerived = seconds != null && sameTime(t.closeTimeUtc, plus(t.openTimeUtc));
  if (closeDerived) derived |= BAR_DERIVED.CLOSE_TIME;
  const rawOpenDerived = sameTime(t.rawOpenTime, t.openTimeUtc);
  if (rawOpenDerived) derived |= BAR_DERIVED.RAW_OPEN;
  const rawCloseDerived = seconds != null && t.rawOpenTime instanceof Date && sameTime(t.rawCloseTime, plus(t.rawOpenTime));
  if (rawCloseDerived) derived |= BAR_DERIVED.RAW_CLOSE;
  return {
    derived,
    closeTimeUtc: closeDerived ? null : t.closeTimeUtc,
    rawOpenTime: rawOpenDerived ? null : t.rawOpenTime,
    rawCloseTime: rawCloseDerived ? null : t.rawCloseTime,
    createdAt: createdDerived ? null : t.createdAt,
  };
}

export function decodeBar(bar: BrokerCandleBar, series: BrokerCandleSeries, attrs: BrokerCandleAttrs): BrokerCandleRow {
  const seconds = FIXED_TIMEFRAME_SECONDS[series.timeframe];
  const has = (bit: number) => (bar.derived & bit) !== 0;
  const plus = (d: Date) => new Date(d.getTime() + (seconds ?? 0) * 1000);
  const rawOpenTime = has(BAR_DERIVED.RAW_OPEN) ? bar.openTimeUtc : bar.rawOpenTime;
  return {
    id: bar.legacyId,
    userId: series.userId,
    bridgeConnectionId: series.bridgeConnectionId,
    historyIdentity: series.historyIdentity,
    accountNumber: series.accountNumber,
    brokerSymbol: series.brokerSymbol,
    symbol: series.symbol,
    timeframe: series.timeframe,
    serverName: series.serverName,
    clockBasis: series.clockBasis,
    openTimeUtc: bar.openTimeUtc,
    closeTimeUtc: has(BAR_DERIVED.CLOSE_TIME) ? plus(bar.openTimeUtc) : bar.closeTimeUtc,
    open: bar.open, high: bar.high, low: bar.low, close: bar.close,
    tickVolume: bar.tickVolume,
    tickVolumeObserved: bar.tickVolumeObserved,
    realVolume: bar.realVolume,
    spread: bar.spread,
    source: attrs.source,
    terminalId: attrs.terminalId,
    priceBasis: attrs.priceBasis,
    qualityStatus: attrs.qualityStatus,
    qualityReason: attrs.qualityReason,
    isClosedBar: bar.isClosedBar,
    brokerServerTime: bar.brokerServerTime,
    receivedAt: bar.receivedAt,
    createdAt: has(BAR_DERIVED.CREATED_AT) ? bar.receivedAt : bar.createdAt!,
    updatedAt: bar.updatedAt,
    rawOpenTime,
    rawCloseTime: has(BAR_DERIVED.RAW_CLOSE) && rawOpenTime ? plus(rawOpenTime) : bar.rawCloseTime,
  };
}

// ── Reads ───────────────────────────────────────────────────────────────────

export interface BarQuery {
  closedOnly?: boolean;
  /** open_time_utc < before */
  before?: Date;
  /** open_time_utc <= atOrBefore */
  atOrBefore?: Date;
  /** open_time_utc >= from */
  from?: Date;
  /** exactly these open times */
  openTimes?: Date[];
  order?: "asc" | "desc";
  /** Sort key: the bar's open time (default) or when it was received. */
  orderBy?: "openTime" | "receivedAt";
  limit?: number;
}

/** Bars of the given series, as full rows. Each series is read on its own
 * primary-key range and the results merged, so a limit never sorts history. */
export async function readBars(q: Queryable, series: BrokerCandleSeries[], opts: BarQuery = {}): Promise<BrokerCandleRow[]> {
  if (!series.length) return [];
  if (opts.openTimes && opts.openTimes.length === 0) return [];
  const order = opts.order ?? "asc";
  const key = opts.orderBy === "receivedAt" ? brokerCandleBarsTable.receivedAt : brokerCandleBarsTable.openTimeUtc;
  const bars: { bar: BrokerCandleBar; series: BrokerCandleSeries }[] = [];
  for (const s of series) {
    const conds: SQL[] = [eq(brokerCandleBarsTable.seriesId, s.id)];
    if (opts.closedOnly) conds.push(eq(brokerCandleBarsTable.isClosedBar, true));
    if (opts.before) conds.push(lt(brokerCandleBarsTable.openTimeUtc, opts.before));
    if (opts.atOrBefore) conds.push(lte(brokerCandleBarsTable.openTimeUtc, opts.atOrBefore));
    if (opts.from) conds.push(gte(brokerCandleBarsTable.openTimeUtc, opts.from));
    if (opts.openTimes) conds.push(inArray(brokerCandleBarsTable.openTimeUtc, opts.openTimes));
    let query = q.select().from(brokerCandleBarsTable).where(and(...conds))
      .orderBy(order === "desc" ? desc(key) : asc(key), order === "desc" ? desc(brokerCandleBarsTable.openTimeUtc) : asc(brokerCandleBarsTable.openTimeUtc))
      .$dynamic();
    if (opts.limit != null) query = query.limit(opts.limit);
    for (const bar of await query) bars.push({ bar, series: s });
  }
  const sortTime = (b: BrokerCandleBar) => (opts.orderBy === "receivedAt" ? b.receivedAt : b.openTimeUtc).getTime();
  if (series.length > 1) bars.sort((a, b) => (sortTime(a.bar) - sortTime(b.bar)) * (order === "desc" ? -1 : 1)
    || (a.bar.openTimeUtc.getTime() - b.bar.openTimeUtc.getTime()) * (order === "desc" ? -1 : 1));
  const picked = opts.limit != null ? bars.slice(0, opts.limit) : bars;
  const attrs = await attrsById(q, picked.map((b) => b.bar.attrsId));
  return picked.map(({ bar, series: s }) => decodeBar(bar, s, attrs.get(bar.attrsId)!));
}

/** Count and open-time extent of one series' bars (optionally closed only). */
export async function seriesExtent(q: Queryable, seriesId: number, closedOnly = false): Promise<{ count: number; oldest: Date | null; newest: Date | null }> {
  const [row] = await q.select({
    count: sql<number>`count(*)::int`,
    oldest: sql<string | null>`min(${brokerCandleBarsTable.openTimeUtc})`,
    newest: sql<string | null>`max(${brokerCandleBarsTable.openTimeUtc})`,
  }).from(brokerCandleBarsTable).where(and(eq(brokerCandleBarsTable.seriesId, seriesId),
    ...(closedOnly ? [eq(brokerCandleBarsTable.isClosedBar, true)] : [])));
  return { count: row?.count ?? 0, oldest: row?.oldest ? new Date(row.oldest) : null, newest: row?.newest ? new Date(row.newest) : null };
}

/** Closed-bar counts per series, largest first (one pass over the bars). */
export async function closedBarCounts(q: Queryable, limit: number): Promise<{ series: BrokerCandleSeries; bars: number }[]> {
  const counts = await q.select({ seriesId: brokerCandleBarsTable.seriesId, bars: sql<number>`count(*)::int` })
    .from(brokerCandleBarsTable).where(eq(brokerCandleBarsTable.isClosedBar, true))
    .groupBy(brokerCandleBarsTable.seriesId).orderBy(desc(sql`count(*)`)).limit(limit);
  if (!counts.length) return [];
  const series = await q.select().from(brokerCandleSeriesTable)
    .where(inArray(brokerCandleSeriesTable.id, counts.map((c) => c.seriesId)));
  const byId = new Map(series.map((s) => [s.id, s]));
  return counts.flatMap((c) => (byId.has(c.seriesId) ? [{ series: byId.get(c.seriesId)!, bars: c.bars }] : []));
}

// ── Writes ──────────────────────────────────────────────────────────────────

/** A bar to insert or update, in full-row terms. */
export interface BarWrite {
  openTimeUtc: Date; closeTimeUtc: Date | null;
  rawOpenTime: Date | null; rawCloseTime: Date | null;
  open: number; high: number; low: number; close: number;
  tickVolume: number | null; tickVolumeObserved: boolean; realVolume: number | null; spread: number | null;
  isClosedBar: boolean; brokerServerTime: Date | null;
  attrs: BarAttrs;
}

/**
 * Upsert bars of one series with the store's immutability rule: an existing
 * finalized bar is only rewritten when the incoming bar is closed with equal
 * OHLC and does not lose an observed tick count. On update only the values
 * the old store updated change (prices, close time, volumes, spread, closed
 * flag, quality, updated_at); provenance and receipt times keep their first
 * values. Returns the open times actually written.
 *
 * `attrs` replaces the bar's attribute tuple on update, so for a bar that
 * already exists the caller passes its stored source, terminal and price basis
 * with the new quality status/reason (the old store never updated those three).
 */
export async function upsertBars(q: Queryable, series: BrokerCandleSeries, writes: BarWrite[]): Promise<Date[]> {
  if (!writes.length) return [];
  const attrIds = await ensureAttrs(q, writes.map((w) => w.attrs));
  const written: Date[] = [];
  const now = new Date();
  for (let offset = 0; offset < writes.length; offset += 500) {
    const chunk = writes.slice(offset, offset + 500).map((w) => {
      // A new row's created_at and received_at are the same instant.
      const times = encodeTimes(series.timeframe, { openTimeUtc: w.openTimeUtc, closeTimeUtc: w.closeTimeUtc,
        rawOpenTime: w.rawOpenTime, rawCloseTime: w.rawCloseTime, receivedAt: now, createdAt: now });
      return {
        seriesId: series.id, legacyId: null, attrsId: attrIds.get(attrsKeyOf(w.attrs))!,
        openTimeUtc: w.openTimeUtc, closeTimeUtc: times.closeTimeUtc,
        rawOpenTime: times.rawOpenTime, rawCloseTime: times.rawCloseTime,
        // received_at takes the database default (as the old table's did);
        // created_at is the same instant, so it is stored as derived.
        createdAt: null, updatedAt: now, derived: times.derived | BAR_DERIVED.CREATED_AT,
        open: w.open, high: w.high, low: w.low, close: w.close,
        tickVolume: w.tickVolume, tickVolumeObserved: w.tickVolumeObserved, realVolume: w.realVolume, spread: w.spread,
        isClosedBar: w.isClosedBar, brokerServerTime: w.brokerServerTime,
      };
    });
    const t = brokerCandleBarsTable;
    const rows = await q.insert(t).values(chunk).onConflictDoUpdate({
      target: [t.seriesId, t.openTimeUtc],
      set: {
        open: sql`excluded.open`, high: sql`excluded.high`, low: sql`excluded.low`, close: sql`excluded.close`,
        // close time is recomputed from the incoming row; its derived bit follows it.
        closeTimeUtc: sql`excluded.close_time_utc`,
        derived: sql`(${t.derived} & ~${BAR_DERIVED.CLOSE_TIME}::smallint) | (excluded.derived & ${BAR_DERIVED.CLOSE_TIME}::smallint)`,
        tickVolume: sql`excluded.tick_volume`, tickVolumeObserved: sql`excluded.tick_volume_observed`,
        realVolume: sql`excluded.real_volume`, spread: sql`excluded.spread`, isClosedBar: sql`excluded.is_closed_bar`,
        attrsId: sql`excluded.attrs_id`, updatedAt: now,
      },
      setWhere: sql`NOT ${t.isClosedBar} OR (excluded.is_closed_bar
        AND abs(${t.open} - excluded.open) <= greatest(1e-9,abs(excluded.open)*1e-9)
        AND abs(${t.high} - excluded.high) <= greatest(1e-9,abs(excluded.high)*1e-9)
        AND abs(${t.low} - excluded.low) <= greatest(1e-9,abs(excluded.low)*1e-9)
        AND abs(${t.close} - excluded.close) <= greatest(1e-9,abs(excluded.close)*1e-9)
        AND (NOT ${t.tickVolumeObserved} OR (excluded.tick_volume_observed
          AND ${t.tickVolume} = excluded.tick_volume)))`,
    }).returning({ time: t.openTimeUtc });
    written.push(...rows.map((r) => r.time));
  }
  return written;
}

// ── Full-row writes (copy, fixtures) and deletes ────────────────────────────

/** A full row in the old table's insert shape; defaults match the old table. */
export type FullRowInput = Omit<NewBrokerCandle, "id"> & { id?: number | null };

/**
 * Store full rows exactly as given (no immutability rule: this is for copying
 * already-accepted rows and for test fixtures, not for broker pushes). Bars
 * that already exist in their series are left unchanged. Returns the number of
 * bars inserted.
 */
export async function insertFullRows(q: Queryable, rows: FullRowInput[]): Promise<number> {
  const keyOf = (r: FullRowInput) => ({
    key: { bridgeConnectionId: r.bridgeConnectionId, historyIdentity: r.historyIdentity ?? "legacy", brokerSymbol: r.brokerSymbol, timeframe: r.timeframe },
    attrs: { userId: r.userId, symbol: r.symbol, accountNumber: r.accountNumber ?? null, serverName: r.serverName ?? null, clockBasis: r.clockBasis ?? null },
  });
  const groups = new Map<string, FullRowInput[]>();
  for (const r of rows) {
    const { key, attrs } = keyOf(r);
    const k = seriesKeyOf(key, attrs);
    groups.set(k, [...(groups.get(k) ?? []), r]);
  }
  let inserted = 0;
  for (const group of groups.values()) {
    const { key, attrs } = keyOf(group[0]!);
    const series = await ensureSeries(q, key, attrs);
    const attrsOf = (r: FullRowInput): BarAttrs => ({ source: r.source ?? "mt5_ea", terminalId: r.terminalId ?? null,
      priceBasis: r.priceBasis ?? null, qualityStatus: r.qualityStatus ?? "accepted", qualityReason: r.qualityReason ?? null });
    const attrIds = await ensureAttrs(q, group.map(attrsOf));
    const now = new Date();
    for (let offset = 0; offset < group.length; offset += 500) {
      const values = group.slice(offset, offset + 500).map((r) => {
        const receivedAt = r.receivedAt ?? now, createdAt = r.createdAt ?? receivedAt;
        const times = encodeTimes(series.timeframe, { openTimeUtc: r.openTimeUtc, closeTimeUtc: r.closeTimeUtc ?? null,
          rawOpenTime: r.rawOpenTime ?? null, rawCloseTime: r.rawCloseTime ?? null, receivedAt, createdAt });
        return {
          seriesId: series.id, legacyId: r.id ?? null, attrsId: attrIds.get(attrsKeyOf(attrsOf(r)))!,
          openTimeUtc: r.openTimeUtc, closeTimeUtc: times.closeTimeUtc, rawOpenTime: times.rawOpenTime, rawCloseTime: times.rawCloseTime,
          receivedAt, createdAt: times.createdAt, updatedAt: r.updatedAt ?? now, derived: times.derived,
          open: r.open, high: r.high, low: r.low, close: r.close,
          tickVolume: r.tickVolume ?? null, tickVolumeObserved: r.tickVolumeObserved ?? false,
          realVolume: r.realVolume ?? null, spread: r.spread ?? null,
          isClosedBar: r.isClosedBar ?? true, brokerServerTime: r.brokerServerTime ?? null,
        };
      });
      const done = await q.insert(brokerCandleBarsTable).values(values).onConflictDoNothing()
        .returning({ t: brokerCandleBarsTable.openTimeUtc });
      inserted += done.length;
    }
  }
  return inserted;
}

/** Delete the bars and series matching a filter (tests and owner scripts). */
export async function deleteSeries(q: Queryable, f: SeriesFilter): Promise<number> {
  const series = await findSeries(q, f);
  if (!series.length) return 0;
  const ids = series.map((s) => s.id);
  const gone = await q.delete(brokerCandleBarsTable).where(inArray(brokerCandleBarsTable.seriesId, ids))
    .returning({ t: brokerCandleBarsTable.openTimeUtc });
  await q.delete(brokerCandleSeriesTable).where(inArray(brokerCandleSeriesTable.id, ids));
  return gone.length;
}
