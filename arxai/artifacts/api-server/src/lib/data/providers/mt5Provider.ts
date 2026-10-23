import type { Candle, DataProvider, MarketQuote } from "../types.js";
import { MT5_CANDLE_TTL_MS, MT5_FEED_FRESH_MS } from "../freshness.js";

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
//     rate-limited logger.warn (once per symbol per hour). An unattributed
//     writer alongside one attributed bridge is NOT flagged as contention —
//     the unattributed writer's identity is unknown and may be the same
//     physical bridge; claiming "multi-bridge" there would be fabrication.
//
// FRESHNESS:
//   Each series stores `updatedAt`. Reads return [] for a series older than
//   CANDLE_TTL_MS (so the router falls through / refuses rather than serving
//   stale broker bars). isConnected() is true when ANY series OR quote is
//   fresh within FEED_FRESH_MS — i.e. the EA is actively pushing.

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

// Contention warn rate limit: once per SYMBOL per hour.
const CONTENTION_WARN_INTERVAL_MS = 60 * 60_000;

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

// symbol|timeframe → (bridgeKey → series). Partitions are hard walls: no read
// or write path may merge candles across two partition entries.
const candleStore = new Map<string, Map<string, CandleSeries>>();
const quoteStore = new Map<string, { quote: MarketQuote; updatedAt: number }>();
let lastUpdate = 0;
let writeCounter = 0;
// symbol → last contention-warn emit time (rate limit state).
const contentionWarnAt = new Map<string, number>();

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
 * Push a candle series for an exact symbol+timeframe. Replaces the stored series
 * FOR THAT WRITER'S PARTITION only (the EA sends the latest window each push).
 * Stamps freshness. The legacy 3-arg form (no bridge identity) still works and
 * writes the unattributed partition, so un-threaded callers compile unchanged.
 */
export function updateCandlesFromMT5(
  symbol: string,
  candles: Candle[],
  timeframe: string = DEFAULT_TIMEFRAME,
  bridge?: Mt5BridgeIdentity | null,
): void {
  const partitions = partitionsFor(symbol, timeframe);
  partitions.set(bridgeKeyOf(bridge), {
    candles,
    updatedAt: Date.now(),
    writeSeq: ++writeCounter,
    bridgeConnectionId: bridge?.bridgeConnectionId ?? null,
    userId: bridge?.userId ?? null,
  });
  lastUpdate = Date.now();
}

// The most bars a single series retains. The v2 bridge pushes ONE closed bar
// per CANDLE event (unlike the v1 sync path, which replaces the whole window),
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
  const byTime = new Map<string, Candle>();
  if (existing) {
    for (const c of existing.candles) byTime.set(c.time, c);
  }
  // Last-write-wins on identical bar time (an idempotent re-send is a no-op).
  byTime.set(candle.time, candle);
  const merged = Array.from(byTime.values()).sort((a, b) =>
    a.time < b.time ? -1 : a.time > b.time ? 1 : 0,
  );
  const capped =
    merged.length > MAX_MERGED_BARS ? merged.slice(-MAX_MERGED_BARS) : merged;
  partitions.set(bKey, {
    candles: capped,
    updatedAt: Date.now(),
    writeSeq: ++writeCounter,
    bridgeConnectionId: bridge?.bridgeConnectionId ?? null,
    userId: bridge?.userId ?? null,
  });
  lastUpdate = Date.now();
}

export function updateQuoteFromMT5(symbol: string, quote: MarketQuote): void {
  quoteStore.set(normalizeSymbolKey(symbol), { quote, updatedAt: Date.now() });
  lastUpdate = Date.now();
}

/** Test/diagnostic helper — clear all pushed data + contention-warn state. */
export function __resetMt5ProviderStore(): void {
  candleStore.clear();
  quoteStore.clear();
  contentionWarnAt.clear();
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
}

const EMPTY_READ: Mt5CandleRead = {
  candles: [],
  bridgeConnectionId: null,
  userId: null,
  contention: false,
  contendingBridgeIds: [],
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
    const lastWarn = contentionWarnAt.get(symKey);
    if (lastWarn == null || now - lastWarn >= CONTENTION_WARN_INTERVAL_MS) {
      contentionWarnAt.set(symKey, now);
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
  const q = quoteStore.get(normalizeSymbolKey(symbol));
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

  async getQuote(symbol: string): Promise<MarketQuote> {
    const q = quoteStore.get(normalizeSymbolKey(symbol));
    if (q && Date.now() - q.updatedAt <= CANDLE_TTL_MS) return q.quote;
    return { symbol, timestamp: new Date().toISOString() };
  }

  async isConnected(): Promise<boolean> {
    // Connected when the EA pushed candles or a quote within the freshness
    // window — i.e. the broker feed is actively flowing. Until the EA's
    // CopyRates push ships, nothing calls the update fns and this stays false.
    return lastUpdate > 0 && Date.now() - lastUpdate < FEED_FRESH_MS;
  }
}

export const mt5Provider = new Mt5Provider();
