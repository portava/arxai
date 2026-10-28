// The Profit Missions "Open exposure" panel must not show "Open risk $0.00" for
// open live positions whose risk is unknown. A position in profit (or with no
// floating P/L) has an unknown risk-to-stop, not zero risk.
//
// Run: node --import tsx --experimental-test-module-mocks --test --test-force-exit \
//        src/lib/__qa__/missionExposureRiskUnknown.test.ts

import { test, mock } from "node:test";
import assert from "node:assert/strict";

const real = await import("../positions/openPositions.js");
let rows: Array<{ symbol: string; side: string; floatingPl: number | null }> = [];
mock.module("../positions/openPositions.js", {
  namedExports: {
    ...real,
    readOpenPositions: async () => rows.map((row) => ({ row })),
  },
});

const { resolveMissionPulsePhase7 } = await import("../missionExecutionQuality.js");

test("open positions in profit / with no floating P/L report risk as unknown, not $0", async () => {
  rows = [
    { symbol: "EURUSD", side: "BUY", floatingPl: 12 },
    { symbol: "XAUUSD", side: "SELL", floatingPl: null },
  ];
  const { exposure } = await resolveMissionPulsePhase7({ userId: 42, signals: {} as never });
  assert.equal(exposure.openCount, 2);
  assert.equal(exposure.riskUnknownCount, 2);
});

test("a losing position is counted as unknown risk too: its floating loss is only a lower bound", async () => {
  rows = [{ symbol: "EURUSD", side: "BUY", floatingPl: -7.5 }];
  const { exposure } = await resolveMissionPulsePhase7({ userId: 42, signals: {} as never });
  assert.equal(exposure.riskUnknownCount, 1);
  assert.equal(exposure.totalOpenRisk, 7.5);
});

test("no open positions: nothing unknown", async () => {
  rows = [];
  const { exposure } = await resolveMissionPulsePhase7({ userId: 42, signals: {} as never });
  assert.equal(exposure.openCount, 0);
  assert.equal(exposure.riskUnknownCount, 0);
});
