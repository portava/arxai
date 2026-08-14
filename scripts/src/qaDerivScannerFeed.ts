/**
 * qaDerivScannerFeed.ts
 *
 * Black-box QA for the Deriv synthetic-index scanner feed wiring.
 *
 *   - Status endpoint shape (configured/connected booleans + counts + no secrets)
 *   - Symbol resolver maps V75/Boom1000/Crash1000 correctly
 *   - Candle endpoint refuses unknown symbols with a clean message
 *   - Synthetic universe in marketScanner.ts is populated (no longer empty)
 *   - Scanner status feedNote reports the right Deriv message for both states
 *   - No fabricated synthetic candles
 *   - arx_live_commands unchanged
 *   - No DERIV_APP_ID / DERIV_API_TOKEN value leaks to any response
 *
 * Inviolables:
 *   - Never sets ARX_LIVE_BROKER_EXECUTION_ENABLED.
 *   - Never inserts into arx_live_commands.
 *   - Never logs secrets.
 */

import { pool } from "@workspace/db";
import {
  DERIV_SYNTHETIC_SYMBOLS,
  getDerivCandles,
  getDerivFeedStatus,
  isDerivSyntheticSymbol,
  resolveDerivSymbol,
} from "../../artifacts/api-server/src/lib/data/providers/derivProvider.js";
import { UNIVERSES, scannerStatus, scanOnce } from "../../artifacts/api-server/src/lib/marketScanner.js";

let pass = 0, fail = 0;
function check(label: string, ok: boolean, detail = ""): void {
  const tag = ok ? "PASS" : "FAIL";
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

async function main(): Promise<void> {
  const startRow = await pool.query<{ c: number }>(`SELECT count(*)::int AS c FROM arx_live_commands`);
  const start = startRow.rows[0]!.c;
  console.log(`[setup] arx_live_commands start = ${start}`);

  // 1. Status endpoint shape
  const status = getDerivFeedStatus();
  check("01_status_has_required_keys", [
    "configured", "connected", "appIdConfigured", "apiTokenConfigured", "wsUrl",
    "knownSyntheticSymbolCount", "activeSymbolCount", "subscribedSymbols",
    "lastTickAt", "reconnectCount", "message", "errorMessage",
  ].every((k) => k in status), `keys=${Object.keys(status).length}`);

  check("02_status_booleans_only_for_env",
    typeof status.appIdConfigured === "boolean" && typeof status.apiTokenConfigured === "boolean",
    `appIdConfigured=${status.appIdConfigured} apiTokenConfigured=${status.apiTokenConfigured}`);

  check("03_status_no_secret_leak", !containsSecret(status),
    "status payload must not contain raw DERIV_APP_ID / DERIV_API_TOKEN");

  check("04_known_symbol_count_at_least_14",
    status.knownSyntheticSymbolCount >= 14, `count=${status.knownSyntheticSymbolCount}`);

  // 2. Symbol resolution
  check("05_resolve_V75", resolveDerivSymbol("V75")?.derivId === "R_75", `→ ${resolveDerivSymbol("V75")?.derivId}`);
  check("06_resolve_Volatility_75", resolveDerivSymbol("Volatility 75")?.derivId === "R_75", "tolerant label");
  check("07_resolve_BOOM1000", resolveDerivSymbol("BOOM1000")?.derivId === "BOOM1000");
  check("08_resolve_Boom_1000", resolveDerivSymbol("Boom 1000")?.derivId === "BOOM1000");
  check("09_resolve_CRASH1000", resolveDerivSymbol("CRASH1000")?.derivId === "CRASH1000");
  check("10_resolve_Crash_1000", resolveDerivSymbol("Crash 1000")?.derivId === "CRASH1000");
  check("11_resolve_V75_1S_oneHz", resolveDerivSymbol("V75_1S")?.derivId === "1HZ75V", "1s variant");
  check("12_isDerivSyntheticSymbol_true", isDerivSyntheticSymbol("V75"));
  check("13_isDerivSyntheticSymbol_false_for_EURUSD", !isDerivSyntheticSymbol("EURUSD"));

  // 3. Universe populated
  check("14_synthetic_universe_populated",
    Array.isArray(UNIVERSES.synthetic) && UNIVERSES.synthetic.length >= 14,
    `len=${(UNIVERSES.synthetic as readonly string[]).length}`);
  check("15_synthetic_universe_contains_V75",
    (UNIVERSES.synthetic as readonly string[]).includes("V75"));
  check("16_synthetic_universe_contains_BOOM1000",
    (UNIVERSES.synthetic as readonly string[]).includes("BOOM1000"));

  // 4. Scanner status feedNote matches Deriv state
  await scanOnce({ universe: "synthetic" });
  const st = scannerStatus();
  const expectedSubstring = status.configured
    ? (status.connected ? "Synthetic-index feed connected" : "Synthetic-index feed is connecting")
    : "Synthetic-index live feed is not active";
  check("17_scanner_feedNote_reflects_deriv_state",
    typeof st.feedNote === "string" && st.feedNote.includes(expectedSubstring),
    `feedNote="${st.feedNote}"`);
  check("18_scanner_feedNote_no_secret_leak", !containsSecret(st));

  // 5. Candles refuse unknown symbol cleanly
  const bad = await getDerivCandles("NOT_A_SYNTH", "M15", 10);
  check("19_candles_refuse_unknown_clean",
    bad.ok === false && bad.reason === "SYMBOL_UNAVAILABLE_FROM_DERIV_FEED" && bad.candles.length === 0,
    `reason=${bad.reason}`);

  // 6. If env not configured, candles refuse with not-configured (don't try WS)
  if (!status.configured) {
    const r = await getDerivCandles("V75", "M15", 5);
    check("20_candles_when_unconfigured_refuse_cleanly",
      r.ok === false && r.reason === "DERIV_NOT_CONFIGURED" && r.candles.length === 0,
      `reason=${r.reason}`);
    check("21_candles_envelope_no_secret_leak", !containsSecret(r));
  } else {
    check("20_candles_when_unconfigured_refuse_cleanly", true, "skipped — env IS configured");
    check("21_candles_envelope_no_secret_leak", true, "skipped — env IS configured");
  }

  // 7. No fabricated candles for synthetic — scanner now routes synthetic
  // symbols through the unified market data router (Deriv-first). When the
  // feed is live, results must report dataSource=LIVE_FEED; when the feed
  // is not yet active, results must report dataSource=AWAITING_FEED. The
  // simulator MUST NEVER produce synthetic-index candles.
  const r1 = await scanOnce({ universe: "synthetic", timeframes: ["M15"] });
  check("22_synthetic_universe_no_simulator_leak",
    Array.isArray(r1) && r1.every((o) => o.dataSource === "LIVE_FEED" || o.dataSource === "AWAITING_FEED" || o.dataSource === "HISTORY_READY_AWAITING_LIVE_TICK"),
    `results=${r1.length} dataSource values=${Array.from(new Set(r1.map((o) => o.dataSource))).join(",")}`);

  // 8. Live-command strict-zero invariant
  const endRow = await pool.query<{ c: number }>(`SELECT count(*)::int AS c FROM arx_live_commands`);
  const end = endRow.rows[0]!.c;
  check("23_arx_live_commands_unchanged", start === end, `start=${start} end=${end}`);
  check("24_arx_live_commands_strict_zero", start === 0 && end === 0, `start=${start} end=${end}`);

  // 9. Sanity: every canonical symbol resolves
  const allResolve = DERIV_SYNTHETIC_SYMBOLS.every((s) => resolveDerivSymbol(s.symbol)?.derivId === s.derivId);
  check("25_every_canonical_symbol_resolves", allResolve, `${DERIV_SYNTHETIC_SYMBOLS.length} symbols`);

  console.log("");
  console.log(`${pass}/${pass + fail} checks PASSED`);
  if (fail > 0) console.log(`${fail} FAILED`);
}

main()
  .then(async () => {
    try { await pool.end(); } catch { /* ignore */ }
    process.exit(fail > 0 ? 1 : 0);
  })
  .catch(async (err) => {
    console.error(err);
    try { await pool.end(); } catch { /* ignore */ }
    process.exit(1);
  });
