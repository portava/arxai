// Task #785 — ONE explicit "broker-confirmed live feed" definition.
//
// A single predicate every live-readiness surface can share so "is this feed
// fresh, broker-confirmed data for the exact tradable symbol/timeframe?" is
// answered identically by the chart, scanner, Ruby, and the live order
// preflight. It COMPOSES the existing shared feed-truth core
// (resolveSymbolFeedVerdict over routeCandles + the trailing-interval
// thresholds in freshness.ts) — it does NOT invent a second threshold and it
// NEVER fabricates data.
//
// "Broker-confirmed live feed" === verdict "LIVE", which the shared core only
// returns when:
//   * a winning provider answered with candles for the symbol/timeframe, AND
//   * the newest bar is within the LIVE trailing-interval window (fresh), AND
//   * when the winning provider is Deriv-backed, a recent Deriv WS tick exists
//     (MT5-broker-served symbols are judged on broker candle freshness alone —
//     the broker feed IS the live source; Task #776).
//
// SAFETY: analysis/display truth only. This never touches execution routing,
// fills, balance, the 18-gate live pipeline, or any gate. A stale/awaiting feed
// still resolves AWAITING/LIVE_DELAYED and stays entry-blocked — this corrects a
// wrong verdict, it never relaxes the gate.

import type { SymbolFeedVerdict } from "@workspace/domain/safety-contracts/syntheticLiveFloor";
import { resolveSymbolFeedVerdict } from "./symbolFeedVerdict.js";
import { rawTrailingIntervalGap } from "./chart/candleNormalization.js";
import { normalizeChartTimeframe } from "./chart/timeframes.js";
import { routeCandles } from "./marketDataRouter.js";
import { getDerivSymbolFeedStatus } from "./providers/derivProvider.js";

export interface BrokerConfirmedFeed {
  /** Shared feed-truth verdict (LIVE / LIVE_DELAYED / AWAITING). */
  verdict: SymbolFeedVerdict;
  /** TRUE only when verdict === "LIVE" — the broker-confirmed-live definition. */
  feedConfirmed: boolean;
  /** Winning provider (e.g. "mt5_broker", "deriv"); null when no source answered. */
  feedSource: string | null;
  /** Whether the winning provider is Deriv-backed (tick-confirmed liveness). */
  derivBacked: boolean;
  /** Whether a recent live tick is present (always true for broker-native feeds). */
  hasRecentTick: boolean;
  /** Trailing-interval gap of the newest bar (the missing-interval proxy). */
  trailingIntervals: number | null;
  /** ISO time of the newest candle returned, or null when none. */
  lastCandleAt: string | null;
  /**
   * ISO time of the most-recent live tick — populated for Deriv-backed feeds
   * (per-symbol tick cache). MT5-broker-served symbols stream bars, not a tick
   * cache on this path, so this is honestly `null` there (the broker bar IS the
   * live source — Task #776).
   */
  lastTickAt: string | null;
  /** Number of candles the router returned (0 ⇒ AWAITING). */
  candleCount: number;
  /** The normalized chart timeframe actually evaluated (null when invalid). */
  normalizedTimeframe: string | null;
}

// Provider IDs the router can name (marketDataRouter `ProviderId` +
// `assistant_real:<source>`). Only MT5-broker bars and Deriv WS ticks are
// broker-confirmed LIVE sources. `assistant_real:*` is a third-party REST
// fallback (e.g. twelvedata/polygon) — fresh data, but NOT broker-confirmed, so
// it must never satisfy the live-entry "broker-confirmed feed" definition.
const BROKER_GRADE_CANDLE_SOURCES: ReadonlySet<string> = new Set(["mt5_broker"]);

/**
 * Pure broker-confirmed-live predicate. TRUE only when the feed is BOTH fresh
 * (verdict "LIVE") AND served by a broker-grade source:
 *   * `mt5_broker` — the broker bar IS the live source (Task #776), OR
 *   * a Deriv-backed provider — whose "LIVE" already required a real, recent WS
 *     tick (so freshness here implies a confirmed tick).
 * A fresh `assistant_real:*` REST fallback is fresh but NOT broker-confirmed and
 * returns false. This is a strict tightening — it can only ever BLOCK a
 * live-entry readiness, never relax one.
 */
export function isBrokerConfirmedLive(args: {
  verdict: SymbolFeedVerdict;
  source: string | null;
  derivBacked: boolean;
}): boolean {
  if (args.verdict !== "LIVE") return false;
  if (args.derivBacked) return true;
  return args.source != null && BROKER_GRADE_CANDLE_SOURCES.has(args.source);
}

const FEED_TIMEOUT_MS = 2500;

function withTimeout<T>(p: Promise<T>, fallback: T): Promise<T> {
  return new Promise<T>((resolve) => {
    let settled = false;
    const timer = setTimeout(() => {
      if (!settled) {
        settled = true;
        resolve(fallback);
      }
    }, FEED_TIMEOUT_MS);
    p.then((value) => {
      if (!settled) {
        settled = true;
        clearTimeout(timer);
        resolve(value);
      }
    }).catch(() => {
      if (!settled) {
        settled = true;
        clearTimeout(timer);
        resolve(fallback);
      }
    });
  });
}

function awaitingFeed(normalizedTimeframe: string | null): BrokerConfirmedFeed {
  return {
    verdict: "AWAITING",
    feedConfirmed: false,
    feedSource: null,
    derivBacked: false,
    hasRecentTick: false,
    trailingIntervals: null,
    lastCandleAt: null,
    lastTickAt: null,
    candleCount: 0,
    normalizedTimeframe,
  };
}

/**
 * Resolve the broker-confirmed-feed state for a symbol/timeframe. Fail-honest:
 * any error / empty / invalid-timeframe resolves AWAITING (feedConfirmed:false),
 * never a falsely-confirmed feed. The timeframe is normalized first so a
 * lowercase scanner default (e.g. "15m") is not forwarded raw to the
 * uppercase-only candle/router path and mislabeled insufficient.
 */
export async function resolveBrokerConfirmedFeed(
  symbol: string,
  timeframe = "M1",
): Promise<BrokerConfirmedFeed> {
  const normalized = normalizeChartTimeframe(timeframe);
  if (!normalized) return awaitingFeed(null);

  const cr = await withTimeout(routeCandles(symbol, normalized, 30), null);
  if (cr == null || !cr.ok || cr.candles.length === 0) {
    return awaitingFeed(normalized);
  }

  const source = cr.primaryProvider ?? null;
  const trailingIntervals = rawTrailingIntervalGap(cr.candles, source, normalized);
  const derivBacked = source === "deriv" || (source?.startsWith("deriv") ?? false);
  // Deriv-backed feeds carry a per-symbol tick cache → real lastTickAt + tick
  // recency. MT5-broker symbols stream bars (no tick cache here): judged on bar
  // freshness alone (Task #776), lastTickAt honestly null.
  let hasRecentTick = true;
  let lastTickAt: string | null = null;
  if (derivBacked) {
    const ds = getDerivSymbolFeedStatus(symbol);
    hasRecentTick = ds.hasRecentTick;
    lastTickAt = ds.lastTickAt;
  }
  const verdict = resolveSymbolFeedVerdict({ hasRecentTick, trailingIntervals });
  const lastCandleAt = cr.candles[cr.candles.length - 1]?.time ?? null;

  return {
    verdict,
    feedConfirmed: isBrokerConfirmedLive({ verdict, source, derivBacked }),
    feedSource: source,
    derivBacked,
    hasRecentTick,
    trailingIntervals,
    lastCandleAt,
    lastTickAt,
    candleCount: cr.candles.length,
    normalizedTimeframe: normalized,
  };
}
