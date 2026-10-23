// MT5 candle-feed staleness + connectivity watchdog — PURE CORE.
//
// This module holds the side-effect-free evaluation logic for the watchdog:
// the per-series staleness decision (Task #332) and the whole-feed connectivity
// decision (Task #336), plus their state/intent types and the duration
// formatter. It imports NOTHING with a runtime side effect — only the
// `Mt5SeriesStatusEntry` type and the `CANDLE_TTL_MS` constant from the
// (equally pure) mt5Provider — so a unit test can exercise it without dragging
// in the logger transport worker, the alert manager, or any DB/connection
// handle. The runnable watchdog (`mt5FeedStalenessWatchdog.ts`) re-exports
// everything here and adds the alert-firing background runner on top.
//
// Keeping the pure logic here is what lets `test:mt5-feed-staleness` exit
// cleanly: it never spawns the pino-pretty transport worker thread, whose
// blocking thread-stream exit handler could otherwise intermittently hang the
// test process on exit.

import {
  CANDLE_TTL_MS,
  type Mt5SeriesStatusEntry,
} from "./providers/mt5Provider.js";

export interface SeriesStalenessState {
  /** True once this series has been observed contributing (fresh + non-empty). */
  hasContributed: boolean;
  /**
   * The `updatedAt` (last-push timestamp) of the push that went stale and that
   * we have ALREADY alerted on. Null when the series is not in an alerted stale
   * episode. Doubles as the per-episode identity for dedupe + recovery.
   */
  staleEpisodeKey: string | null;
}

export type FeedStalenessIntent =
  | {
      kind: "stale";
      symbol: string;
      timeframe: string;
      ageMs: number;
      updatedAt: string;
      dedupeKey: string;
      title: string;
      message: string;
    }
  | {
      kind: "recovered";
      symbol: string;
      timeframe: string;
      dedupeKey: string;
      title: string;
      message: string;
    };

export interface FeedStalenessEvaluation {
  intents: FeedStalenessIntent[];
  /** Series keys currently in an alerted stale episode (for diagnostics/tests). */
  activeStaleKeys: string[];
}

function seriesKey(symbol: string, timeframe: string): string {
  return `${symbol}|${timeframe}`;
}

/** Human-friendly duration, e.g. 372000 → "6m 12s", 8000 → "8s". */
export function humanizeMs(ms: number): string {
  const totalSeconds = Math.max(0, Math.floor(ms / 1000));
  const h = Math.floor(totalSeconds / 3600);
  const m = Math.floor((totalSeconds % 3600) / 60);
  const s = totalSeconds % 60;
  const parts: string[] = [];
  if (h > 0) parts.push(`${h}h`);
  if (m > 0) parts.push(`${m}m`);
  if (s > 0 || parts.length === 0) parts.push(`${s}s`);
  return parts.join(" ");
}

/**
 * PURE. Given the current per-series status snapshot and the prior episode
 * state, decide which stale / recovery alerts to fire and return the next
 * state. Mutates `state` in place (and returns it via the caller's map) so the
 * runner keeps a single long-lived map; tests pass their own map.
 */
export function evaluateFeedStaleness(
  entries: Mt5SeriesStatusEntry[],
  state: Map<string, SeriesStalenessState>,
  now: number = Date.now(),
): FeedStalenessEvaluation {
  const intents: FeedStalenessIntent[] = [];

  for (const entry of entries) {
    const key = seriesKey(entry.symbol, entry.timeframe);
    const prev = state.get(key) ?? { hasContributed: false, staleEpisodeKey: null };

    if (entry.status === "contributing") {
      // Fresh + non-empty. Mark it as having contributed and, if we were in an
      // alerted stale episode, clear it and emit a single all-clear.
      if (prev.staleEpisodeKey != null) {
        intents.push({
          kind: "recovered",
          symbol: entry.symbol,
          timeframe: entry.timeframe,
          dedupeKey: `mt5_feed_recovered:${key}:${prev.staleEpisodeKey}`,
          title: "MT5 candle feed recovered",
          message: `${entry.symbol} ${entry.timeframe} is contributing fresh candles again.`,
        });
      }
      state.set(key, { hasContributed: true, staleEpisodeKey: null });
      continue;
    }

    // status === "stale". Only a PREVIOUSLY-CONTRIBUTING series that has aged
    // out (no new push for > CANDLE_TTL) is in scope. An empty-but-fresh push
    // is "stale" to the provider but is NOT a stopped feed, so we skip it.
    const agedOut = entry.ageMs != null && entry.ageMs > CANDLE_TTL_MS;
    if (!prev.hasContributed || !agedOut || entry.updatedAt == null) {
      // Preserve any prior knowledge; nothing to alert on.
      state.set(key, prev);
      continue;
    }

    // New episode iff we have not already alerted on THIS push timestamp.
    if (prev.staleEpisodeKey !== entry.updatedAt) {
      const ageMs = entry.ageMs ?? (now - Date.parse(entry.updatedAt));
      intents.push({
        kind: "stale",
        symbol: entry.symbol,
        timeframe: entry.timeframe,
        ageMs,
        updatedAt: entry.updatedAt,
        dedupeKey: `mt5_feed_stale:${key}:${entry.updatedAt}`,
        title: "MT5 candle feed stale",
        message:
          `${entry.symbol} ${entry.timeframe} stopped pushing candles — ` +
          `no new bars for ${humanizeMs(ageMs)} (last push ${entry.updatedAt}). ` +
          `The chart is falling back to another provider for this series.`,
      });
      state.set(key, { hasContributed: true, staleEpisodeKey: entry.updatedAt });
    } else {
      // Same episode, already alerted — deduped.
      state.set(key, prev);
    }
  }

  const activeStaleKeys = [...state.entries()]
    .filter(([, s]) => s.staleEpisodeKey != null)
    .map(([k]) => k);

  return { intents, activeStaleKeys };
}

// ── Whole-feed connectivity (Task #336) ──────────────────────────────────────
//
// One holistic alert when the EA candle feed as a whole transitions offline,
// and an all-clear when it returns. This is driven by mt5Provider.isConnected()
// (any series OR quote fresh within the provider's 60s freshness window), which
// is the AUTHORITATIVE feed-up signal the admin "MT5 Candle Feed" card uses —
// NOT a derivation from the per-series list. It complements, never replaces, the
// per-series staleness alerts above.

export interface FeedConnectivityState {
  /** True once the feed has been observed connected at least once. Mirrors the
   *  per-series `hasContributed` gate so a fresh server that has never seen the
   *  feed online (the documented normal startup state) never alerts offline. */
  everConnected: boolean;
  /** Identity of the current alerted offline episode (the ISO timestamp the feed
   *  was first observed offline). Null when the feed is online or has never been
   *  online. Doubles as the dedupe identity + recovery key. */
  offlineEpisodeKey: string | null;
}

export type FeedConnectivityIntent =
  | {
      kind: "feed-offline";
      episodeKey: string;
      dedupeKey: string;
      title: string;
      message: string;
    }
  | {
      kind: "feed-online";
      episodeKey: string;
      dedupeKey: string;
      title: string;
      message: string;
    };

/**
 * PURE. Given the current provider connectivity and the prior connectivity
 * state, decide whether to fire a whole-feed offline / back-online alert.
 * Mutates `state` in place (same convention as evaluateFeedStaleness) and
 * returns the intents to fire (0 or 1).
 *
 * Transitions:
 *   online  → offline : fire ONE "feed offline" alert, open an episode.
 *   offline → online  : fire ONE "feed back online" all-clear, close the episode.
 *   offline → offline : no-op (deduped — the episode is already open).
 *   never-online stays no-op (normal startup before the EA's first push).
 */
export function evaluateFeedConnectivity(
  connected: boolean,
  state: FeedConnectivityState,
  now: number = Date.now(),
): FeedConnectivityIntent[] {
  const intents: FeedConnectivityIntent[] = [];

  if (connected) {
    if (state.offlineEpisodeKey != null) {
      const episodeKey = state.offlineEpisodeKey;
      intents.push({
        kind: "feed-online",
        episodeKey,
        dedupeKey: `mt5_feed_online:${episodeKey}`,
        title: "MT5 candle feed back online",
        message:
          "The MT5 EA candle feed is pushing fresh data again. Chart symbols can " +
          "route to the broker feed once their individual series refresh.",
      });
    }
    state.everConnected = true;
    state.offlineEpisodeKey = null;
    return intents;
  }

  // Not connected. Only alert on the online→offline transition, and only once
  // the feed has actually been online before. A never-online feed is the normal
  // startup state and an already-open episode is deduped.
  if (state.everConnected && state.offlineEpisodeKey == null) {
    const episodeKey = new Date(now).toISOString();
    intents.push({
      kind: "feed-offline",
      episodeKey,
      dedupeKey: `mt5_feed_offline:${episodeKey}`,
      title: "MT5 candle feed offline",
      message:
        "The MT5 EA candle feed stopped — no fresh candle or quote push within " +
        "the last 60s. Every chart symbol is now falling back to another data " +
        "provider. This is visibility only; live execution gates are unaffected.",
    });
    state.offlineEpisodeKey = episodeKey;
  }

  return intents;
}
