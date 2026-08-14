/**
 * qaDerivWarmup.ts
 *
 * Long-running QA for the Phase 22X Deriv warm-up lifecycle.
 *
 * Boots an isolated DerivWsClient inside the test process and waits up to
 * ~20s for the full warm-up to land:
 *
 *   1. WebSocket connect
 *   2. authorize (when DERIV_API_TOKEN is set)
 *   3. active_symbols cached  (activeSymbolsLoaded === true)
 *   4. first live tick lands  (hasRecentTick === true within freshness window)
 *
 * Asserts the warm-up state machine advances through the documented
 * readiness states:
 *
 *   UNCONFIGURED | CONNECTING | (AUTH_FAILED) | CONNECTED_AWAITING_FEED
 *     → HISTORY_READY_AWAITING_LIVE_TICK → LIVE_FEED
 *
 * Inviolables:
 *   - Never sets ARX_LIVE_BROKER_EXECUTION_ENABLED.
 *   - Never inserts into arx_live_commands; verifies count is unchanged
 *     (and strict-zero in CI) before/after the run.
 *   - Never logs raw secrets — only masked values via getDerivFeedStatus().
 */

import { pool } from "@workspace/db";
import { getDerivFeedStatus, hasRecentDerivTickFor } from "../../artifacts/api-server/src/lib/data/providers/derivProvider.js";
import { getDerivWsClient } from "../../artifacts/api-server/src/lib/data/providers/derivWsClient.js";

const TOTAL_TIMEOUT_MS = 20_000;
const POLL_INTERVAL_MS = 500;

let pass = 0, fail = 0;
function check(label: string, ok: boolean, detail = ""): void {
  const tag = ok ? "PASS" : "FAIL";
  // eslint-disable-next-line no-console
  console.log(`${tag}  ${label}${detail ? "  — " + detail : ""}`);
  if (ok) pass++; else fail++;
}

function containsSecret(blob: unknown): boolean {
  const json = JSON.stringify(blob);
  const appId = (process.env.DERIV_APP_ID ?? "").trim();
  const token = (process.env.DERIV_API_TOKEN ?? "").trim();
  if (appId && json.includes(appId)) return true;
  if (token && json.includes(token)) return true;
  return false;
}

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

async function main(): Promise<void> {
  const startRow = await pool.query<{ c: number }>(`SELECT count(*)::int AS c FROM arx_live_commands`);
  const start = startRow.rows[0]!.c;
  // eslint-disable-next-line no-console
  console.log(`[setup] arx_live_commands start = ${start}`);

  const status0 = getDerivFeedStatus();
  if (!status0.configured) {
    check("00_env_configured_for_warmup_run", false,
      "DERIV_APP_ID not set — cannot meaningfully test warm-up. Skipping the live-tick assertions but still asserting the strict-zero invariant.");
    const endRow0 = await pool.query<{ c: number }>(`SELECT count(*)::int AS c FROM arx_live_commands`);
    const end0 = endRow0.rows[0]!.c;
    check("XX_arx_live_commands_unchanged_when_skipped", start === end0, `start=${start} end=${end0}`);
    // eslint-disable-next-line no-console
    console.log(`${pass}/${pass + fail} checks PASSED`);
    await pool.end();
    process.exit(fail === 0 ? 0 : 1);
  }

  check("00_env_configured_for_warmup_run", true);

  // Trigger connection — readonly path; never places trades.
  const client = getDerivWsClient();
  try { await client.ensureConnection(); } catch { /* WS open errors surface via getLastErrorMessage(); poll catches them */ }

  // Poll for state transitions.
  const t0 = Date.now();
  let sawConnecting = false;
  let sawConnected = false;
  let sawAuthDecision = false;
  let sawActiveSymbols = false;
  let sawHistoryReady = false;
  let sawLiveTick = false;
  let lastReadiness = "";

  while (Date.now() - t0 < TOTAL_TIMEOUT_MS) {
    const s = getDerivFeedStatus();
    if (s.feedReadinessState !== lastReadiness) {
      lastReadiness = s.feedReadinessState;
      // eslint-disable-next-line no-console
      console.log(`[t+${Date.now() - t0}ms] readiness=${s.feedReadinessState} connected=${s.connected} activeSymbolsLoaded=${s.activeSymbolsLoaded} hasRecentTick=${s.hasRecentTick} lastTickAgeMs=${s.lastTickAgeMs}`);
    }
    if (!s.connected) sawConnecting = true;
    if (s.connected) sawConnected = true;
    if (s.feedReadinessState !== "CONNECTING") sawAuthDecision = true;
    if (s.activeSymbolsLoaded) sawActiveSymbols = true;
    if (s.feedReadinessState === "HISTORY_READY_AWAITING_LIVE_TICK") sawHistoryReady = true;
    if (s.hasRecentTick) { sawLiveTick = true; break; }
    await sleep(POLL_INTERVAL_MS);
  }

  const final = getDerivFeedStatus();

  // Connection establishes.
  check("01_connected", final.connected, `connected=${final.connected} err=${final.errorMessage ?? "none"}`);

  // Either we observed CONNECTING transiently or we connected so fast we
  // skipped it — both are acceptable. The required milestone is that the
  // auth-decision step ran (state moved past CONNECTING).
  check("02_auth_decision_reached", sawAuthDecision, `lastReadiness=${final.feedReadinessState}`);

  // active_symbols cached — warm-up step 1.
  check("03_active_symbols_loaded", sawActiveSymbols,
    `activeSymbolsLoaded=${final.activeSymbolsLoaded} count=${final.activeSymbolsCachedCount} err=${final.activeSymbolsError ?? "none"}`);

  // Eager warm-up subscribed to defaults.
  const expectedDefaults = ["R_25", "R_75", "1HZ25V", "1HZ75V", "BOOM1000", "CRASH1000"];
  const eager = new Set(final.eagerWarmupSymbols);
  const missing = expectedDefaults.filter((d) => !eager.has(d));
  check("04_eager_warmup_default_symbols_subscribed", missing.length === 0,
    `eager=${final.eagerWarmupSymbols.join(",")} missing=${missing.join(",") || "none"}`);

  // We must have observed at least the HISTORY_READY intermediate state
  // OR the terminal LIVE_FEED state. CONNECTED_AWAITING_FEED alone (i.e.
  // warm-up never finished active_symbols) is a failure.
  check("05_history_ready_or_live_observed", sawHistoryReady || sawLiveTick,
    `history=${sawHistoryReady} live=${sawLiveTick}`);

  // First live tick. This is the headline assertion: with valid creds the
  // warm-up should deliver a tick well inside the 20s budget.
  check("06_first_live_tick_within_budget", sawLiveTick,
    `lastTickAgeMs=${final.lastTickAgeMs} hasRecentTick=${final.hasRecentTick} subs=${final.subscribedSymbols.length}`);

  // Status payload is sanitary.
  check("07_no_secret_leak_in_status", !containsSecret(final));

  // Warm-up was attempted. warmupCompletedAt is intentionally NOT required:
  // subscribeTicks() resolves with the first tick, so on a fast connection
  // the poll loop exits at the moment that first tick lands — which can be
  // before the warm-up's subscribe loop has finished iterating the remaining
  // default symbols. attemptedAt is the durable signal that warm-up ran.
  check("08_warmup_attempted_timestamp_populated",
    final.warmupAttemptedAt != null,
    `attempted=${final.warmupAttemptedAt} completed=${final.warmupCompletedAt}`);

  // Health rolls up sensibly: never "degraded" purely because the first
  // tick took a moment to arrive.
  check("09_health_summary_not_degraded_during_warmup",
    final.healthSummary !== "degraded" || (process.env.DERIV_API_TOKEN ?? "").trim().length === 0,
    `health=${final.healthSummary} readiness=${final.feedReadinessState}`);

  // Per-symbol readiness — the scanner uses hasRecentDerivTickFor(symbol),
  // not the global flag. Prove the per-symbol path works: at least one of
  // the eager warmup symbols (the one that delivered the first tick) must
  // report true, AND a known-unsubscribed symbol ("STEP" → "stpRNG") must
  // report false. This guards against the "one ticking symbol promotes
  // every row" regression caught in code review.
  if (sawLiveTick) {
    const anyEagerLive = ["V25", "V75", "V25_1S", "V75_1S", "BOOM1000", "CRASH1000"]
      .some((label) => hasRecentDerivTickFor(label));
    check("12_per_symbol_tick_for_at_least_one_eager_symbol", anyEagerLive,
      `none of the eager warm-up symbols reported a recent cached tick`);
    const stepHasTick = hasRecentDerivTickFor("STEP");
    check("13_per_symbol_check_returns_false_for_unsubscribed_symbol", !stepHasTick,
      `STEP (stpRNG) was NOT in the eager warm-up set but reported a recent tick: ${stepHasTick}`);
  } else {
    check("12_per_symbol_tick_for_at_least_one_eager_symbol", true, "skipped — no live tick observed");
    check("13_per_symbol_check_returns_false_for_unsubscribed_symbol", true, "skipped — no live tick observed");
  }

  // STRICT zero — no live commands inserted by this test.
  const endRow = await pool.query<{ c: number }>(`SELECT count(*)::int AS c FROM arx_live_commands`);
  const end = endRow.rows[0]!.c;
  check("10_arx_live_commands_unchanged", start === end, `start=${start} end=${end}`);
  check("11_arx_live_commands_strict_zero_in_ci", start === 0 && end === 0, `start=${start} end=${end}`);

  // Brief informational tail — sawConnecting is informational only; on a
  // very fast handshake the first poll may already see connected.
  // eslint-disable-next-line no-console
  console.log(`[info] sawConnecting=${sawConnecting} sawConnected=${sawConnected} subs=${final.subscribedSymbols.length}`);

  // eslint-disable-next-line no-console
  console.log("");
  // eslint-disable-next-line no-console
  console.log(`${pass}/${pass + fail} checks PASSED`);

  await pool.end();
  process.exit(fail === 0 ? 0 : 1);
}

main().catch(async (err) => {
  // eslint-disable-next-line no-console
  console.error("FATAL", err);
  try { await pool.end(); } catch { /* ignore */ }
  process.exit(2);
});
