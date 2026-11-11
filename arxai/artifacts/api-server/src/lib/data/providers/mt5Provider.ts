import { registerHeapWatchGauge } from "../../perf/heapWatch.js";
import type { Candle, DataProvider, MarketQuote } from "../types.js";
import {
  MT5_CANDLE_TTL_MS,
  MT5_FEED_FRESH_MS,
  MAX_FUTURE_CLOCK_SKEW_MS,
  QUOTE_FRESH_TTL_MS,
  barOpenUtcMs,
  measuredBrokerClockOffsetMs,
  plausibleBrokerClockOffsetMs,
} from "../freshness.js";

// ── MT5 broker market-data provider ──────────────────────────────────────────
//
// Holds candle/quote data PUSHED from the per-user MT5 EA bridge (CopyRates +
// tick). The provider is a pure in-memory store; it never fetches. Data arrives
// via updateCandlesFromMT5 / updateQuoteFromMT5 / mergeCandleFromMT5, called by
// the EA-facing ingestion endpoints.
//
// BRIDGE|SYMBOL|TIMEFRAME KEYING (R4 slice 2 — audit-marketdata §3.1):
//   Candle series are partitioned by BRIDGE identity first, then keyed
//   `${symbol}|${timeframe}` inside each partition. Two bridges pushing the
//   same symbol|timeframe can NEVER overwrite or blend into one series.
//   Writes that do not know their bridge (legacy v1 sync + v2 event ingest —
//   call sites not yet threaded) land in a distinct UNATTRIBUTED partition;
//   they are never folded into an attributed bridge's series (that would
//   fabricate attribution).
//
// READ RESOLUTION (compatibility contract):
//   - A read WITH an explicit bridgeConnectionId serves ONLY that bridge's
//     series — a miss is an honest empty, never a silent fallback to another
//     bridge or to the unattributed partition.
//   - A read WITHOUT a bridge id serves the SINGLE most-recently-pushing
//     writer for that symbol|timeframe and reports that writer's identity so
//     the router can carry it in the provenance envelope. Series are never
//     merged across writers.
//   - CONTENTION: when two or more DISTINCT ATTRIBUTED bridges have fresh
//     non-empty series for the same symbol|timeframe, the read still serves
//     the most recent one but flags MULTI_BRIDGE_CONTENTION and emits a
//     rate-limited logger.warn. Since v1 sync-candles is attributed, several
//     users' EAs on one symbol is a normal multi-user state, so the warn fires
//     when a symbol's contending bridge SET is first seen or changes (at most
//     hourly), and repeats for an unchanged set at most once a day. The
//     per-read `contention` flag stays truthful on every read. An unattributed
//     writer alongside one attributed bridge is NOT flagged as contention —
//     the unattributed writer's identity is unknown and may be the same
//     physical bridge; claiming "multi-bridge" there would be fabrication.
//
// QUOTES:
//   The latest quote is kept per symbol AND per writer partition (same bridge
//   keying as candles). An unscoped read serves the most recent writer (the
//   previous single-latest behavior) and reports its bridge/owner; a pinned
//   read never falls back to another writer. Each quote also records whether
//   its timestamp is the producer's own tick time (`tickTimeObserved`) or a
//   receive-time stamp — the latter cannot prove quote freshness.
//
// FRESHNESS:
//   Each series stores `updatedAt`. Reads return [] for a series older than
//   CANDLE_TTL_MS (so the router falls through / refuses rather than serving
//   stale broker bars). isConnected() is true when ANY series OR quote is
//   fresh within FEED_FRESH_MS — i.e. the EA is actively pushing.
//
// FUTURE-STAMP OBSERVATION:
//   At write time the store records, PER WRITER (bridge key), whether any
//   incoming bar opened more than MAX_FUTURE_CLOCK_SKEW_MS after the server
//   received it (e.g. broker server time pushed as UTC). One terminal stamps
//   every symbol/timeframe with the same clock, so a +2h offset exposed by an
//   M5 or forming H4/D1 bar marks that writer's H4/D1 series too. The mark is
//   sticky while the writer keeps pushing (cleared only after the writer was
//   silent past CANDLE_TTL_MS), so a mis-stamped series that later stalls —
//   whose offset then makes old bars look current — still reads
//   `futureStamped`. Limit: an offset the writer's pushed bars never expose
//   (e.g. +2h on closed-only H4 pushes with no lower timeframe) cannot be
//   seen from bar times alone.
//   Broker clock (audit H7): EA bars are broker-server-clock coordinates. A
//   bar with a MEASURED broker-clock offset (its own time-basis evidence, or
//   the attributed bridge's offset measured from its own ticks) is compared
//   at bar time minus that offset, so a correctly broker-stamped bar is not
//   "future". With no measured offset the raw bar time is compared (fail
//   closed). Bar times are never rewritten here.
//   A mark set while the writer had NO measured offset (e.g. the EA's first
//   candle-history push lands before its first tick) records the largest raw
//   lead it saw. Once that bridge's offset is measured, the mark is re-checked
//   on the UTC clock: it is dropped when every bar it saw sits within
//   MAX_FUTURE_CLOCK_SKEW_MS of its receipt there, and otherwise becomes a
//   UTC-confirmed mark, sticky like any other. With no offset ever measured
//   (unattributed writer, a bridge that never ticks) it stays (fail closed).

const DEFAULT_TIMEFRAME = "M5";

// A broker candle series is considered usable for this long after its last push.
// Generous vs the bar interval because the EA pushes on a cadence, not per-tick.
// Sourced from the shared freshness module and re-exported under the legacy name
// so the feed-staleness watchdog (and other callers) use the SAME threshold the
// provider uses to stop serving a series — one source of truth for "stale".
export const CANDLE_TTL_MS = MT5_CANDLE_TTL_MS; // 5 minutes
// The provider counts as "connected" when something was pushed this recently.
const FEED_FRESH_MS = MT5_FEED_FRESH_MS; // 60s

/** Provenance/result note flagged when ≥2 distinct attributed bridges hold
 *  fresh series for the same symbol|timeframe. The read NEVER blends them —
 *  it serves the primary (most recent) and names the contention. */
export const MULTI_BRIDGE_CONTENTION_NOTE = "MULTI_BRIDGE_CONTENTION";

// Contention warn rate limit (per SYMBOL): a new/changed contending set warns
// at most hourly; an unchanged set re-warns at most once a day.
const CONTENTION_WARN_INTERVAL_MS = 60 * 60_000;
const CONTENTION_REPEAT_INTERVAL_MS = 24 * 60 * 60_000;

function normalizeTf(tf: string | undefined | null): string {
  const t = (tf ?? "").trim();
  if (!t) return DEFAULT_TIMEFRAME;
  const upper = t.toUpperCase();
  if (/^[MHD]\d+$/.test(upper) || upper === "D1") return upper;
  const map: Record<string, string> = {
    "1m": "M1", "2m": "M2", "3m": "M3", "5m": "M5", "10m": "M10",
    "15m": "M15", "30m": "M30",
    "1h": "H1", "2h": "H2", "4h": "H4", "8h": "H8",
    "1d": "D1", "d1": "D1", "1day": "D1", "daily": "D1",
  };
  return map[t.toLowerCase()] ?? upper;
}

// Normalize an ARX/display symbol to a stable in-memory store key. Trim +
// uppercase so a quote pushed as "eurusd" and a chart read for "EURUSD" land on
// the SAME series — applied identically on WRITE and READ for both candles and
// quotes. This is NOT broker-symbol resolution (that happens only at the
// live-execution boundary); it is purely a consistent analysis-store key so the
// quote store matches the candle-series keying.
export function normalizeSymbolKey(symbol: string): string {
  return (symbol ?? "").trim().toUpperCase();
}

function seriesKey(symbol: string, timeframe: string): string {
  return `${normalizeSymbolKey(symbol)}|${normalizeTf(timeframe)}`;
}

/** Identity of the authenticated bridge a candle push came from. Optional at
 *  every write API so un-threaded legacy call sites keep compiling; a write
 *  without it lands in the unattributed partition, never in a bridge's. */
export interface Mt5BridgeIdentity {
  bridgeConnectionId: number;
  userId?: number | null;
}

// Partition key for writers whose bridge identity was not threaded. MUST stay
// distinct from every String(bridgeConnectionId) value.
const UNATTRIBUTED_BRIDGE_KEY = "unattributed";

function bridgeKeyOf(bridge: Mt5BridgeIdentity | null | undefined): string {
  return bridge != null ? String(bridge.bridgeConnectionId) : UNATTRIBUTED_BRIDGE_KEY;
}

interface CandleSeries {
  candles: Candle[];
  updatedAt: number;
  /** Monotonic write ordinal — the recency ranking. Wall-clock `updatedAt`
   *  (TTL only) cannot rank two writes landing in the same millisecond. */
  writeSeq: number;
  /** null = unattributed partition (writer identity unknown — never guessed). */
  bridgeConnectionId: number | null;
  userId: number | null;
}

/** One writer's future-stamp mark (see FUTURE-STAMP OBSERVATION). */
interface FutureStampMark {
  firstAt: number;
  lastWriteAt: number;
  /**
   * True once the mark is confirmed on the UTC clock: a bar with a MEASURED
   * broker-clock offset opened beyond the skew allowance, or the writer's
   * offset, once measured, still leaves a bar seen without one beyond it. A
   * confirmed mark is sticky while the writer keeps pushing (Truth rule).
   */
  utcConfirmed: boolean;
  /**
   * Largest raw lead (bar open minus receipt, ms) among the bars this writer
   * pushed with NO measured offset while the mark stood. -Infinity when none.
   */
  unmeasuredLeadMs: number;
}

/** Per-writer future-stamp marks: bridgeKey → mark. */
const futureStampMarks = new Map<string, FutureStampMark>();

/** The attributed bridge's broker-clock offset measured from its own ticks
 *  (plausible values only); null for an unattributed writer or no tick yet. */
function writerBrokerClockOffsetMs(bridgeConnectionId: number | null | undefined): number | null {
  if (bridgeConnectionId == null) return null;
  return plausibleBrokerClockOffsetMs(getMt5BridgeClockOffset({ bridgeConnectionId })?.offsetMs);
}

/** A mark set with no measured offset that the writer's now-measured offset
 *  fully explains: every bar it saw opens within the skew allowance of its
 *  receipt on the UTC clock. A UTC-confirmed mark is never explained away. */
function unmeasuredMarkExplained(mark: FutureStampMark, bridgeConnectionId: number | null | undefined): boolean {
  if (mark.utcConfirmed) return false;
  const offsetMs = writerBrokerClockOffsetMs(bridgeConnectionId);
  return offsetMs != null && mark.unmeasuredLeadMs - offsetMs <= MAX_FUTURE_CLOCK_SKEW_MS;
}

/** Record a write by `bKey` at `now`; mark the writer when any incoming bar
 *  opens beyond receipt + MAX_FUTURE_CLOCK_SKEW_MS. A mark survives while the
 *  writer keeps pushing; a writer silent past CANDLE_TTL_MS starts clean.
 *  Unparseable bar times are ignored here (the ingest paths reject them).
 *
 *  Broker clock (audit H7): EA bars are stamped on the broker's trade-server
 *  clock, not UTC. When a MEASURED broker-clock offset applies to a bar (see
 *  mt5BarBrokerClockOffsetMs) the bar is compared on the UTC clock (bar time
 *  minus offset), so a correctly broker-stamped bar from a bridge whose offset
 *  is known is not "future". With no measured offset the raw bar time is
 *  compared (fail closed); such a mark is re-checked on the UTC clock once the
 *  bridge's offset is measured (see FUTURE-STAMP OBSERVATION). */
function observeFutureStamp(
  bKey: string,
  incoming: Candle[],
  now: number,
  bridge: Mt5BridgeIdentity | null | undefined,
): void {
  const mark = futureStampMarks.get(bKey);
  if (mark && now - mark.lastWriteAt > CANDLE_TTL_MS) futureStampMarks.delete(bKey);
  const live = futureStampMarks.get(bKey);
  if (live?.utcConfirmed) {
    live.lastWriteAt = now;
    return;
  }
  const bridgeId = bridge?.bridgeConnectionId ?? null;
  let utcFuture = false;
  let unmeasuredLeadMs = Number.NEGATIVE_INFINITY;
  for (const c of incoming) {
    const t = Date.parse(c.time);
    if (!Number.isFinite(t)) continue;
    const offsetMs = mt5BarBrokerClockOffsetMs(c, bridgeId);
    if (offsetMs == null) unmeasuredLeadMs = Math.max(unmeasuredLeadMs, t - now);
    else if (barOpenUtcMs(t, offsetMs) - now > MAX_FUTURE_CLOCK_SKEW_MS) utcFuture = true;
  }
  if (live) {
    // A mark set with no measured offset: keep folding unmeasured bars into
    // it; confirm it on the UTC clock, or drop it once the writer's measured
    // offset explains every bar it saw. No offset yet → it stands.
    live.lastWriteAt = now;
    live.unmeasuredLeadMs = Math.max(live.unmeasuredLeadMs, unmeasuredLeadMs);
    if (utcFuture) {
      live.utcConfirmed = true;
      return;
    }
    const offsetMs = writerBrokerClockOffsetMs(bridgeId);
    if (offsetMs == null) return;
    if (live.unmeasuredLeadMs - offsetMs > MAX_FUTURE_CLOCK_SKEW_MS) live.utcConfirmed = true;
    else futureStampMarks.delete(bKey);
    return;
  }
  if (utcFuture) {
    futureStampMarks.set(bKey, { firstAt: now, lastWriteAt: now, utcConfirmed: true, unmeasuredLeadMs });
  } else if (unmeasuredLeadMs > MAX_FUTURE_CLOCK_SKEW_MS) {
    futureStampMarks.set(bKey, { firstAt: now, lastWriteAt: now, utcConfirmed: false, unmeasuredLeadMs });
  }
}

/**
 * The MEASURED broker-clock offset (broker epoch ms minus EA UTC epoch ms)
 * that applies to an MT5 bar: the bar's own time-basis evidence (bridge v2
 * CANDLE, audit H7), else — for an attributed writer — that bridge's offset
 * measured from its own ticks (getMt5BridgeClockOffset), else null. An
 * unattributed writer, a bridge with no tick yet or an implausible offset gets
 * null: nothing is guessed. For freshness comparisons only; bar times are
 * never rewritten.
 */
export function mt5BarBrokerClockOffsetMs(
  bar: { timeBasisEvidence?: unknown } | null | undefined,
  bridgeConnectionId: number | null | undefined,
): number | null {
  const own = measuredBrokerClockOffsetMs(bar?.timeBasisEvidence);
  if (own != null) return own;
  return writerBrokerClockOffsetMs(bridgeConnectionId);
}

/**
 * The measured broker-clock offset for a ROUTED series' bars (same rule as
 * chartDataService / candleHistoryService): only an in-memory MT5 broker
 * series (providerId mt5_broker, no sub-provider) gets one, via
 * mt5BarBrokerClockOffsetMs with its serving bridge. Every other provider, an
 * MT5 mirror and an unmeasured bridge get null. null does NOT make an MT5
 * stamp safe to compare as given: a broker clock ahead of UTC makes a stalled
 * series look current, so a caller pairs null with servedSeriesBrokerStamped
 * and never confirms such a series current. For freshness comparisons only.
 */
export function servedSeriesBrokerClockOffsetMs(
  provenance: { providerId?: string | null; subProviderId?: string | null; bridgeConnectionId?: number | null } | null | undefined,
  newestBar?: { timeBasisEvidence?: unknown } | null,
): number | null {
  if (provenance?.providerId !== "mt5_broker" || provenance.subProviderId != null) return null;
  return mt5BarBrokerClockOffsetMs(newestBar ?? null, provenance.bridgeConnectionId ?? null);
}

/**
 * The ROUTED series' bar stamps are MT5 broker-server-clock time (audit H7),
 * not UTC: the MT5 broker venue served it, through any channel (in-memory push
 * or the durable mirror). Such a series is aged on the UTC clock only with a
 * MEASURED offset (servedSeriesBrokerClockOffsetMs). With none — the mirror,
 * an unattributed writer, a bridge with no broker-time tick yet — its age
 * cannot be checked: compared as stamped, a UTC+2 series silent for about two
 * hours reads current. Callers never confirm such a series current.
 */
export function servedSeriesBrokerStamped(
  provenance: { providerId?: string | null; brokerCode?: string | null } | null | undefined,
): boolean {
  return provenance?.providerId === "mt5_broker" || provenance?.brokerCode === "mt5";
}

/** The serving writer's future-stamp mark stands. A mark set with no
 *  measured offset that the bridge's since-measured offset fully explains no
 *  longer stands (the next write drops it); a UTC-confirmed mark always does. */
function writerFutureStamped(s: CandleSeries): boolean {
  const mark = futureStampMarks.get(s.bridgeConnectionId != null ? String(s.bridgeConnectionId) : UNATTRIBUTED_BRIDGE_KEY);
  return mark != null && !unmeasuredMarkExplained(mark, s.bridgeConnectionId);
}

// symbol|timeframe → (bridgeKey → series). Partitions are hard walls: no read
// or write path may merge candles across two partition entries.
const candleStore = new Map<string, Map<string, CandleSeries>>();

/**
 * How a bridge's partition came to hold its current tick. The Universal Agent
 * re-posts `SymbolInfoTick`'s LAST tick on every sweep whether or not it
 * changed, stamping each post with its then-current UTC clock, so the post
 * time of a tick says nothing about when the tick occurred. The store therefore
 * stamps a tick at the EA time it was FIRST seen in the partition and keeps
 * that stamp across identical re-posts; the previous post's EA time bounds
 * when the tick can have occurred (it was not the last tick then).
 */
export interface Mt5TickProvenance {
  /** EA UTC ms at which THIS tick (broker clock + bid + ask) was first seen here. */
  firstSeenEaMs: number;
  /** EA UTC ms of the most recent post of this tick, identical re-posts included. */
  lastPostedEaMs: number;
  /** Identical re-posts of this tick since it was first seen. */
  reposts: number;
  /**
   * EA UTC ms of the partition's last post BEFORE this tick was first seen: the
   * latest moment the feed is known not to have had it yet. null when this is
   * the first tick the partition ever held (its age cannot be bounded).
   */
  priorPostEaMs: number | null;
}

interface TickProvenanceState extends Mt5TickProvenance {
  /** Identity of the tick: broker clock + bid + ask. */
  key: string;
}

/** One writer's latest quote. Quotes are partitioned by bridge exactly like
 *  candle series, so a quote can carry the identity of the bridge that pushed
 *  it. `tickTimeObserved` is true only when `quote.timestamp` is a producer
 *  observation of the tick (see recordMt5Tick); a receive-time stamp is not. */
interface QuoteEntry {
  quote: MarketQuote;
  updatedAt: number;
  /** Monotonic write ordinal — the recency ranking for the unscoped read. */
  writeSeq: number;
  /** null = unattributed partition (writer identity unknown — never guessed). */
  bridgeConnectionId: number | null;
  userId: number | null;
  /** True only when `quote.timestamp` is a producer observation of the tick:
   *  a `recordMt5Tick` first-sight EA UTC stamp tightly bounded by a recent
   *  earlier post (see recordMt5Tick), or
   *  an `updateQuoteFromMT5` write whose caller states it. Receive-time stamps
   *  and an unbounded first sight are not observed tick times. */
  tickTimeObserved: boolean;
  /** Set by `recordMt5Tick`; null for a legacy latest-wins `updateQuoteFromMT5` write. */
  tick: TickProvenanceState | null;
}
// symbol → (bridgeKey → latest quote). Same partition wall as the candle store:
// a bridge-scoped read serves ONLY that bridge's quote; the unscoped read
// serves the most recent writer (single-writer behaviour unchanged) and
// reports that writer's identity.
const quoteStore = new Map<string, Map<string, QuoteEntry>>();
let lastUpdate = 0;
let writeCounter = 0;
// symbol → last contention-warn emit time (rate limit state).
const contentionWarnAt = new Map<string, { at: number; setKey: string }>();
registerHeapWatchGauge("mt5Provider.candleSeries", () => { let n = 0; for (const m of candleStore.values()) n += m.size; return n; });
registerHeapWatchGauge("mt5Provider.candleBars", () => { let n = 0; for (const m of candleStore.values()) for (const s of m.values()) n += s.candles.length; return n; });
registerHeapWatchGauge("mt5Provider.quotes", () => { let n = 0; for (const m of quoteStore.values()) n += m.size; return n; });

type ContentionWarnSink = (payload: Record<string, unknown>) => void;
let contentionWarnSink: ContentionWarnSink | null = null;

/** Test hook — capture contention warns instead of the process logger.
 *  Pass null to restore the default (lazy pino logger). */
export function __setMt5ContentionWarnSink(sink: ContentionWarnSink | null): void {
  contentionWarnSink = sink;
}

function emitContentionWarn(payload: Record<string, unknown>): void {
  if (contentionWarnSink) {
    contentionWarnSink(payload);
    return;
  }
  // Lazy import keeps this module's init transport-free (same constraint the
  // staleness-watchdog core states). A logging failure must never break a read.
  void import("../../logger.js")
    .then(({ logger }) => {
      logger.warn(payload, "mt5_multi_bridge_contention");
    })
    .catch(() => {});
}

function partitionsFor(symbol: string, timeframe: string): Map<string, CandleSeries> {
  const key = seriesKey(symbol, timeframe);
  let partitions = candleStore.get(key);
  if (!partitions) {
    partitions = new Map<string, CandleSeries>();
    candleStore.set(key, partitions);
  }
  return partitions;
}

/** The partition that answers an unscoped read: the most recently WRITTEN
 *  writer for the symbol|timeframe (monotonic writeSeq — deterministic even
 *  when two pushes share a wall-clock millisecond). Never merges partitions. */
function servingSeries(partitions: Map<string, CandleSeries> | undefined): CandleSeries | null {
  if (!partitions || partitions.size === 0) return null;
  let best: CandleSeries | null = null;
  for (const s of partitions.values()) {
    if (!best || s.writeSeq > best.writeSeq) best = s;
  }
  return best;
}

/**
 * Push a candle WINDOW for an exact symbol+timeframe.
 *
 * - Attributed writer (bridge identity known): the window is MERGED into that
 *   bridge's partition by bar time (upsert, last write wins, ascending, capped
 *   to MAX_MERGED_BARS). The same partition also holds deeper bars merged by
 *   /mt5/candles/ingest, bridge v2 CANDLE events and /mt5/sync-candle-history,
 *   so a short v1 rolling window must never truncate that history.
 * - Unattributed writer (legacy 3-arg form): REPLACES the unattributed
 *   partition, exactly as before (the EA sends the latest window each push).
 *
 * Callers validate bars before calling (the /mt5/sync-candles route rejects
 * impossible OHLC and unparseable times, like the other ingest paths).
 * Stamps freshness.
 */
export function updateCandlesFromMT5(
  symbol: string,
  candles: Candle[],
  timeframe: string = DEFAULT_TIMEFRAME,
  bridge?: Mt5BridgeIdentity | null,
): void {
  const partitions = partitionsFor(symbol, timeframe);
  const bKey = bridgeKeyOf(bridge);
  const now = Date.now();
  const stored = bridge != null ? mergeByBarTime(partitions.get(bKey)?.candles ?? [], candles) : candles;
  partitions.set(bKey, {
    candles: stored,
    updatedAt: now,
    writeSeq: ++writeCounter,
    bridgeConnectionId: bridge?.bridgeConnectionId ?? null,
    userId: bridge?.userId ?? null,
  });
  observeFutureStamp(bKey, candles, now, bridge);
  lastUpdate = now;
}

/** Bar identity for merging: the parsed instant, so "…T08:00:00Z" and
 *  "…T08:00:00.000Z" are the same bar; unparseable times key by raw string. */
function barKey(c: Candle): string {
  const t = Date.parse(c.time);
  return Number.isFinite(t) ? `t${t}` : `s${c.time}`;
}
function barOrder(c: Candle): number {
  const t = Date.parse(c.time);
  return Number.isFinite(t) ? t : Number.NEGATIVE_INFINITY;
}

/** Upsert `incoming` into `existing` by bar time (incoming wins), ascending,
 *  capped to the most recent MAX_MERGED_BARS. Never mixes partitions. */
function mergeByBarTime(existing: Candle[], incoming: Candle[]): Candle[] {
  const byTime = new Map<string, Candle>();
  for (const c of existing) byTime.set(barKey(c), c);
  for (const c of incoming) byTime.set(barKey(c), c);
  const merged = Array.from(byTime.values()).sort((a, b) => {
    const d = barOrder(a) - barOrder(b);
    return d !== 0 && Number.isFinite(d) ? d : a.time < b.time ? -1 : a.time > b.time ? 1 : 0;
  });
  return merged.length > MAX_MERGED_BARS ? merged.slice(-MAX_MERGED_BARS) : merged;
}

// The most bars a single series retains. The v2 bridge pushes ONE closed bar
// per CANDLE event (unlike an unattributed v1 sync push, which replaces the whole window),
// so a long-running stream would grow unboundedly without a cap. Keep the most
// recent window — more than enough for every chart/scan timeframe.
const MAX_MERGED_BARS = 1500;

/**
 * Merge ONE closed broker bar into the stored series for an exact
 * symbol+timeframe WITHIN THE WRITER'S PARTITION, without discarding that
 * partition's history. A merge without bridge identity targets the
 * unattributed partition only — it must never land in an attributed bridge's
 * series (that would fabricate attribution).
 *
 * Semantics (per partition):
 *   - dedupe/upsert by bar `time` (last write wins for a re-sent same-time bar),
 *   - keep ascending time order,
 *   - cap to the most recent MAX_MERGED_BARS,
 *   - stamp freshness so the router serves it and `isConnected()` flips true.
 */
export function mergeCandleFromMT5(
  symbol: string,
  candle: Candle,
  timeframe: string = DEFAULT_TIMEFRAME,
  bridge?: Mt5BridgeIdentity | null,
): void {
  const partitions = partitionsFor(symbol, timeframe);
  const bKey = bridgeKeyOf(bridge);
  const existing = partitions.get(bKey);
  // Last-write-wins on identical bar time (an idempotent re-send is a no-op).
  const capped = mergeByBarTime(existing?.candles ?? [], [candle]);
  const now = Date.now();
  partitions.set(bKey, {
    candles: capped,
    updatedAt: now,
    writeSeq: ++writeCounter,
    bridgeConnectionId: bridge?.bridgeConnectionId ?? null,
    userId: bridge?.userId ?? null,
  });
  observeFutureStamp(bKey, [candle], now, bridge);
  lastUpdate = now;
}

/**
 * Store the latest quote for a symbol WITHIN THE WRITER'S PARTITION. The
 * legacy 2-arg form writes the unattributed partition, which a bridge-scoped
 * read never serves. `tickTimeObserved` must be true only when
 * `quote.timestamp` is the producer-supplied tick time; omitted means unknown
 * and is reported as not observed. (The bridge v2 TICK path uses
 * `recordMt5Tick`, which stamps the EA's first-sight UTC time.)
 */
export function updateQuoteFromMT5(
  symbol: string,
  quote: MarketQuote,
  bridge?: Mt5BridgeIdentity | null,
  observation?: { tickTimeObserved?: boolean },
): void {
  const key = normalizeSymbolKey(symbol);
  let partitions = quoteStore.get(key);
  if (!partitions) {
    partitions = new Map<string, QuoteEntry>();
    quoteStore.set(key, partitions);
  }
  partitions.set(bridgeKeyOf(bridge), {
    quote,
    updatedAt: Date.now(),
    writeSeq: ++writeCounter,
    bridgeConnectionId: bridge?.bridgeConnectionId ?? null,
    userId: bridge?.bridgeConnectionId != null ? bridge.userId ?? null : null,
    tickTimeObserved: observation?.tickTimeObserved === true,
    tick: null,
  });
  lastUpdate = Date.now();
}

/** One EA tick post as the bridge v2 ingest hands it over. */
export interface Mt5TickInput {
  brokerSymbol?: string | null;
  bid: number;
  ask: number;
  /** Payload `brokerTimeEpochMs` (MQL5 `MqlTick.time_msc`): the trade server's
   *  wall clock, NOT UTC. null when the payload carried none. */
  brokerTimeMs: number | null;
  /** Envelope `eaCreatedAtEpochMs`: the EA's UTC clock when it posted the tick. */
  eaUtcMs: number;
}

/**
 * Record an EA tick post in the pushing bridge's partition, stamping the quote
 * at the EA UTC time the tick was FIRST seen there.
 *
 * - A post identical to the partition's current tick (same broker clock, bid
 *   and ask) is a re-post: the quote and its `timestamp` are left untouched,
 *   the re-post is counted and the store TTL is refreshed (the feed is alive
 *   even when the market is not).
 * - A different tick replaces the quote with `timestamp = eaUtcMs` and records
 *   the previous post's EA time as the bound on when it can have occurred.
 *
 * `tickTimeObserved` (Truth quote binding / quote observation evidence) is
 * true only for a tick that carried its broker time AND whose first sight is
 * tightly bounded by an earlier post in this partition: that post came at
 * most QUOTE_FRESH_TTL_MS earlier on the EA clock and the partition entry is
 * still inside CANDLE_TTL_MS. The first tick a partition ever holds (e.g. a
 * weekend quote re-posted after a server restart), or the first new tick
 * after an EA outage, may be arbitrarily old, so its first-sight stamp is not
 * an observed tick time.
 *
 * Nothing here estimates the broker's UTC offset or falls back to the server
 * clock; the broker clock and its offset at first sight are kept as diagnostics.
 */
export function recordMt5Tick(
  symbol: string,
  tick: Mt5TickInput,
  bridge: Mt5BridgeIdentity | null,
): Mt5TickProvenance {
  const key = normalizeSymbolKey(symbol);
  const partitions = quoteStore.get(key) ?? new Map<string, QuoteEntry>();
  const bKey = bridgeKeyOf(bridge);
  const existing = partitions.get(bKey);
  const tickKey = `${tick.brokerSymbol ?? "-"}|${tick.brokerTimeMs ?? "-"}|${tick.bid}|${tick.ask}`;
  const now = Date.now();
  let entry: QuoteEntry;
  if (existing?.tick && existing.tick.key === tickKey) {
    entry = {
      ...existing,
      updatedAt: now,
      writeSeq: ++writeCounter,
      tick: {
        ...existing.tick,
        lastPostedEaMs: tick.eaUtcMs,
        reposts: existing.tick.reposts + 1,
      },
    };
  } else {
    const priorPostEaMs = existing?.tick && (existing.quote.brokerSymbol ?? null) === (tick.brokerSymbol ?? null) ? existing.tick.lastPostedEaMs : null;
    // The prior post bounds the tick's real time only when it is recent: the
    // partition entry is still within the store TTL (server clock) and the
    // prior post came at most QUOTE_FRESH_TTL_MS before this one (EA clock).
    // After an EA outage the first different tick (e.g. Friday's close
    // re-posted on the weekend) may be days old, so it is not observed.
    const boundGapMs = priorPostEaMs != null ? tick.eaUtcMs - priorPostEaMs : null;
    const tightlyBounded =
      existing != null &&
      now - existing.updatedAt <= CANDLE_TTL_MS &&
      boundGapMs != null &&
      Number.isFinite(boundGapMs) &&
      boundGapMs >= 0 &&
      boundGapMs <= QUOTE_FRESH_TTL_MS;
    entry = {
      quote: {
        symbol,
        brokerSymbol: tick.brokerSymbol ?? null,
        bid: tick.bid,
        ask: tick.ask,
        spread: tick.ask - tick.bid,
        timestamp: new Date(tick.eaUtcMs).toISOString(),
        brokerClockMs: tick.brokerTimeMs,
        brokerClockOffsetMs: tick.brokerTimeMs == null ? null : tick.brokerTimeMs - tick.eaUtcMs,
      },
      updatedAt: now,
      writeSeq: ++writeCounter,
      bridgeConnectionId: bridge?.bridgeConnectionId ?? null,
      userId: bridge?.bridgeConnectionId != null ? bridge.userId ?? null : null,
      tickTimeObserved: tick.brokerTimeMs != null && tightlyBounded,
      tick: {
        key: tickKey,
        firstSeenEaMs: tick.eaUtcMs,
        lastPostedEaMs: tick.eaUtcMs,
        reposts: 0,
        priorPostEaMs,
      },
    };
  }
  partitions.set(bKey, entry);
  quoteStore.set(key, partitions);
  lastUpdate = now;
  return publicProvenance(entry.tick!);
}

function publicProvenance(t: TickProvenanceState): Mt5TickProvenance {
  return {
    firstSeenEaMs: t.firstSeenEaMs,
    lastPostedEaMs: t.lastPostedEaMs,
    reposts: t.reposts,
    priorPostEaMs: t.priorPostEaMs,
  };
}

/** The most recently written quote partition for a symbol (any age). */
function servingQuote(partitions: Map<string, QuoteEntry> | undefined): QuoteEntry | null {
  if (!partitions || partitions.size === 0) return null;
  let best: QuoteEntry | null = null;
  for (const q of partitions.values()) {
    if (!best || q.writeSeq > best.writeSeq) best = q;
  }
  return best;
}

export interface Mt5QuoteRead {
  quote: MarketQuote;
  /** Identity of the serving writer; null = unattributed partition served. */
  bridgeConnectionId: number | null;
  userId: number | null;
  /** True only when the quote's timestamp is a producer-observed tick time. */
  tickTimeObserved: boolean;
  /** First-sight provenance of the quote's tick (`recordMt5Tick`); null when
   *  the quote was written without it. */
  tick: Mt5TickProvenance | null;
  /** Server wall-clock ms when THIS partition's quote was pushed (its receive
   *  time). Lets the router label a push older than MT5_FEED_FRESH_MS STALE
   *  instead of LIVE_TICK for the partition actually read (pinned or not). */
  receivedAtMs: number;
}

/**
 * The pushing bridge's broker-clock offset (broker epoch ms minus EA UTC epoch
 * ms), from the newest tick that bridge posted for ANY symbol, with the EA UTC
 * time of that tick. Null until the bridge has posted a tick carrying a broker
 * time. Read by the CANDLE ingest to stamp bars (audit H7) and by the
 * future-stamp check below; never rewrites a bar time. An unattributed bridge
 * has no offset (null): nothing is guessed.
 */
export function getMt5BridgeClockOffset(
  bridge: Mt5BridgeIdentity | null | undefined,
): { offsetMs: number; measuredAtMs: number } | null {
  if (bridge == null) return null;
  const bKey = bridgeKeyOf(bridge);
  let best: QuoteEntry | null = null;
  for (const partitions of quoteStore.values()) {
    const e = partitions.get(bKey);
    if (!e || e.quote.brokerClockOffsetMs == null || !Number.isFinite(e.quote.brokerClockOffsetMs)) continue;
    if (!best || e.writeSeq > best.writeSeq) best = e;
  }
  if (!best || best.quote.brokerClockOffsetMs == null) return null;
  const measuredAtMs = Date.parse(best.quote.timestamp);
  return { offsetMs: best.quote.brokerClockOffsetMs, measuredAtMs: Number.isFinite(measuredAtMs) ? measuredAtMs : best.updatedAt };
}

/**
 * Read the latest quote. With opts.bridgeConnectionId: ONLY that bridge's
 * partition (miss/stale → null; no fallback to another bridge or to the
 * unattributed partition) — the read the self-trade entry claim and the Risk
 * Governor's own-bridge price use, so one user's EA can never supply the quote
 * fact for another user's command. With opts.writer: ONLY that writer's
 * partition, where `bridgeConnectionId: null` names the unattributed partition
 * (used to pair a quote with a served candle series from the same writer).
 * Without either: the most recent writer, reporting its identity. Never
 * blends writers.
 */
export function readMt5Quote(
  symbol: string,
  opts?: { bridgeConnectionId?: number | null; writer?: { bridgeConnectionId: number | null }; now?: number },
): Mt5QuoteRead | null {
  const now = opts?.now ?? Date.now();
  const partitions = quoteStore.get(normalizeSymbolKey(symbol));
  if (!partitions || partitions.size === 0) return null;
  let entry: QuoteEntry | null = null;
  if (opts?.writer) {
    const id = opts.writer.bridgeConnectionId;
    entry = partitions.get(id != null ? String(id) : UNATTRIBUTED_BRIDGE_KEY) ?? null;
  } else if (opts?.bridgeConnectionId != null) {
    entry = partitions.get(String(opts.bridgeConnectionId)) ?? null;
  } else {
    entry = servingQuote(partitions);
  }
  if (!entry || now - entry.updatedAt > CANDLE_TTL_MS) return null;
  return {
    quote: entry.quote,
    bridgeConnectionId: entry.bridgeConnectionId,
    userId: entry.userId,
    tickTimeObserved: entry.tickTimeObserved,
    tick: entry.tick ? publicProvenance(entry.tick) : null,
    receivedAtMs: entry.updatedAt,
  };
}

/** Test/diagnostic helper — clear all pushed data + contention-warn state. */
export function __resetMt5ProviderStore(): void {
  candleStore.clear();
  quoteStore.clear();
  contentionWarnAt.clear();
  futureStampMarks.clear();
  lastUpdate = 0;
  writeCounter = 0;
}

// ── Bridge-scoped read (the ONLY candle read path) ───────────────────────────

export interface Mt5CandleRead {
  /** Bars from EXACTLY ONE partition (never blended); [] when absent/stale. */
  candles: Candle[];
  /** Identity of the serving writer; null = unattributed partition served. */
  bridgeConnectionId: number | null;
  userId: number | null;
  /** TRUE when ≥2 distinct attributed bridges held fresh non-empty series for
   *  this symbol|timeframe at read time (unscoped reads only). */
  contention: boolean;
  /** The distinct attributed bridge ids that were fresh at read time. */
  contendingBridgeIds: number[];
  /** The serving writer was observed stamping bars ahead of their receipt
   *  time (sticky; see FUTURE-STAMP OBSERVATION). Recency cannot be confirmed. */
  futureStamped: boolean;
}

const EMPTY_READ: Mt5CandleRead = {
  candles: [],
  bridgeConnectionId: null,
  userId: null,
  contention: false,
  contendingBridgeIds: [],
  futureStamped: false,
};

/**
 * Read candles for symbol+timeframe. With opts.bridgeConnectionId: serve ONLY
 * that bridge's partition (miss/stale → honest empty; no fallback). Without:
 * serve the most-recently-pushing writer and report its identity + contention.
 * `now` is injectable for deterministic TTL/rate-limit testing.
 */
export function readMt5Candles(
  symbol: string,
  timeframe: string,
  limit: number,
  opts?: { bridgeConnectionId?: number | null; now?: number },
): Mt5CandleRead {
  const now = opts?.now ?? Date.now();
  const partitions = candleStore.get(seriesKey(symbol, timeframe));
  if (!partitions || partitions.size === 0) return { ...EMPTY_READ };

  if (opts?.bridgeConnectionId != null) {
    const s = partitions.get(String(opts.bridgeConnectionId));
    if (!s || now - s.updatedAt > CANDLE_TTL_MS) return { ...EMPTY_READ };
    return {
      candles: s.candles.slice(-limit),
      bridgeConnectionId: s.bridgeConnectionId,
      userId: s.userId,
      contention: false,
      contendingBridgeIds: [],
      futureStamped: writerFutureStamped(s),
    };
  }

  const serving = servingSeries(partitions);
  if (!serving || now - serving.updatedAt > CANDLE_TTL_MS) return { ...EMPTY_READ };

  // Contention requires ≥2 DISTINCT ATTRIBUTED bridges fresh with bars — an
  // unattributed writer cannot substantiate a multi-bridge claim.
  const freshAttributed: number[] = [];
  for (const s of partitions.values()) {
    if (
      s.bridgeConnectionId != null &&
      s.candles.length > 0 &&
      now - s.updatedAt <= CANDLE_TTL_MS
    ) {
      freshAttributed.push(s.bridgeConnectionId);
    }
  }
  const contention = freshAttributed.length >= 2;
  if (contention) {
    const symKey = normalizeSymbolKey(symbol);
    const setKey = [...freshAttributed].sort((a, b) => a - b).join(",");
    const lastWarn = contentionWarnAt.get(symKey);
    const due =
      lastWarn == null ||
      (lastWarn.setKey !== setKey && now - lastWarn.at >= CONTENTION_WARN_INTERVAL_MS) ||
      now - lastWarn.at >= CONTENTION_REPEAT_INTERVAL_MS;
    if (due) {
      contentionWarnAt.set(symKey, { at: now, setKey });
      emitContentionWarn({
        symbol: symKey,
        timeframe: normalizeTf(timeframe),
        note: MULTI_BRIDGE_CONTENTION_NOTE,
        contendingBridgeIds: [...freshAttributed].sort((a, b) => a - b),
        servedBridgeConnectionId: serving.bridgeConnectionId,
      });
    }
  }

  return {
    candles: serving.candles.slice(-limit),
    bridgeConnectionId: serving.bridgeConnectionId,
    userId: serving.userId,
    contention,
    contendingBridgeIds: contention ? [...freshAttributed].sort((a, b) => a - b) : [],
    futureStamped: writerFutureStamped(serving),
  };
}

/** Per-series freshness probe (used by diagnostics). Reflects the SERVING
 *  partition (most recent writer) so it matches what a read would return. */
export function getMt5SeriesFreshness(
  symbol: string,
  timeframe: string,
  now: number = Date.now(),
): { hasSeries: boolean; ageMs: number | null; fresh: boolean; barCount: number } {
  const s = servingSeries(candleStore.get(seriesKey(symbol, timeframe)));
  if (!s) return { hasSeries: false, ageMs: null, fresh: false, barCount: 0 };
  const ageMs = now - s.updatedAt;
  return { hasSeries: true, ageMs, fresh: ageMs <= CANDLE_TTL_MS, barCount: s.candles.length };
}

/**
 * Candle-store introspection for the router: lets it report a PRECISE reason
 * when MT5 has no fresh bars for a request — distinguishing "this timeframe is
 * missing but the symbol is pushing other timeframes" from "this symbol was
 * never pushed at all". Read-only; never mutates the store. Freshness of the
 * requested series reflects the SERVING partition (what a read would return).
 */
export function getMt5CandleAvailability(
  symbol: string,
  timeframe: string,
  now: number = Date.now(),
): {
  requestedHasSeries: boolean;
  requestedFresh: boolean;
  symbolHasAnySeries: boolean;
  symbolHasAnyFreshSeries: boolean;
} {
  const wantKey = seriesKey(symbol, timeframe);
  const wantSym = normalizeSymbolKey(symbol);
  let requestedHasSeries = false;
  let requestedFresh = false;
  let symbolHasAnySeries = false;
  let symbolHasAnyFreshSeries = false;
  for (const [key, partitions] of candleStore.entries()) {
    if (partitions.size === 0) continue;
    const [sym] = key.split("|") as [string, string];
    const serving = servingSeries(partitions);
    const fresh =
      serving != null && now - serving.updatedAt <= CANDLE_TTL_MS && serving.candles.length > 0;
    if (key === wantKey) {
      requestedHasSeries = true;
      requestedFresh = fresh;
    }
    if (sym === wantSym) {
      symbolHasAnySeries = true;
      if (fresh) symbolHasAnyFreshSeries = true;
    }
  }
  return { requestedHasSeries, requestedFresh, symbolHasAnySeries, symbolHasAnyFreshSeries };
}

/**
 * Quote-store introspection for the router (read-only). `hasPrice` mirrors the
 * router's usable-quote test (a positive bid/ask/last).
 */
export function getMt5QuoteAvailability(
  symbol: string,
  now: number = Date.now(),
): { hasQuote: boolean; fresh: boolean; hasPrice: boolean; ageMs: number | null } {
  const q = servingQuote(quoteStore.get(normalizeSymbolKey(symbol)));
  if (!q) return { hasQuote: false, fresh: false, hasPrice: false, ageMs: null };
  const ageMs = Math.max(0, now - q.updatedAt);
  const fresh = ageMs <= CANDLE_TTL_MS;
  const { bid, ask, last } = q.quote;
  const hasPrice =
    (bid != null && bid > 0) || (ask != null && ask > 0) || (last != null && last > 0);
  return { hasQuote: true, fresh, hasPrice, ageMs };
}

export type Mt5SeriesContributionStatus =
  | "contributing"      // fresh, non-empty — this series IS answering chart requests
  | "stale"             // pushed data exists but exceeded CANDLE_TTL_MS — router falls through
  | "non-contributing"  // no data for this series, but the MT5 feed IS connected
                        // (the EA is pushing other series) — just not this one
  | "unavailable";      // no data for this series AND the MT5 feed is not connected
                        // at all (the bridge candle feed mechanism is offline)

export interface Mt5SeriesStatusEntry {
  symbol: string;
  timeframe: string;
  status: Mt5SeriesContributionStatus;
  barCount: number;
  ageMs: number | null;
  updatedAt: string | null;
  /** Serving writer's bridge id; null = unattributed partition is serving.
   *  OPTIONAL-additive so pre-existing constructors of this shape (admin
   *  diagnostics fallback entries) keep compiling; entries built by
   *  getMt5AllSeriesStatus always populate it. */
  bridgeConnectionId?: number | null;
}

/**
 * Returns the contribution status of every symbol+timeframe series the EA has
 * pushed since server start — ONE entry per symbol|timeframe, reflecting the
 * SERVING partition (most recent writer), so the watchdog/diagnostics see the
 * same series a read would return. Never fabricates entries — an absent series
 * is simply absent from the list.
 */
export function getMt5AllSeriesStatus(now: number = Date.now()): Mt5SeriesStatusEntry[] {
  const out: Mt5SeriesStatusEntry[] = [];
  for (const [key, partitions] of candleStore.entries()) {
    const s = servingSeries(partitions);
    if (!s) continue;
    const [symbol, timeframe] = key.split("|") as [string, string];
    const ageMs = now - s.updatedAt;
    const fresh = ageMs <= CANDLE_TTL_MS;
    const hasBars = s.candles.length > 0;
    // Separate the two states the old code conflated:
    //   aged-out (age > TTL)        → "stale"            (router falls through)
    //   fresh push but empty series → "non-contributing" (connected, no usable
    //                                  bars yet) — NOT "stale"
    //   fresh push with bars        → "contributing"
    // A feed-stopped watchdog must gate on ageMs > CANDLE_TTL_MS, never on the
    // status string alone, because "non-contributing" is a fresh (live) push.
    const status: Mt5SeriesContributionStatus =
      !fresh ? "stale" : hasBars ? "contributing" : "non-contributing";
    out.push({
      symbol,
      timeframe,
      status,
      barCount: s.candles.length,
      ageMs,
      updatedAt: new Date(s.updatedAt).toISOString(),
      bridgeConnectionId: s.bridgeConnectionId,
    });
  }
  return out;
}

export class Mt5Provider implements DataProvider {
  name = "mt5";

  // Timeframe is AUTHORITATIVE: a series is only returned for the exact
  // symbol+timeframe it was pushed under, and only while fresh. A stale or
  // absent series returns [] so the router falls through to the next provider.
  // Legacy DataProvider surface — bridge-unscoped: serves the most-recent
  // writer via readMt5Candles and drops the identity (callers needing identity
  // use readMt5Candles directly).
  async getCandles(symbol: string, timeframe: string, limit: number): Promise<Candle[]> {
    return readMt5Candles(symbol, timeframe, limit).candles;
  }

  // Legacy DataProvider surface — bridge-unscoped: serves the most recent
  // writer's quote (chart/scanner/router reads). Execution-bound readers use
  // readMt5Quote with the bridge identity instead.
  async getQuote(symbol: string): Promise<MarketQuote> {
    const q = readMt5Quote(symbol);
    if (q) return q.quote;
    return { symbol, timestamp: new Date().toISOString() };
  }

  async isConnected(): Promise<boolean> {
    // Connected when the EA pushed candles or a quote within the freshness
    // window — i.e. the broker feed is actively flowing. Until the EA's
    // CopyRates push ships, nothing calls the update fns and this stays false.
    return lastUpdate > 0 && Date.now() - lastUpdate < FEED_FRESH_MS;
  }
}

/** Server wall-clock ms when the quote `getQuote` would serve for this symbol
 *  was pushed (its receive time); null when nothing is stored. Lets the router
 *  label a push older than MT5_FEED_FRESH_MS STALE instead of LIVE_TICK. */
export function readServingQuoteReceivedAtMs(symbol: string): number | null {
  const q = servingQuote(quoteStore.get(normalizeSymbolKey(symbol)));
  return q ? q.updatedAt : null;
}

export const mt5Provider = new Mt5Provider();
