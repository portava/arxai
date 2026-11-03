// Near-stop-loss alert copy names the venue the row really belongs to.
// Run via:
//   node --import tsx --experimental-test-module-mocks --test --test-force-exit \
//     src/lib/alerts/__qa__/nearStopLossVenueCopy.test.ts
//
// positionNearStopLossRule sweeps live_positions, the DEMO / legacy EA mirror
// (openPositions.ts header), not the LIVE venue (arx_live_positions). The alert
// must never call that row a "Live position", and it must say what price the
// distance was measured from. The position source and createAlert are stubbed;
// every other rule fails on the unreachable test database and is caught by the
// rule runner, so nothing is written anywhere.

import { mock, test } from "node:test";
import assert from "node:assert/strict";

type AlertArgs = Record<string, unknown>;
const created: AlertArgs[] = [];

const realOpen = await import("../../positions/openPositions.js");
mock.module("../../positions/openPositions.js", {
  namedExports: {
    ...realOpen,
    selectDemoOpenPositionsForAllUsers: async () => [{
      id: 41, userId: 7, symbol: "EURUSD", direction: "BUY", tradeId: null,
      // 10% of the stop distance left.
      entryPrice: 1.1, stopLoss: 1.09, currentPrice: 1.091, lastSyncedAt: null,
    }, {
      id: 42, userId: 8, symbol: "GBPUSD", direction: "SELL", tradeId: null,
      entryPrice: 1.3, stopLoss: 1.31, currentPrice: 1.3095,
      lastSyncedAt: new Date("2026-10-28T11:40:00.000Z"),
    }],
  },
});
const realManager = await import("../alertManager.js");
mock.module("../alertManager.js", {
  namedExports: {
    ...realManager,
    createAlert: async (args: AlertArgs) => { created.push(args); return { id: created.length }; },
  },
});

const { evaluateAndGenerate } = await import("../ruleEngine.js");

test("a DEMO-venue row near its stop is never called a 'Live position'", async () => {
  created.length = 0;
  await evaluateAndGenerate();
  const alert = created.find((a) => a["type"] === "POSITION_WARNING");
  assert.ok(alert, "the near-stop alert was raised");
  const text = `${String(alert["title"])} ${String(alert["message"])}`;
  assert.doesNotMatch(text, /\blive position\b/i);
  assert.match(String(alert["message"]), /^Demo position #41 \(BUY EURUSD\)/);
  assert.match(String(alert["message"]), /10% of its stop-loss distance left/);
  assert.match(String(alert["message"]), /last recorded price 1\.091 \(sync time not recorded\)\.$/);
  assert.equal(alert["userId"], 7);
  assert.equal(alert["relatedPositionId"], 41);
  const synced = created.find((a) => a["relatedPositionId"] === 42)!;
  assert.match(String(synced["title"]), /^Demo position near stop loss: GBPUSD$/);
  assert.match(String(synced["message"]), /last recorded price 1\.3095, last synced 2026-10-28 11:40 UTC\.$/);
});
