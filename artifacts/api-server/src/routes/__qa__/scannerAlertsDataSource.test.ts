// Scanner alerts and the feed they ran on. A "HOT setup" alert claims a strong
// read; the final-read truth cap floors every non-live row (simulated,
// delayed, awaiting-feed) to LOW / WAIT, so such a row must not be announced
// as a HOT setup. Every scan-raised alert carries the data source of the scan
// row behind it so the Alerts Center can say what it was based on.
//
// The real scanner module runs; time is mocked. No DB, no network.
//
// Run: node --import tsx --experimental-test-module-mocks --test --test-force-exit \
//        src/routes/__qa__/scannerAlertsDataSource.test.ts

import { mock, test } from "node:test";
import assert from "node:assert/strict";

mock.timers.enable({ apis: ["Date"], now: Date.parse("2026-10-28T10:00:00Z") });

const { raiseScanAlerts, listAlerts } = await import("../../lib/marketScanner.js");
type Opp = Parameters<typeof raiseScanAlerts>[0][number];

function row(symbol: string, over: Partial<Opp>): Opp {
  return {
    symbol, timeframe: "M15",
    statusBadge: "HOT_SETUP",
    recommendedAction: "BUY",
    opportunity: { score: 82, label: "STRONG" },
    reasonForTrade: "qa reason",
    reasonToAvoid: "",
    dataSource: "LIVE_FEED",
    ...over,
  } as unknown as Opp;
}

function expireEarlier(): void {
  mock.timers.tick(25 * 60 * 60_000);
}

test("a HOT_SETUP row on a stale, simulated or awaiting feed raises no HOT setup alert", () => {
  expireEarlier();
  raiseScanAlerts([
    row("STALEUSD", { dataSource: "STALE_FEED" }),
    row("SIMUSD", { dataSource: "SIMULATOR" }),
    row("WAITUSD", { dataSource: "AWAITING_FEED" }),
  ]);
  const list = listAlerts({ limit: 200 });
  const hot = list.filter((a) => /HOT setup/.test(a.message));
  assert.deepEqual(hot.map((a) => a.symbol), [], "a non-live row was announced as a HOT setup");
});

test("a HOT_SETUP row on the live feed raises the alert and says it ran on the live feed", () => {
  expireEarlier();
  raiseScanAlerts([row("LIVEUSD", { dataSource: "LIVE_FEED" })]);
  const a = listAlerts({ limit: 200 }).find((x) => x.symbol === "LIVEUSD");
  assert.ok(a, "the live HOT setup alert was not raised");
  assert.match(a.message, /HOT setup LIVEUSD M15/);
  assert.equal((a as { dataSource?: string }).dataSource, "LIVE_FEED");
});

test("a risk alert from a scan row carries that row's data source", () => {
  expireEarlier();
  raiseScanAlerts([row("RISKUSD", { statusBadge: "SPREAD_TOO_HIGH", dataSource: "SIMULATOR" } as Partial<Opp>)]);
  const a = listAlerts({ limit: 200 }).find((x) => x.symbol === "RISKUSD");
  assert.ok(a, "the risk alert was not raised");
  assert.equal((a as { dataSource?: string }).dataSource, "SIMULATOR");
});
