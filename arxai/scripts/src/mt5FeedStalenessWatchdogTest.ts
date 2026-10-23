// Task #332 — Pure unit test for the MT5 candle-feed staleness watchdog.
//
// Asserts evaluateFeedStaleness() correctly fires an admin alert when a
// PREVIOUSLY-CONTRIBUTING series goes stale (> CANDLE_TTL without a new push),
// names the symbol+timeframe and the time since the last push, dedupes within
// a single stale episode, clears (recovery alert) when the series is fresh
// again, and re-arms for a brand-new episode after a fresh push. Pure logic —
// no DB, no network.
//
// Run: pnpm --filter @workspace/scripts run test:mt5-feed-staleness

// Import the PURE evaluation core directly (not the runnable watchdog) so this
// unit test never drags in the logger transport worker or any DB/connection
// handle — that leaked handle is what could intermittently hang the process on
// exit. The core re-exports identical logic; the watchdog re-exports the core.
import {
  evaluateFeedStaleness,
  evaluateFeedConnectivity,
  humanizeMs,
  type SeriesStalenessState,
  type FeedConnectivityState,
} from "../../artifacts/api-server/src/lib/data/mt5FeedStalenessWatchdogCore.js";
import { CANDLE_TTL_MS } from "../../artifacts/api-server/src/lib/data/providers/mt5Provider.js";
import type { Mt5SeriesStatusEntry } from "../../artifacts/api-server/src/lib/data/providers/mt5Provider.js";

const NOW = Date.parse("2026-06-07T12:00:00.000Z");

function entry(over: Partial<Mt5SeriesStatusEntry> = {}): Mt5SeriesStatusEntry {
  return {
    symbol: "EURUSD",
    timeframe: "M5",
    status: "contributing",
    barCount: 150,
    ageMs: 2000,
    updatedAt: new Date(NOW - 2000).toISOString(),
    ...over,
  };
}

let pass = 0, fail = 0;
const failures: string[] = [];
function check(name: string, cond: boolean, detail = ""): void {
  if (cond) { pass++; return; }
  fail++; failures.push(`[${name}] ${detail}`);
}

// ── humanizeMs formatting ───────────────────────────────────────────────────
check("humanize seconds", humanizeMs(8000) === "8s", humanizeMs(8000));
check("humanize min+sec", humanizeMs(372000) === "6m 12s", humanizeMs(372000));
check("humanize hour", humanizeMs(3_600_000) === "1h", humanizeMs(3_600_000));
check("humanize zero", humanizeMs(0) === "0s", humanizeMs(0));

// ── a never-contributing stale series does NOT alert ────────────────────────
{
  const state = new Map<string, SeriesStalenessState>();
  const r = evaluateFeedStaleness(
    [entry({ status: "stale", ageMs: CANDLE_TTL_MS + 60_000, updatedAt: new Date(NOW - (CANDLE_TTL_MS + 60_000)).toISOString() })],
    state,
    NOW,
  );
  check("no alert for never-contributed", r.intents.length === 0, JSON.stringify(r.intents));
}

// ── empty-but-fresh push is NOT treated as a stopped feed ───────────────────
{
  const state = new Map<string, SeriesStalenessState>();
  // First contribute, then an empty fresh push (provider reports it as "stale"
  // because barCount 0, but ageMs is tiny — the feed has NOT stopped).
  evaluateFeedStaleness([entry()], state, NOW);
  const r = evaluateFeedStaleness(
    [entry({ status: "stale", barCount: 0, ageMs: 3000, updatedAt: new Date(NOW - 3000).toISOString() })],
    state,
    NOW,
  );
  check("no stale alert for empty-but-fresh", r.intents.length === 0, JSON.stringify(r.intents));
}

// ── contributing → stale fires exactly one alert, named, with age ───────────
const sharedState = new Map<string, SeriesStalenessState>();
{
  const r = evaluateFeedStaleness([entry()], sharedState, NOW);
  check("contributing fires nothing", r.intents.length === 0, JSON.stringify(r.intents));
  check("contributing recorded", sharedState.get("EURUSD|M5")?.hasContributed === true);
}
const staleUpdatedAt = new Date(NOW - (CANDLE_TTL_MS + 120_000)).toISOString();
{
  const r = evaluateFeedStaleness(
    [entry({ status: "stale", ageMs: CANDLE_TTL_MS + 120_000, updatedAt: staleUpdatedAt })],
    sharedState,
    NOW,
  );
  check("stale fires one alert", r.intents.length === 1, JSON.stringify(r.intents));
  const i = r.intents[0]!;
  check("alert kind stale", i.kind === "stale", i.kind);
  check("alert names symbol", i.message.includes("EURUSD"), i.message);
  check("alert names timeframe", i.message.includes("M5"), i.message);
  check("alert names duration", i.message.includes("7m"), i.message); // TTL(5m)+2m
  check("alert dedupe per episode", i.dedupeKey === `mt5_feed_stale:EURUSD|M5:${staleUpdatedAt}`, i.dedupeKey);
}

// ── repeated stale sweeps on the SAME push are deduped ──────────────────────
{
  const r = evaluateFeedStaleness(
    [entry({ status: "stale", ageMs: CANDLE_TTL_MS + 180_000, updatedAt: staleUpdatedAt })],
    sharedState,
    NOW,
  );
  check("repeat stale deduped", r.intents.length === 0, JSON.stringify(r.intents));
  check("episode still active", r.activeStaleKeys.includes("EURUSD|M5"));
}

// ── recovery clears the episode and fires one all-clear ─────────────────────
{
  const r = evaluateFeedStaleness([entry()], sharedState, NOW);
  check("recovery fires one alert", r.intents.length === 1, JSON.stringify(r.intents));
  check("recovery kind", r.intents[0]!.kind === "recovered", r.intents[0]!.kind);
  check("episode cleared", sharedState.get("EURUSD|M5")?.staleEpisodeKey == null);
  check("no active stale keys", r.activeStaleKeys.length === 0, JSON.stringify(r.activeStaleKeys));
}

// ── a NEW stale episode (new push timestamp) re-alerts ──────────────────────
{
  const newStaleUpdatedAt = new Date(NOW - (CANDLE_TTL_MS + 30_000)).toISOString();
  const r = evaluateFeedStaleness(
    [entry({ status: "stale", ageMs: CANDLE_TTL_MS + 30_000, updatedAt: newStaleUpdatedAt })],
    sharedState,
    NOW,
  );
  check("new episode re-alerts", r.intents.length === 1, JSON.stringify(r.intents));
  check("new episode dedupe key differs",
    r.intents[0]!.dedupeKey === `mt5_feed_stale:EURUSD|M5:${newStaleUpdatedAt}`,
    r.intents[0]!.dedupeKey);
}

// ── Task #336: whole-feed connectivity transitions ──────────────────────────

// a fresh server that has NEVER seen the feed online does not alert offline
{
  const state: FeedConnectivityState = { everConnected: false, offlineEpisodeKey: null };
  const intents = evaluateFeedConnectivity(false, state, NOW);
  check("no offline alert before first connect", intents.length === 0, JSON.stringify(intents));
  check("never-online stays not-everConnected", state.everConnected === false);
}

// online → offline fires exactly one offline alert and opens an episode
const connState: FeedConnectivityState = { everConnected: false, offlineEpisodeKey: null };
{
  const intents = evaluateFeedConnectivity(true, connState, NOW);
  check("connect fires nothing", intents.length === 0, JSON.stringify(intents));
  check("connect records everConnected", connState.everConnected === true);
}
{
  const intents = evaluateFeedConnectivity(false, connState, NOW);
  check("offline fires one alert", intents.length === 1, JSON.stringify(intents));
  check("offline kind", intents[0]!.kind === "feed-offline", intents[0]!.kind);
  check("offline dedupe key", intents[0]!.dedupeKey === `mt5_feed_offline:${new Date(NOW).toISOString()}`, intents[0]!.dedupeKey);
  check("offline episode opened", connState.offlineEpisodeKey === new Date(NOW).toISOString());
}

// staying offline does NOT re-alert (deduped)
{
  const intents = evaluateFeedConnectivity(false, connState, NOW + 60_000);
  check("repeat offline deduped", intents.length === 0, JSON.stringify(intents));
  check("episode still open", connState.offlineEpisodeKey === new Date(NOW).toISOString());
}

// offline → online fires one all-clear keyed to the same episode, then clears
{
  const intents = evaluateFeedConnectivity(true, connState, NOW + 120_000);
  check("recovery fires one alert", intents.length === 1, JSON.stringify(intents));
  check("recovery kind", intents[0]!.kind === "feed-online", intents[0]!.kind);
  check("recovery keyed to episode", intents[0]!.dedupeKey === `mt5_feed_online:${new Date(NOW).toISOString()}`, intents[0]!.dedupeKey);
  check("episode cleared on recovery", connState.offlineEpisodeKey === null);
}

// a NEW offline episode (after recovery) re-alerts with a fresh key
{
  const intents = evaluateFeedConnectivity(false, connState, NOW + 200_000);
  check("new offline episode re-alerts", intents.length === 1, JSON.stringify(intents));
  check("new offline key differs", intents[0]!.dedupeKey === `mt5_feed_offline:${new Date(NOW + 200_000).toISOString()}`, intents[0]!.dedupeKey);
}

console.log(`mt5-feed-staleness watchdog: ${pass}/${pass + fail} PASS`);
if (failures.length) {
  for (const f of failures) console.log("  FAIL " + f);
  process.exit(1);
}
process.exit(0);
