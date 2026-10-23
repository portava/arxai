// T009 — Scanner real-feed analysis routing test.
//
// Verifies that the market scanner:
//   1. Routes synthetic/volatility symbols through the unified Market Data
//      Router (never falls back to the simulator for the synthetic class).
//   2. Emits dataSource="LIVE_FEED" with a feedProvider tag when the router
//      returns candles.
//   3. Emits dataSource="AWAITING_FEED" (and never SIMULATOR) when the
//      synthetic feed is not yet active — honest empty, no fabricated OHLC.
//   4. For non-synthetic asset classes, falls back to the simulator when
//      the router has no live feed (existing behavior preserved).
//   5. Removes the "simulator analysis pipeline" wording from the
//      synthetic-feed banner when the feed is connected.
//   6. Does not insert any rows into arx_live_commands — read-only path.
//
// All checks run end-to-end against the in-process scanner; the router is
// not mocked, so AWAITING_FEED is the expected outcome in environments
// without a Deriv feed.

import { pool } from "@workspace/db";
import {
  scanOnce, scannerStatus, UNIVERSES,
} from "../../artifacts/api-server/src/lib/marketScanner.js";

let pass = 0; let fail = 0;
function check(name: string, ok: boolean, detail = "") {
  const tag = ok ? "PASS" : "FAIL";
  // eslint-disable-next-line no-console
  console.log(`${tag} — ${name}${detail ? ` (${detail})` : ""}`);
  if (ok) pass += 1; else fail += 1;
}

async function main() {
  // Strict-zero baseline on arx_live_commands.
  const startRow = await pool.query<{ c: number }>(
    `SELECT count(*)::int AS c FROM arx_live_commands`,
  );
  const start = startRow.rows[0]!.c;
  check("01_arx_live_commands_baseline_zero", start === 0, `start=${start}`);

  // 1. Scan synthetic universe.
  const synthRows = await scanOnce({ universe: "synthetic", timeframes: ["M15"] });
  check("02_synthetic_scan_returns_rows", synthRows.length > 0,
    `n=${synthRows.length}`);

  // 2. No SIMULATOR leakage in synthetic results.
  const synthSources = Array.from(new Set(synthRows.map((o) => o.dataSource)));
  check("03_synthetic_no_simulator_leak",
    synthRows.every((o) => o.dataSource !== "SIMULATOR"),
    `sources=${synthSources.join(",")}`);

  // 3. Every synthetic row tagged either LIVE_FEED or AWAITING_FEED.
  check("04_synthetic_only_router_sources",
    synthRows.every((o) => o.dataSource === "LIVE_FEED" || o.dataSource === "AWAITING_FEED"),
    `sources=${synthSources.join(",")}`);

  // 4. AWAITING_FEED rows must carry the honest "no data" rule failure and
  //    not invent prices.
  const awaiting = synthRows.filter((o) => o.dataSource === "AWAITING_FEED");
  if (awaiting.length > 0) {
    check("05_awaiting_feed_no_fabricated_prices",
      awaiting.every((o) => o.entry === 0 && o.stopLoss === 0 && o.takeProfit === 0),
      `awaiting=${awaiting.length}`);
    check("06_awaiting_feed_rule_failure_reported",
      awaiting.every((o) => o.rulesFailed.includes("data_available")),
      `awaiting=${awaiting.length}`);
  } else {
    check("05_awaiting_feed_no_fabricated_prices", true, "no AWAITING_FEED rows in this run");
    check("06_awaiting_feed_rule_failure_reported", true, "no AWAITING_FEED rows in this run");
  }

  // 7. LIVE_FEED rows must carry a feedProvider tag from the router.
  const live = synthRows.filter((o) => o.dataSource === "LIVE_FEED");
  if (live.length > 0) {
    check("07_live_feed_rows_have_provider",
      live.every((o) => typeof o.feedProvider === "string" && o.feedProvider.length > 0),
      `live=${live.length}`);
  } else {
    check("07_live_feed_rows_have_provider", true, "no LIVE_FEED rows in this run");
  }

  // 8. Synthetic feedNote no longer claims simulator-pipeline analysis.
  await scanOnce({ universe: "synthetic" });
  const st = scannerStatus();
  check("08_feedNote_no_simulator_pipeline_wording",
    typeof st.feedNote === "string" && !/simulator analysis pipeline/i.test(st.feedNote),
    `feedNote="${st.feedNote}"`);

  // 9. Non-synthetic asset class (forex) — simulator fallback still works
  //    when no live feed is available. Either LIVE_FEED or SIMULATOR is
  //    acceptable; AWAITING_FEED is NOT acceptable for non-synthetic.
  const forexRows = await scanOnce({ universe: "forex", timeframes: ["M15"] });
  check("09_forex_scan_returns_rows", forexRows.length > 0, `n=${forexRows.length}`);
  check("10_forex_no_awaiting_feed",
    forexRows.every((o) => o.dataSource !== "AWAITING_FEED"),
    `sources=${Array.from(new Set(forexRows.map((o) => o.dataSource))).join(",")}`);

  // 10. Synthetic universe must cover canonical and Volatility-N aliases.
  const u = UNIVERSES.synthetic as readonly string[];
  check("11_synthetic_universe_has_V75", u.includes("V75"));
  check("12_synthetic_universe_has_BOOM1000", u.includes("BOOM1000"));

  // 11. Strict-zero finish on arx_live_commands.
  const endRow = await pool.query<{ c: number }>(
    `SELECT count(*)::int AS c FROM arx_live_commands`,
  );
  const end = endRow.rows[0]!.c;
  check("13_arx_live_commands_unchanged", start === end, `start=${start} end=${end}`);
  check("14_arx_live_commands_strict_zero", end === 0, `end=${end}`);

  // eslint-disable-next-line no-console
  console.log("");
  // eslint-disable-next-line no-console
  console.log(`${pass}/${pass + fail} checks PASSED`);
  await pool.end();
  process.exit(fail > 0 ? 1 : 0);
}

main().catch((e) => {
  // eslint-disable-next-line no-console
  console.error("scannerRealFeedRoutingTest FAILED:", e);
  process.exit(1);
});
