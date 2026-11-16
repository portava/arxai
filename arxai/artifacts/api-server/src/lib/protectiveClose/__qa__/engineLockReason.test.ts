// Protective Auto-Close journals (and returns via
// /api/me/protective-auto-close/decisions) a sentence for every evaluation.
// The engine passes two fixed product locks into the decision model:
// bridgeConnected:false and paperOnlyLock/liveLocked:true. decide.ts words
// them as readings — "MT5 bridge disconnected — alert only" and "paper-only
// lock active" — while the MT5 Bridge page may show the bridge online and an
// armed LIVE_SHARED trader is not paper-only. The decision and codes stay;
// only the sentence now says it is a product lock, not a reading.
//
// The real engine and the real decision model run; settings, activity,
// reversal analysis, ledger and journal are stubbed. No database, no broker.
//
// Run: node --import tsx --experimental-test-module-mocks --test --test-force-exit \
//        src/lib/protectiveClose/__qa__/engineLockReason.test.ts

import { mock, test } from "node:test";
import assert from "node:assert/strict";

const journalled: Array<{ decision: { decision: string; reason: string; blockedReason: string | null } }> = [];

mock.module("drizzle-orm", { namedExports: { and: () => null, eq: () => null, desc: () => null, gte: () => null } });
mock.module("@workspace/db", { namedExports: { db: { select: () => ({ from: () => ({ where: () => ({ limit: async () => [] }) }) }) } } });
mock.module("@workspace/db/schema", { namedExports: { sharedTradeAttributionTable: { id: {}, userId: {} } } });
mock.module("../../positions/ledger.js", {
  namedExports: { demoPositionLedger: { select: async () => [{ id: 11 }] }, demoPositionColumns: { id: {}, userId: {} } },
});
mock.module("../../logger.js", { namedExports: { logger: { info() {}, warn() {}, error() {} } } });
mock.module("../settings.js", {
  namedExports: {
    getEffectiveSettings: async () => ({
      enabled: true, inactivityThresholdMin: 15, mode: "AUTO_IF_INACTIVE", closeType: "FULL", partialClosePercent: 50,
      maxAutoClosesPerTrade: 1, cooldownMin: 30, minConfidence: "HIGH", requireMultiSignal: true,
      protectProfitEnabled: false, protectProfitGivebackPct: 50, maxLossProtectionEnabled: false, maxLossProtectionPct: 70,
      killSwitchEngaged: false, optInAt: null, optOutAt: null, source: "row",
    }),
  },
});
mock.module("../inactivity.js", {
  namedExports: { getActivityStatus: async () => ({ status: "INACTIVE", lastActiveAt: null, lastTradeInteractionAt: null, lastAiInteractionAt: null, inactiveDurationMs: 3_600_000, reason: "fixture" }) },
});
mock.module("../reversalSignals.js", {
  namedExports: {
    analyzeReversal: async () => ({
      signals: [], strongCount: 2, moderateCount: 1, confidence: "HIGH", dataStatus: "LIVE",
      currentPnl: 12, peakPnl: 40, givebackPercent: 70, invalidationLevel: 1.1, reasonSummary: "fixture",
    }),
  },
});
mock.module("../journal.js", {
  namedExports: {
    recordDecision: async (a: { decision: { decision: string; reason: string; blockedReason: string | null } }) => { journalled.push(a); },
    hasRecentAttempt: async () => false,
  },
});
mock.module("../../positionGuardian/manage.js", { namedExports: { guardianTradeActionClose: async () => { throw new Error("must not be called"); } } });

const { evaluateTrade, describeLockedDecision } = await import("../engine.js");

test("bridge lock: the journalled reason is a product lock, not 'MT5 bridge disconnected'", async () => {
  const r = await evaluateTrade(7, "lp_11", "EURUSD");
  assert.equal(r.decision.decision, "ALERT_ONLY");
  assert.equal(r.attemptedClose, false);
  assert.doesNotMatch(r.decision.reason, /bridge disconnected/i);
  assert.match(r.decision.reason, /not a reading of your bridge/);
  assert.equal(journalled.at(-1)?.decision.reason, r.decision.reason);
});

test("paper/live lock: BLOCKED keeps its code but no longer says 'paper-only lock active'", () => {
  const blocked = {
    decision: "BLOCKED" as const, reason: "paper-only lock active — auto-close blocked at gate", blockedReason: "BLOCKED_BY_PAPER_LOCK",
    suggestedClosePercent: 100, suggestedAction: "CLOSE_FULL" as const, guardsPassed: false,
    confidence: "HIGH" as const, dataStatus: "LIVE" as const, reversalSignals: [], invalidationLevel: null,
    currentPnl: null, peakPnl: null, givebackPercent: null, userInactive: true, inactiveDurationMs: 1, userOptedIn: true,
  };
  const d = describeLockedDecision(blocked as never);
  assert.equal(d.decision, "BLOCKED");
  assert.equal(d.blockedReason, "BLOCKED_BY_PAPER_LOCK");
  assert.doesNotMatch(d.reason, /paper-only/i);
  assert.match(d.reason, /fixed product lock/);
  // A real bridge reading (input true) would not be rewritten.
  const real = describeLockedDecision({ ...blocked, decision: "ALERT_ONLY", blockedReason: null, reason: "MT5 bridge disconnected — alert only" } as never, true);
  assert.equal(real.reason, "MT5 bridge disconnected — alert only");
});
