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
//   (EA ingest, derivFormingBridge) and the append gate asks only whether a real
//   current-interval tick exists.

import { EventEmitter } from "node:events";
import { CHART_TIMEFRAMES, timeframeMs, type ChartTimeframe } from "./timeframes.js";
import { normalizeSymbolKey } from "../providers/mt5Provider.js";
import { resolveDerivSymbol } from "../providers/derivProvider.js";
import {
  FORMING_TIP_LIVE_MS,
  MARKET_FROZEN_BROKER_STALE_MS,
  MARKET_FROZEN_WALL_FRESH_MS,
} from "../freshness.js";

/**
 * The quote stream a tick was folded from. Basis coherence (the per-provider
 * pairing documented above) is enforced with this identity: a bar never mixes
 * ticks from two providers, and the chart data service refuses to sit a tip
 * under closed bars served by a DIFFERENT provider family. "unattributed" is
 * the legacy/test default and is exempt from both rules.
 */
export type FormingTickProvider = "mt5_broker" | "deriv" | "assistant_real" | "unattributed";

/**
 * Cross-provider bar ownership: push streams (EA ~2s, Deriv WS ~1-2s) outrank
 * the assistant REST poll (~15s), so a low-cadence assistant fold can never
 * steal a bar a live push stream is actively ticking, while a push stream
 * takes an assistant-owned bar over immediately. Equal ranks (broker vs Deriv
 * on a synthetic both stream) never mix either — the bar's current owner keeps
 * it while its ticks are fresh.
 */
const PROVIDER_RANK: Record<FormingTickProvider, number> = {
  mt5_broker: 2,
  deriv: 2,
  unattributed: 2,
  assistant_real: 1,
};

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
  /** The quote stream that owns this bar (basis coherence — never mixed). */
  provider: FormingTickProvider;
  /**
   * openMs was bucketed from a provider/broker timestamp (true) or from the
   * wall receive time (false, no broker time on the tick). The offset-aware
   * read applies the clock-offset correction ONLY to provider-bucketed bars —
   * a wall-bucketed bar is already in the read's own clock domain.
   */
  bucketedByProviderTime: boolean;
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

// ── Provider-clock offset estimator (R3 clock-domain fix) ──────────────────
// The fold buckets by PROVIDER time (so the tip's openMs aligns with the
// provider's own closed-bar boundaries), but the read used to compare that
// bucket against raw server WALL time — a broker clock offset >= one interval
// made the tip permanently unreadable, and even a small offset blanked it near
// every boundary. The read is therefore made offset-aware: a per-symbol EWMA
// of (brokerTimeMs - nowWallMs) across recent folds estimates the provider's
// clock offset, and getFormingBar maps wall-now into the provider's clock
// domain before flooring.
//
// HONESTY GUARDS (the estimate may never resurrect a dead bar):
//   - Only ADVANCING broker times contribute samples. A closed market replays
//     one frozen broker timestamp — those replays contribute nothing, so a
//     frozen quote can never steer the read clock backwards onto its own dead
//     interval and read as "current" forever.
//   - The estimate is unusable until FORMING_CLOCK_OFFSET_MIN_SAMPLES advancing
//     samples arrived (a single seed sample carries unknown staleness).
//   - The correction is clamped: an estimate beyond the max is treated as
//     bogus and the read falls back to raw wall time (legacy behavior).
//   - Estimates are per-provider: a provider change reseeds (Deriv epoch, EA
//     broker time and assistant asOf are DIFFERENT clock domains).
//   - Silence freshness (lastTickWallMs) and the MARKET_FROZEN indicator stay
//     on PURE wall / raw broker staleness — never offset-corrected.
interface ClockOffsetEstimate {
  /** EWMA of (brokerTimeMs - nowWallMs) over advancing-broker-time folds. */
  offsetMs: number;
  /** Advancing samples folded in (seed counts as 1). */
  samples: number;
  /** Highest broker time observed — only strictly newer times sample. */
  lastBrokerTimeMs: number;
  /** Clock domain the estimate belongs to. */
  provider: FormingTickProvider;
}

const clockOffsetBySymbol = new Map<string, ClockOffsetEstimate>();

const FORMING_CLOCK_OFFSET_EWMA_ALPHA = 0.2;
/** Advancing samples required before the offset may correct a read. */
export const FORMING_CLOCK_OFFSET_MIN_SAMPLES = 3;
/** Beyond this the estimate is bogus — fall back to raw wall (covers every
 *  real venue-timezone-shifted epoch; nothing legitimate exceeds it). */
export const FORMING_CLOCK_OFFSET_MAX_ABS_MS = 12 * 60 * 60_000;

/**
 * Wall-now mapped into the clock domain the bar was bucketed in, or raw wall
 * when no trustworthy estimate exists (unarmed, clamped-out, wrong provider,
 * or a wall-bucketed bar). Used ONLY for interval-currency — never for
 * silence freshness or broker staleness.
 */
function formingReadNowMs(symbolKey: string, state: FormingBarState, nowWallMs: number): number {
  if (!state.bucketedByProviderTime) return nowWallMs;
  const est = clockOffsetBySymbol.get(symbolKey);
  if (!est || est.provider !== state.provider) return nowWallMs;
  if (est.samples < FORMING_CLOCK_OFFSET_MIN_SAMPLES) return nowWallMs;
  if (!Number.isFinite(est.offsetMs) || Math.abs(est.offsetMs) > FORMING_CLOCK_OFFSET_MAX_ABS_MS) {
    return nowWallMs;
  }
  return nowWallMs + est.offsetMs;
}

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
 * @param provider    The quote stream this tick came from — enforces the
 *                    per-provider basis pairing (a bar never mixes providers).
 *
 * Best-effort: never throws into the caller (EA ingest path).
 */
export function foldFormingTick(
  symbol: string,
  bid: number,
  brokerTimeMs: number | null,
  nowWallMs: number = Date.now(),
  provider: FormingTickProvider = "unattributed",
): void {
  if (!Number.isFinite(bid) || bid <= 0) return;
  const symbolKey = formingKey(symbol);
  if (!symbolKey) return;
  const hasBrokerTime = brokerTimeMs != null && Number.isFinite(brokerTimeMs);
  const bucketTime = hasBrokerTime ? (brokerTimeMs as number) : nowWallMs;

  let anyAccepted = false;
  for (const tf of CHART_TIMEFRAMES) {
    const intervalMs = timeframeMs(tf);
    const openMs = Math.floor(bucketTime / intervalMs) * intervalMs;
    const k = stateKey(symbolKey, tf);
    const prev = store.get(k);
    if (prev && prev.provider !== provider) {
      // Cross-provider fold onto an owned bar: NEVER mix price bases inside
      // one bar (an assistant last/mid folded over broker BID would smear a
      // half-spread seam through the OHLC). A higher-ranked stream takes the
      // bar over with a FRESH bar; otherwise the incoming tick is dropped for
      // this timeframe while the owning stream's ticks are still live. The
      // rule applies regardless of interval equality — a differently-bucketed
      // (skewed-clock) lower-ranked tick must not stomp a live bar either.
      const ownerLive = nowWallMs - prev.lastTickWallMs <= FORMING_TIP_LIVE_MS;
      if (ownerLive && PROVIDER_RANK[provider] <= PROVIDER_RANK[prev.provider]) continue;
      // Takeover: fall through to open a fresh bar on the incoming basis
      // (never inherit OHLC accumulated on a different basis).
    }
    if (!prev || prev.openMs !== openMs || prev.provider !== provider) {
      // New interval, first tick, or provider takeover → fresh bar at this price.
      store.set(k, {
        openMs,
        open: bid,
        high: bid,
        low: bid,
        close: bid,
        lastTickWallMs: nowWallMs,
        tickCount: 1,
        provider,
        bucketedByProviderTime: hasBrokerTime,
      });
    } else {
      prev.high = Math.max(prev.high, bid);
      prev.low = Math.min(prev.low, bid);
      prev.close = bid;
      prev.lastTickWallMs = nowWallMs;
      prev.tickCount += 1;
    }
    anyAccepted = true;
  }
  // A fully dropped fold (a live stream owns every bar) must leave NO trace:
  // it may not refresh wall freshness, steer the offset estimate, or emit —
  // otherwise a lower-ranked stream could fabricate liveness it does not have.
  if (!anyAccepted) return;

  // Record the raw last tick (exact broker time, not interval-floored) so the
  // market-frozen / closed indicator can report the real last-quote time and
  // measure broker-time staleness. Display/telemetry only.
  lastTickBySymbol.set(symbolKey, {
    brokerTimeMs: hasBrokerTime ? (brokerTimeMs as number) : null,
    wallMs: nowWallMs,
    bid,
  });

  // Clock-offset estimate: only a strictly ADVANCING broker time samples (a
  // frozen/closed-market replay contributes nothing — see the estimator notes).
  if (hasBrokerTime) {
    const bt = brokerTimeMs as number;
    const sample = bt - nowWallMs;
    const est = clockOffsetBySymbol.get(symbolKey);
    if (!est || est.provider !== provider) {
      clockOffsetBySymbol.set(symbolKey, {
        offsetMs: sample,
        samples: 1,
        lastBrokerTimeMs: bt,
        provider,
      });
    } else if (bt > est.lastBrokerTimeMs) {
      est.offsetMs += FORMING_CLOCK_OFFSET_EWMA_ALPHA * (sample - est.offsetMs);
      est.samples += 1;
      est.lastBrokerTimeMs = bt;
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
 *
 * Interval-currency is judged in the bar's OWN clock domain: the fold buckets
 * by provider time, so wall-now is mapped through the per-symbol clock-offset
 * estimate (see formingReadNowMs) before flooring. Without this a provider
 * clock offset >= one interval made the tip permanently null, and any offset
 * blanked it for offset/intervalMs of every interval near boundaries. The
 * null-on-real-rollover contract is unchanged — once provider-now passes the
 * bar's interval with no new tick, the bar is dead and never resurrects.
 */
export function getFormingBar(
  symbol: string,
  timeframe: ChartTimeframe,
  nowWallMs: number = Date.now(),
): FormingBarSnapshot | null {
  const symbolKey = formingKey(symbol);
  if (!symbolKey) return null;
  const state = store.get(stateKey(symbolKey, timeframe));
  if (!state) return null;
  const intervalMs = timeframeMs(timeframe);
  const readNowMs = formingReadNowMs(symbolKey, state, nowWallMs);
  const currentOpenMs = Math.floor(readNowMs / intervalMs) * intervalMs;
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
  const symbolKey = formingKey(symbol);
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
  clockOffsetBySymbol.clear();
}
