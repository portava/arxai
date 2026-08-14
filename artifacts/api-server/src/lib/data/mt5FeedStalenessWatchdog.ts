// MT5 candle-feed staleness + connectivity watchdog.
//
// WHY:
//   Once the EA starts pushing candles, a series can silently go stale (the EA
//   stops sending new bars for that symbol+timeframe). When that happens the
//   chart router quietly falls through to a third-party provider with NO admin
//   notification — operators only find out when traders notice the source
//   changed. This watchdog fires an in-app admin alert the moment a
//   PREVIOUSLY-CONTRIBUTING series exceeds CANDLE_TTL without a new push, and
//   an all-clear when it starts contributing fresh candles again. (Task #332.)
//
//   Task #336 adds the WHOLE-FEED layer on top: a single holistic alert when
//   the EA candle feed transitions to OFFLINE (mt5Provider.isConnected() flips
//   from true to false — no fresh candle/quote push within the provider's 60s
//   freshness window), and an all-clear when it comes back online. This catches
//   a total feed drop with ONE clear "feed offline" alert (fired ~60s after the
//   last push) instead of relying on the slower per-series stale flood (each
//   series must age past the 5-minute CANDLE_TTL, producing one alert apiece).
//   The whole-feed alert never fires on a fresh server that has never seen the
//   feed online — that "no push yet" state is the documented normal startup.
//
// SAFETY / SCOPE:
//   * Read-only over the in-memory mt5Provider store — never mutates candles,
//     never touches the kill switch, an execution gate, or any DB row except
//     the alerts table (via createAlert).
//   * Observation only. It NEVER blocks dispatch and is NOT a 17th gate.
//   * Uses the SAME CANDLE_TTL_MS the provider uses to stop serving a series,
//     so "stale" here means exactly "the router has already fallen through".
//
// DEDUPE / EPISODE MODEL:
//   One alert per series per stale EPISODE. A stale episode is keyed by the
//   `updatedAt` of the last push that went stale. While the series stays stale
//   on that same push, repeated sweeps do nothing. When the series contributes
//   fresh candles again the episode is cleared (a recovery alert fires once),
//   so the NEXT time it goes stale a brand-new alert is raised. The episode key
//   also flows into the createAlert dedupeKey, so even across a server restart
//   the same episode can't double-alert inside the createAlert TTL window.

import {
  getMt5AllSeriesStatus,
  mt5Provider,
  CANDLE_TTL_MS,
} from "./providers/mt5Provider.js";
import { createAlert } from "../alerts/alertManager.js";
import { logger } from "../logger.js";
import {
  evaluateFeedStaleness,
  evaluateFeedConnectivity,
  type SeriesStalenessState,
  type FeedStalenessEvaluation,
  type FeedConnectivityState,
} from "./mt5FeedStalenessWatchdogCore.js";

// The pure evaluation logic + its state/intent types and the duration formatter
// live in the side-effect-free core module so a unit test can exercise them
// without importing the logger transport worker or any DB/connection handle.
// Re-export them here so existing importers (and the runner below) keep a single
// import surface.
export {
  evaluateFeedStaleness,
  evaluateFeedConnectivity,
  humanizeMs,
} from "./mt5FeedStalenessWatchdogCore.js";
export type {
  SeriesStalenessState,
  FeedStalenessIntent,
  FeedStalenessEvaluation,
  FeedConnectivityState,
  FeedConnectivityIntent,
} from "./mt5FeedStalenessWatchdogCore.js";

// Sweep cadence. Shorter than CANDLE_TTL_MS so detection latency after a feed
// stops is bounded to roughly one interval beyond the TTL.
const SWEEP_INTERVAL_MS = 60 * 1000; // 60s

// ── Background runner ────────────────────────────────────────────────────────

const runnerState = new Map<string, SeriesStalenessState>();
const connectivityState: FeedConnectivityState = { everConnected: false, offlineEpisodeKey: null };
let sweepTimer: NodeJS.Timeout | null = null;
let sweeping = false;

/** Test/diagnostic helper — clear the runner's episode memory. */
export function __resetFeedStalenessState(): void {
  runnerState.clear();
  connectivityState.everConnected = false;
  connectivityState.offlineEpisodeKey = null;
}

/**
 * One sweep: evaluate whole-feed connectivity AND per-series staleness, then
 * fire any pending alerts. Alerting is best-effort — a createAlert failure for
 * one intent never blocks the others. Returns the per-series evaluation for
 * logging/tests.
 */
export async function sweepFeedStaleness(now: number = Date.now()): Promise<FeedStalenessEvaluation> {
  // 1. Whole-feed connectivity (Task #336). Evaluated first so an operator sees
  //    the holistic "feed offline" event ahead of the per-series detail. Read
  //    the AUTHORITATIVE provider connectivity (any series/quote fresh < 60s).
  const connected = await mt5Provider.isConnected();
  const connectivityIntents = evaluateFeedConnectivity(connected, connectivityState, now);
  for (const intent of connectivityIntents) {
    try {
      await createAlert({
        type: "BROKER_HEALTH",
        priority: intent.kind === "feed-offline" ? "HIGH" : "LOW",
        severity: intent.kind === "feed-offline" ? "warning" : "success",
        title: intent.title,
        message: intent.message,
        actionRequired: intent.kind === "feed-offline",
        dedupeKey: intent.dedupeKey,
      });
    } catch (err) {
      logger.warn({ err, intent: intent.kind }, "mt5_feed_connectivity_alert_failed");
    }
  }

  // 2. Per-series staleness (Task #332).
  const entries = getMt5AllSeriesStatus(now);
  const evaluation = evaluateFeedStaleness(entries, runnerState, now);

  for (const intent of evaluation.intents) {
    try {
      await createAlert({
        type: "BROKER_HEALTH",
        priority: intent.kind === "stale" ? "HIGH" : "LOW",
        severity: intent.kind === "stale" ? "warning" : "success",
        title: intent.title,
        message: intent.message,
        symbol: intent.symbol,
        actionRequired: intent.kind === "stale",
        dedupeKey: intent.dedupeKey,
      });
    } catch (err) {
      logger.warn({ err, intent: intent.kind, symbol: intent.symbol }, "mt5_feed_staleness_alert_failed");
    }
  }

  return evaluation;
}

export function startMt5FeedStalenessWatchdog(): void {
  if (sweepTimer) return;
  sweepTimer = setInterval(() => {
    if (sweeping) return;
    sweeping = true;
    sweepFeedStaleness()
      .then((r) => {
        if (r.intents.length > 0) {
          logger.info(
            {
              stale: r.intents.filter((i) => i.kind === "stale").length,
              recovered: r.intents.filter((i) => i.kind === "recovered").length,
            },
            "mt5_feed_staleness_swept",
          );
        }
      })
      .catch((err) => logger.warn({ err }, "mt5_feed_staleness_sweep_failed"))
      .finally(() => { sweeping = false; });
  }, SWEEP_INTERVAL_MS).unref();
  logger.info({ intervalMs: SWEEP_INTERVAL_MS, ttlMs: CANDLE_TTL_MS }, "mt5_feed_staleness_watchdog_started");
}

export function stopMt5FeedStalenessWatchdog(): void {
  if (sweepTimer) {
    clearInterval(sweepTimer);
    sweepTimer = null;
  }
}
