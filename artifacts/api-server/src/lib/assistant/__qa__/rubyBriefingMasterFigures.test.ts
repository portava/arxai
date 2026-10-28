// Truth regression: the master bridge pool stores a null MT5 balance/equity as
// 0 (its columns are NOT NULL) and marks the snapshot FRESH from the heartbeat
// alone. Ruby's owner briefing must not print "balance USD 0.00" when the EA
// never reported the figures; it checks the master connection's own account
// snapshot (connectionAccountSnapshot) and says what is missing instead.
//
// Run with --experimental-test-module-mocks (test:truth-component-evidence).
import { test, mock } from "node:test";
import assert from "node:assert/strict";

const pool = {
  id: 1, masterConnectionId: 77, mt5Balance: 0, mt5Equity: 0, mt5FreeMargin: 0, mt5UsedMargin: 0,
  accountCurrency: "USD", totalAllocated: 0, totalReservedRisk: 0, totalUserUnrealizedPnl: 0,
  allocationDeficit: 0, isOverAllocated: false, snapshotStatus: "FRESH",
};
const realPool = await import("../../live/masterBridgePool.js");
mock.module("../../live/masterBridgePool.js", {
  namedExports: {
    ...realPool,
    getUserAllocationView: async () => ({
      pool, assignedAllocation: 0, reservedRisk: 0, availableAllocation: 0, openFloatingLoss: 0,
      hasAllocation: false, bridgeAvailability: "HEALTHY", bridgeMessage: "Live bridge is healthy.",
    }),
  },
});

let conn: Record<string, unknown> | null = null;
let connReadFails = false;
const realConnections = await import("../../brokerHub/connections.js");
mock.module("../../brokerHub/connections.js", {
  namedExports: {
    ...realConnections,
    getConnection: async () => {
      if (connReadFails) throw new Error("db down");
      return conn;
    },
  },
});

const { buildRubyContext, composeRubyBriefing } = await import("../rubyContext.js");

function master(over: Record<string, unknown>): Record<string, unknown> {
  return {
    id: 77, userId: 1, accountNumber: "123", brokerName: "B", serverName: "S", accountCurrency: "USD",
    accountBalance: null, accountEquity: null, margin: null, freeMargin: null,
    accountSyncedAt: new Date(), lastHeartbeat: new Date(),
    ...over,
  };
}

async function masterLine(): Promise<string> {
  const ctx = await buildRubyContext(1, "OWNER", "/", null);
  const lines = composeRubyBriefing(ctx).lines;
  const line = lines.find((l) => l.startsWith("Master MT5"));
  assert.ok(line, lines.join(" | "));
  return line!;
}

test("FRESH pool, EA reported no balance/equity: no '$0.00' figures", async () => {
  conn = master({ accountBalance: null, accountEquity: null });
  const line = await masterLine();
  assert.doesNotMatch(line, /USD 0\.00/);
  assert.match(line, /has not reported the account's balance and equity/);
});

test("FRESH pool, EA never synced account figures (DB default 0): not shown as 0", async () => {
  conn = master({ accountBalance: 0, accountEquity: 0, accountSyncedAt: null });
  const line = await masterLine();
  assert.doesNotMatch(line, /USD 0\.00/);
  assert.match(line, /has not reported/);
});

test("the master connection could not be read: figures could not be checked", async () => {
  connReadFails = true;
  try {
    const line = await masterLine();
    assert.doesNotMatch(line, /USD 0\.00/);
    assert.match(line, /could not be checked/);
  } finally {
    connReadFails = false;
  }
});

test("reported figures (including a real 0) are shown as before", async () => {
  conn = master({ accountBalance: 0, accountEquity: 0 });
  assert.equal(await masterLine(), "Master MT5: balance USD 0.00, equity USD 0.00, open P/L USD 0.00.");
});
