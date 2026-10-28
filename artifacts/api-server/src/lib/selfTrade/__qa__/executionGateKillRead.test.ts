// Pre-decision kill-switch read (executionGate.evaluateAgentExecution).
//
// Offline: the kill-switch gate and the quota/P&L readers are module-mocked;
// no query is issued (DATABASE_URL is a loopback URL that never connects).
// Proves (a) an engaged verdict becomes KILL_SWITCH_ENGAGED, decisively, and
// (b) a READ FAILURE rejects the evaluation instead of producing a verdict, so
// executeAgentDecision throws before any reservation or submission.
//
// Run: node --import tsx --experimental-test-module-mocks --test --test-force-exit \
//   src/lib/selfTrade/__qa__/executionGateKillRead.test.ts

process.env.DATABASE_URL ??= "postgres://nobody@127.0.0.1:1/none";

import { mock, test } from "node:test";
import assert from "node:assert/strict";

let killBehavior: () => Promise<unknown> = async () => ({ killed: false, scope: null, scopeRef: null, reason: null });
const killInputs: unknown[] = [];
mock.module("../killSwitchGate.js", {
  namedExports: {
    assertAgentNotKilled: async (input: unknown) => {
      killInputs.push(input);
      return killBehavior();
    },
  },
});
mock.module("../agentQuotaEngine.js", {
  namedExports: {
    computeQuotaFromSettings: () => ({ dailyMinTrades: 0, baseMaxTrades: 5, effectiveMaxTrades: 5 }),
    countAgentFilledTradesToday: async () => 0,
    startOfUtcDay: (d: Date) => d,
  },
});
mock.module("../../mt5/userMasterLiveAccessGate.js", {
  namedExports: { loadAndEvaluateUserMasterLiveAccessGate: async () => ({ decision: "PASS" }) },
});
mock.module("../../positions/openPositions.js", {
  namedExports: { selectLiveOpenPositions: async () => [], RISK_COUNT_BASIS: "UNCLOSED" },
});
mock.module("../../positions/ledger.js", { namedExports: { livePositionColumns: {} } });

const { evaluateAgentExecution } = await import("../executionGate.js");
const { db } = await import("@workspace/db");
// computeAgentDailyPnlUsd reads executions through db.select(); answer empty.
(db as unknown as { select: unknown }).select = () => ({ from: () => ({ where: async () => [] }) });

const input = () => ({
  agent: {
    id: 1, agentKey: "alpha", status: "ACTIVE", mode: "LIVE", autonomyLevel: 3, ownerId: null, createdByUserId: null,
  },
  settings: { maxDailyLossUsd: 100, dailyProfitGoalUsd: 100, maxConcurrentPositions: 1 },
  ledger: { allocatedFunds: 1000 },
  decision: {
    id: 7, symbol: "EURUSD", setupType: "BREAKOUT", outcome: "APPROVED",
    thesis: { side: "BUY", stopLoss: 1.09, takeProfits: [] }, setupExpiresAt: null,
  },
  fleet: { governor: { status: "PAPER_ALLOWED", hardBlocks: [] }, handshake: { ready: true, degraded: [], blocked: [] } },
}) as unknown as Parameters<typeof evaluateAgentExecution>[0];

test("the pre-decision read passes agent, decision symbol and setup type to the gate", async () => {
  killInputs.length = 0;
  await evaluateAgentExecution(input());
  assert.deepEqual(killInputs, [{ agentKey: "alpha", symbol: "EURUSD", strategy: "BREAKOUT" }]);
});

test("an engaged switch is the decisive block (KILL_SWITCH_ENGAGED)", async () => {
  killBehavior = async () => ({ killed: true, scope: "SYMBOL", scopeRef: "EURUSD", reason: "news" });
  const r = await evaluateAgentExecution(input());
  assert.equal(r.verdict.permitted, false);
  assert.equal(r.verdict.blockCode, "KILL_SWITCH_ENGAGED");
  assert.equal(r.kill.scope, "SYMBOL");
});

test("a kill-switch READ FAILURE rejects the evaluation (no verdict, never a permit)", async () => {
  killBehavior = async () => {
    throw new Error("simulated kill-switch read failure");
  };
  await assert.rejects(evaluateAgentExecution(input()), /simulated kill-switch read failure/);
});
