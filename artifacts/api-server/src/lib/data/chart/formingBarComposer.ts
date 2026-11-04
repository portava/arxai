// ARX Native Chart — Task #496: real-time forming-bar composer.
//
// PURPOSE
//   The EA bridge streams ticks (~2s) which land in the quote store but never
//   fold into the served candle tip, so the chart's newest bar only advances
//   when a CLOSED candle arrives one interval later. This composer synthesizes
//   the still-forming (current-interval) bar from those live ticks so the chart
//   tip ticks in real time, while the authoritative closed CANDLE that arrives
//   later cleanly replaces it (no orphan duplicate).
//
// HONESTY / SAFETY POSTURE (display + telemetry ONLY)
//   - In-memory only. A forming bar is NEVER written to broker_candles /
//     market_candles or any durable store — it carries isForming=true and is
//     a synthesized tip, not provider truth.
//   - It NEVER feeds analysis / Ruby / chart-intelligence / scoring: the chart
//     data service appends it OPT-IN for the display route only; every analysis
//     caller keeps consuming closed bars.
//   - No execution-path involvement: this touches no arx_live_* table, no
//     18-gate evaluator, no balance/fill. Pure market-data display telemetry.
//   - Freeze, never fabricate motion: the bar only mutates when a REAL tick
//     folds in. When ticks go silent the bar simply stops changing; the shared
//     freshness layer reads the tick age and downgrades the tip to stale.
//
// PRICE BASIS
//   Each tick folds on the basis its own provider publishes, and the tip is
//   appended beneath closed bars from that SAME provider, so the tip never sits
//   on a different basis than the bars under it (no half-spread seam):
//     - mt5_broker → tick BID under BID closed candles
//     - Deriv WS   → tick quote under Deriv closed candles
//   The composer itself is provider-agnostic; sourcing is wired per provider
//   (EA ingest, derivFormingBridge). Every store and reader is scoped by the
//   exact provider, including the SSE event bus and freshness clock.
//
// BRIDGE PARTITION
//   Two traders' bridges can stream the same symbol from different brokers.
//   Every MT5 store entry is also keyed by the writing bridge connection (null
//   = unattributed writer), so one broker's ticks never fold into another
//   broker's tip or freshness clock. A reader names the partition it serves
//   (the chart passes the serving bridge of its bars); a reader that names none
//   gets the most recently ticking partition, the platform-wide behaviour.
//
// BUCKETS
//   Bars are bucketed on the broker grid (brokerBucket.ts) with the bridge's
//   measured clock offset, so a D1/H4/W1/MN1 tip opens exactly where the broker
//   bar under it opens.

import { EventEmitter } from "node:events";
import { CHART_TIMEFRAMES, type ChartTimeframe } from "./timeframes.js";
import { brokerBucketOpenMs } from "./brokerBucket.js";
import { normalizeSymbolKey } from "../providers/mt5Provider.js";
import { resolveDerivSymbol } from "../providers/derivProvider.js";
import { MARKET_FROZEN_BROKER_STALE_MS, MARKET_FROZEN_WALL_FRESH_MS } from "../freshness.js";

/**
 * The store key for a symbol, collapsing provider aliases onto ONE bucket.
 *
 * A Deriv synthetic is addressed several ways across the app — the ARX code
 * ("V75"), the Deriv WS id ("R_75") and the display name ("Volatility 75
 * Index"). The tick folds in under whichever name the provider reports while
 * the chart reads under whichever name the client requested, so a plain
 * uppercase key would file them in different buckets and the chart would find
 * no tip. Resolving to the canonical ARX code first makes fold and read meet.
 * Non-synthetic symbols are unaffected (plain normalized key).
 */
function formingKey(symbol: string): string {
  const raw = normalizeSymbolKey(symbol);
  if (!raw) return "";
  return resolveDerivSymbol(raw)?.symbol ?? raw;
}

/** A single synthesized forming bar for one (symbol, timeframe) bucket. */
export type FormingTickSource = "mt5_broker" | "deriv" | "deriv_public";
type StoreSource = FormingTickSource | "unknown";

export function isFormingTickSource(value: unknown): value is FormingTickSource {
  return value === "mt5_broker" || value === "deriv" || value === "deriv_public";
}

/**
 * Which writer's partition: a bridge connection id, or null for ticks with no
 * attributed bridge (Deriv, an unattributed EA). "latest" (read side only)
 * selects whichever partition ticked most recently.
 */
export type FormingPartition = number | null;
export type FormingPartitionSelector = FormingPartition | "latest";

export interface FormingBarState {
  /** Exact tick provider; never inferred from the symbol. */
  source: StoreSource;
  /** The writing bridge connection (null = unattributed). */
  bridgeConnectionId: FormingPartition;
  /** Broker clock offset (broker − UTC, ms) the bucket was computed with. */
  brokerOffsetMs: number;
  /** Interval-open epoch ms on the broker grid (brokerBucketOpenMs). */
  openMs: number;
  open: number;
  high: number;
  low: number;
  close: number;
  /** Wall-clock ms when the most recent tick folded in (silence detection). */
  lastTickWallMs: number;
  /** Number of ticks folded into THIS interval's bar (advisory). */
  tickCount: number;
}

/** Public snapshot of the forming bar for the CURRENT interval, or null. */
export interface FormingBarSnapshot extends FormingBarState {
  symbolKey: string;
  timeframe: ChartTimeframe;
}

// Provider is part of every key: another venue cannot overwrite OHLC or age.
// The unknown namespace preserves unidentified diagnostics, but no HTTP/SSE
// production reader accepts it as a live source.
const store = new Map<string, FormingBarState>();

function sourceSymbolKey(symbolKey: string, source: StoreSource): string {
  return `${source}|${symbolKey}`;
}

function partitionSegment(partition: FormingPartition): string {
  return partition == null ? "b:none" : `b:${partition}`;
}

function partitionKey(symbolKey: string, source: StoreSource, partition: FormingPartition): string {
  return `${sourceSymbolKey(symbolKey, source)}|${partitionSegment(partition)}`;
}

function stateKey(symbolKey: string, timeframe: ChartTimeframe, source: StoreSource, partition: FormingPartition): string {
  return `${partitionKey(symbolKey, source, partition)}|${timeframe}`;
}

// source + symbolKey → the partition that ticked most recently ("latest" reads).
const latestPartitionBySymbol = new Map<string, FormingPartition>();

function resolvePartition(
  symbolKey: string,
  source: StoreSource,
  selector: FormingPartitionSelector,
): FormingPartition | undefined {
  if (selector !== "latest") return selector;
  const k = sourceSymbolKey(symbolKey, source);
  return latestPartitionBySymbol.has(k) ? latestPartitionBySymbol.get(k)! : undefined;
}

// ── Bounded memory ─────────────────────────────────────────────────────────
// Entries no tick has touched for this long are evicted (a symbol nobody
// streams any more, a bridge that disconnected). A tip that old is frozen and
// would be reported stale anyway; after eviction the reader simply has no tip
// and falls back to closed bars. The sweep runs at most once a minute, on fold.
export const FORMING_STATE_TTL_MS = 30 * 60_000;
const SWEEP_EVERY_MS = 60_000;
let lastSweepWallMs = 0;

function sweepExpired(nowWallMs: number): void {
  if (Math.abs(nowWallMs - lastSweepWallMs) < SWEEP_EVERY_MS) return;
  lastSweepWallMs = nowWallMs;
  const cutoff = nowWallMs - FORMING_STATE_TTL_MS;
  for (const [k, v] of store) if (v.lastTickWallMs < cutoff) store.delete(k);
  for (const [k, v] of lastTickBySymbol) if (v.wallMs < cutoff) lastTickBySymbol.delete(k);
  for (const [k, partition] of latestPartitionBySymbol) {
    const [source, symbolKey] = k.split("|") as [StoreSource, string];
    if (!lastTickBySymbol.has(partitionKey(symbolKey, source, partition))) latestPartitionBySymbol.delete(k);
  }
}

/**
 * The most recent tick seen for a symbol, independent of interval bucketing.
 * The "market frozen / closed" indicator needs the EXACT broker quote time of
 * the last tick (not the interval-floored openMs) to report "last quote <time>"
 * and to measure broker-time staleness. Display/telemetry only.
 */
export interface LastTickInfo {
  /** Exact broker quote time (epoch ms) of the last tick, or null when absent. */
  brokerTimeMs: number | null;
  /** Wall-clock ms when that tick folded in (receive-time). */
  wallMs: number;
  /** Last tick BID. */
  bid: number;
  /**
   * Wall-clock ms of the most recent tick whose bid OR broker time differed
   * from the tick before it (the quote observably moved), or null when no
   * movement has been observed yet (a single tick, or only identical replays).
   * A closed market replays one frozen quote; a quote that keeps changing is a
   * trading market whatever its broker clock says.
   */
  quoteMovedWallMs: number | null;
  /**
   * Wall-clock ms since which the current quote (bid + broker time) has been
   * observed unchanged: the tick that last moved it, or the first tick seen.
   * Clock-independent measure of how long a replayed quote has been held.
   */
  quoteHeldSinceWallMs: number;
}

// source + symbolKey + partition → last tick seen (across all timeframes).
const lastTickBySymbol = new Map<string, LastTickInfo>();

// ── Tick notification bus ──────────────────────────────────────────────────
// One in-process emitter keyed by source + symbolKey. The SSE handler subscribes
// for the symbol it is streaming; each notification names the partition that
// ticked, and the handler pulls the current-interval snapshot of the partition
// it serves for its own timeframe (decoupling fold cardinality from subscribers).
class FormingBarBus {
  private readonly emitter = new EventEmitter();
  constructor() {
    // Each connected chart SSE client adds one listener for its symbol. Raise
    // the ceiling well above the default 10; listeners are removed on close.
    this.emitter.setMaxListeners(1000);
  }
  private key(symbolKey: string, source: StoreSource): string {
    return `forming:${sourceSymbolKey(formingKey(symbolKey), source)}`;
  }
  on(symbolKey: string, listener: (partition: FormingPartition) => void, source: StoreSource = "unknown"): void {
    this.emitter.on(this.key(symbolKey, source), listener);
  }
  off(symbolKey: string, listener: (partition: FormingPartition) => void, source: StoreSource = "unknown"): void {
    this.emitter.off(this.key(symbolKey, source), listener);
  }
  emit(symbolKey: string, source: StoreSource, partition: FormingPartition = null): void {
    try {
      this.emitter.emit(this.key(symbolKey, source), partition);
    } catch {
      // Advisory bus — a misbehaving listener must never propagate into the
      // EA ingest path that folds the tick.
    }
  }
}

export const formingBarBus = new FormingBarBus();

/**
 * Fold one live tick into the forming bar of EVERY canonical timeframe.
 *
 * @param symbol      Raw broker/provider symbol (normalized internally).
 * @param bid         Tick BID price (matches mt5_broker candle basis).
 * @param brokerTimeMs Broker tick time (epoch ms) — used for interval bucketing
 *                    so the bucket aligns to the broker's bar boundaries. Falls
 *                    back to wall clock when absent.
 * @param nowWallMs   Server wall-clock ms — used for silence/freshness, so the
 *                    tip freezes on real receive-time silence (not broker time).
 * @param writer      The writing bridge (partition) and its measured broker
 *                    clock offset (broker − UTC ms; buckets use the broker grid).
 *
 * Best-effort: never throws into the caller (EA ingest path).
 */
export function foldFormingTick(
  symbol: string,
  bid: number,
  brokerTimeMs: number | null,
  nowWallMs: number = Date.now(),
  source: StoreSource = "unknown",
  writer: { bridgeConnectionId?: number | null; brokerOffsetMs?: number | null } = {},
): void {
  if (!Number.isFinite(bid) || bid <= 0) return;
  const symbolKey = formingKey(symbol);
  if (!symbolKey) return;
  const bucketTime = brokerTimeMs != null && Number.isFinite(brokerTimeMs) ? brokerTimeMs : nowWallMs;
  const partition: FormingPartition =
    typeof writer.bridgeConnectionId === "number" && Number.isFinite(writer.bridgeConnectionId)
      ? writer.bridgeConnectionId
      : null;
  const brokerOffsetMs =
    typeof writer.brokerOffsetMs === "number" && Number.isFinite(writer.brokerOffsetMs) ? writer.brokerOffsetMs : 0;
  sweepExpired(nowWallMs);

  // Record the raw last tick (exact broker time, not interval-floored) so the
  // market-frozen / closed indicator can report the real last-quote time and
  // measure broker-time staleness. Display/telemetry only.
  const tickKey = partitionKey(symbolKey, source, partition);
  const prevTick = lastTickBySymbol.get(tickKey);
  const tickBrokerTimeMs = brokerTimeMs != null && Number.isFinite(brokerTimeMs) ? brokerTimeMs : null;
  const quoteMoved = prevTick != null && (prevTick.bid !== bid || prevTick.brokerTimeMs !== tickBrokerTimeMs);
  lastTickBySymbol.set(tickKey, {
    brokerTimeMs: tickBrokerTimeMs,
    wallMs: nowWallMs,
    bid,
    quoteMovedWallMs: quoteMoved ? nowWallMs : prevTick?.quoteMovedWallMs ?? null,
    quoteHeldSinceWallMs: quoteMoved || prevTick == null ? nowWallMs : prevTick.quoteHeldSinceWallMs,
  });
  latestPartitionBySymbol.set(sourceSymbolKey(symbolKey, source), partition);

  for (const tf of CHART_TIMEFRAMES) {
    const openMs = brokerBucketOpenMs(bucketTime, tf, brokerOffsetMs);
    const k = stateKey(symbolKey, tf, source, partition);
    const prev = store.get(k);
    if (!prev || prev.openMs !== openMs) {
      // New interval (or first tick) → open a fresh bar at this tick's price.
      store.set(k, {
        source,
        bridgeConnectionId: partition,
        brokerOffsetMs,
        openMs,
        open: bid,
        high: bid,
        low: bid,
        close: bid,
        lastTickWallMs: nowWallMs,
        tickCount: 1,
      });
    } else {
      prev.high = Math.max(prev.high, bid);
      prev.low = Math.min(prev.low, bid);
      prev.close = bid;
      prev.lastTickWallMs = nowWallMs;
      prev.tickCount += 1;
      prev.brokerOffsetMs = brokerOffsetMs;
    }
  }
  formingBarBus.emit(symbolKey, source, partition);
}

/**
 * The partition a live reader should follow: its own bridge when that bridge
 * has ticked this symbol, else `sticky` (the partition it already follows)
 * while that one keeps ticking, else the most recently ticking partition.
 * undefined when no partition has ticked. Display/telemetry only.
 */
export function resolveFormingPartition(
  symbol: string,
  source: StoreSource,
  preferred: FormingPartition,
  sticky?: FormingPartition,
  nowWallMs: number = Date.now(),
  stickyFreshMs: number = 60_000,
): FormingPartition | undefined {
  const symbolKey = formingKey(symbol);
  if (!symbolKey) return undefined;
  if (preferred != null && lastTickBySymbol.has(partitionKey(symbolKey, source, preferred))) return preferred;
  if (sticky !== undefined) {
    const last = lastTickBySymbol.get(partitionKey(symbolKey, source, sticky));
    if (last && nowWallMs - last.wallMs <= stickyFreshMs) return sticky;
  }
  return resolvePartition(symbolKey, source, "latest");
}

/**
 * The forming bar for the CURRENT interval of (symbol, timeframe), or null.
 *
 * Returns null when the stored bar belongs to a PRIOR interval (the interval
 * rolled over and no new tick has folded yet) — in that case there is no live
 * tip for the current interval and the caller falls back to closed bars. A
 * frozen-but-current bar (ticks went silent within the same interval) IS
 * returned; the caller uses the tick age to mark it stale rather than dropping
 * it, so the last-known tip stays visible with an honest staleness badge.
 */
export function getFormingBar(
  symbol: string,
  timeframe: ChartTimeframe,
  nowWallMs: number = Date.now(),
  source: StoreSource = "unknown",
  partition: FormingPartitionSelector = "latest",
): FormingBarSnapshot | null {
  const symbolKey = formingKey(symbol);
  if (!symbolKey) return null;
  const resolved = resolvePartition(symbolKey, source, partition);
  if (resolved === undefined) return null;
  const state = store.get(stateKey(symbolKey, timeframe, source, resolved));
  if (!state) return null;
  const currentOpenMs = brokerBucketOpenMs(nowWallMs, timeframe, state.brokerOffsetMs);
  if (state.openMs !== currentOpenMs) return null;
  return { ...state, symbolKey, timeframe };
}

/**
 * Milliseconds since the last tick folded into the CURRENT-interval forming bar
 * of (symbol, timeframe), or null when there is no current-interval bar.
 */
export function getFormingTickAgeMs(
  symbol: string,
  timeframe: ChartTimeframe,
  nowWallMs: number = Date.now(),
  source: StoreSource = "unknown",
  partition: FormingPartitionSelector = "latest",
): number | null {
  const snap = getFormingBar(symbol, timeframe, nowWallMs, source, partition);
  if (!snap) return null;
  return Math.max(0, nowWallMs - snap.lastTickWallMs);
}

/** Broker-time freshness verdict for the market-frozen / closed-market indicator. */
export interface MarketFreshness {
  /** Exact broker quote time (epoch ms) of the last tick, or null when unknown. */
  lastBrokerTimeMs: number | null;
  /** Wall-clock ms when the last tick folded. */
  lastTickWallMs: number;
  /** now - lastBrokerTimeMs (ms), or null when the broker time is unknown. */
  brokerStaleMs: number | null;
  /** now - lastTickWallMs (ms): how long since ANY tick arrived. */
  wallStaleMs: number;
  /**
   * The market is frozen/closed: the last tick's BROKER time lags server-now by
   * more than MARKET_FROZEN_BROKER_STALE_MS *AND* ticks are STILL arriving
   * (wallStaleMs ≤ MARKET_FROZEN_WALL_FRESH_MS). The wall-fresh requirement is
   * what separates a closed market (EA still replays the frozen last quote →
   * fresh wall ticks, stale broker time) from a broken/dead feed (no ticks at
   * all → wall-stale). Derived purely from real per-tick staleness —
   * calendar-independent (covers holidays / broker hours). Display/telemetry
   * only; never an execution gate.
   */
  marketFrozen: boolean;
  /**
   * Wall-clock ms the quote last observably moved (new bid or new broker
   * time), or null when no movement has been observed. Positive evidence that
   * the market is trading right now — independent of the broker clock.
   */
  quoteMovedWallMs: number | null;
}

/**
 * Broker-time freshness for a symbol's most recent tick, or null when no tick
 * has ever been folded (honest unknown — the caller must assert nothing). Used
 * by the chart "market closed / frozen quote" indicator: when the broker keeps
 * replaying its last quote (closed market), the broker time goes stale while
 * wall-clock ticks may still arrive, so a still-forming bar reads as
 * closed-market rather than a broken feed.
 */
export function getFeedFreshness(
  symbol: string,
  nowWallMs: number = Date.now(),
  source: StoreSource = "unknown",
  partition: FormingPartitionSelector = "latest",
): MarketFreshness | null {
  const symbolKey = formingKey(symbol);
  if (!symbolKey) return null;
  const resolved = resolvePartition(symbolKey, source, partition);
  if (resolved === undefined) return null;
  const last = lastTickBySymbol.get(partitionKey(symbolKey, source, resolved));
  if (!last) return null;
  const brokerStaleMs =
    last.brokerTimeMs != null ? Math.max(0, nowWallMs - last.brokerTimeMs) : null;
  const wallStaleMs = Math.max(0, nowWallMs - last.wallMs);
  // Closed market, NOT broken feed: broker time stale AND ticks still arriving.
  // A dead feed (no wall ticks) must NOT read as "market closed". A quote that
  // observably moved (new bid or new broker time) within the frozen window is
  // a trading market whose broker clock is simply behind server UTC (no zone
  // conversion is attempted on ingest) — never "closed".
  const quoteMovedRecently =
    last.quoteMovedWallMs != null && nowWallMs - last.quoteMovedWallMs <= MARKET_FROZEN_BROKER_STALE_MS;
  // A broker clock AHEAD of server UTC clamps brokerStaleMs to 0, so the
  // broker clock alone could never flag a closed market. The quote itself is
  // the clock-independent signal: the same bid + broker time replayed for
  // longer than the frozen window while ticks keep arriving.
  const quoteHeldMs = nowWallMs - last.quoteHeldSinceWallMs;
  const marketFrozen =
    wallStaleMs <= MARKET_FROZEN_WALL_FRESH_MS &&
    !quoteMovedRecently &&
    ((brokerStaleMs != null && brokerStaleMs > MARKET_FROZEN_BROKER_STALE_MS) ||
      quoteHeldMs > MARKET_FROZEN_BROKER_STALE_MS);
  return {
    lastBrokerTimeMs: last.brokerTimeMs,
    lastTickWallMs: last.wallMs,
    brokerStaleMs,
    wallStaleMs,
    marketFrozen,
    quoteMovedWallMs: last.quoteMovedWallMs,
  };
}

/** Test-only: clear all forming-bar state. */
export function __resetFormingBarStore(): void {
  store.clear();
  lastTickBySymbol.clear();
  latestPartitionBySymbol.clear();
  lastSweepWallMs = 0;
}

/** Test-only: entry counts, to check the stores stay bounded. */
export function __formingStoreSizes(): { bars: number; ticks: number; latest: number } {
  return { bars: store.size, ticks: lastTickBySymbol.size, latest: latestPartitionBySymbol.size };
}
