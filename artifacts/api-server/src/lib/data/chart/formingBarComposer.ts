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
//   We fold the tick BID, matching the mt5_broker closed-candle basis (BID), so
//   the synthesized tip sits on the same basis as the closed bars beneath it
//   (no half-spread seam). The composer is therefore scoped at append time to
//   the mt5_broker source only.

import { EventEmitter } from "node:events";
import { CHART_TIMEFRAMES, timeframeMs, type ChartTimeframe } from "./timeframes.js";
import { normalizeSymbolKey } from "../providers/mt5Provider.js";
import { MARKET_FROZEN_BROKER_STALE_MS, MARKET_FROZEN_WALL_FRESH_MS } from "../freshness.js";

/** A single synthesized forming bar for one (symbol, timeframe) bucket. */
export interface FormingBarState {
  /** Interval-open epoch ms (floor(tickMs / intervalMs) * intervalMs). */
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

// Map key: `${symbolKey}|${timeframe}` → forming bar state.
const store = new Map<string, FormingBarState>();

function stateKey(symbolKey: string, timeframe: ChartTimeframe): string {
  return `${symbolKey}|${timeframe}`;
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
}

// symbolKey → last tick seen (across all timeframes).
const lastTickBySymbol = new Map<string, LastTickInfo>();

// ── Tick notification bus ──────────────────────────────────────────────────
// One in-process emitter keyed by symbolKey. The SSE handler subscribes for the
// symbol it is streaming and, on each notification, pulls the current-interval
// snapshot for its own timeframe (decoupling fold cardinality from subscribers).
class FormingBarBus {
  private readonly emitter = new EventEmitter();
  constructor() {
    // Each connected chart SSE client adds one listener for its symbol. Raise
    // the ceiling well above the default 10; listeners are removed on close.
    this.emitter.setMaxListeners(1000);
  }
  private key(symbolKey: string): string {
    return `forming:${symbolKey}`;
  }
  on(symbolKey: string, listener: () => void): void {
    this.emitter.on(this.key(symbolKey), listener);
  }
  off(symbolKey: string, listener: () => void): void {
    this.emitter.off(this.key(symbolKey), listener);
  }
  emit(symbolKey: string): void {
    try {
      this.emitter.emit(this.key(symbolKey));
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
 *
 * Best-effort: never throws into the caller (EA ingest path).
 */
export function foldFormingTick(
  symbol: string,
  bid: number,
  brokerTimeMs: number | null,
  nowWallMs: number = Date.now(),
): void {
  if (!Number.isFinite(bid) || bid <= 0) return;
  const symbolKey = normalizeSymbolKey(symbol);
  if (!symbolKey) return;
  const bucketTime = brokerTimeMs != null && Number.isFinite(brokerTimeMs) ? brokerTimeMs : nowWallMs;

  // Record the raw last tick (exact broker time, not interval-floored) so the
  // market-frozen / closed indicator can report the real last-quote time and
  // measure broker-time staleness. Display/telemetry only.
  lastTickBySymbol.set(symbolKey, {
    brokerTimeMs: brokerTimeMs != null && Number.isFinite(brokerTimeMs) ? brokerTimeMs : null,
    wallMs: nowWallMs,
    bid,
  });

  for (const tf of CHART_TIMEFRAMES) {
    const intervalMs = timeframeMs(tf);
    const openMs = Math.floor(bucketTime / intervalMs) * intervalMs;
    const k = stateKey(symbolKey, tf);
    const prev = store.get(k);
    if (!prev || prev.openMs !== openMs) {
      // New interval (or first tick) → open a fresh bar at this tick's price.
      store.set(k, {
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
    }
  }
  formingBarBus.emit(symbolKey);
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
): FormingBarSnapshot | null {
  const symbolKey = normalizeSymbolKey(symbol);
  if (!symbolKey) return null;
  const state = store.get(stateKey(symbolKey, timeframe));
  if (!state) return null;
  const intervalMs = timeframeMs(timeframe);
  const currentOpenMs = Math.floor(nowWallMs / intervalMs) * intervalMs;
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
): number | null {
  const snap = getFormingBar(symbol, timeframe, nowWallMs);
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
): MarketFreshness | null {
  const symbolKey = normalizeSymbolKey(symbol);
  if (!symbolKey) return null;
  const last = lastTickBySymbol.get(symbolKey);
  if (!last) return null;
  const brokerStaleMs =
    last.brokerTimeMs != null ? Math.max(0, nowWallMs - last.brokerTimeMs) : null;
  const wallStaleMs = Math.max(0, nowWallMs - last.wallMs);
  // Closed market, NOT broken feed: broker time stale AND ticks still arriving.
  // A dead feed (no wall ticks) must NOT read as "market closed".
  const marketFrozen =
    brokerStaleMs != null &&
    brokerStaleMs > MARKET_FROZEN_BROKER_STALE_MS &&
    wallStaleMs <= MARKET_FROZEN_WALL_FRESH_MS;
  return {
    lastBrokerTimeMs: last.brokerTimeMs,
    lastTickWallMs: last.wallMs,
    brokerStaleMs,
    wallStaleMs,
    marketFrozen,
  };
}

/** Test-only: clear all forming-bar state. */
export function __resetFormingBarStore(): void {
  store.clear();
  lastTickBySymbol.clear();
}
