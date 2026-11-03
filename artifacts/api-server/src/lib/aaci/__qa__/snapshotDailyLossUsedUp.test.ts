// AACI snapshot — a used-up daily cap (round-3 review, r2-views).
//
// Trader readiness reports dailyLossLimit 0 when a percent daily cap is set
// and the paper risk-count equity is at or below 0: a percent of it allows no
// loss, the cap is used up and the Risk Governor refuses every new trade.
// The snapshot only valued a cap above 0, so 0 read as "no cap": dailyLossHit
// stayed undefined, AACI's loss-limit hard-gate factor passed
// (lossLimitPass = !dailyLossHit) and the risk-alignment score dropped the
// daily-loss factor instead of scoring it 0, while readiness said the cap is
// used up. A 0 cap is now a reached cap.
//
// Trader readiness and the per-user side reads are stubbed; the real
// buildAaciSnapshot and the real domain scoring run. No database, no network.
//
// Run: node --import tsx --experimental-test-module-mocks --test --test-force-exit \
//        src/lib/aaci/__qa__/snapshotDailyLossUsedUp.test.ts
import { mock, test } from "node:test";
import assert from "node:assert/strict";

const state: { metrics: Record<string, unknown>; hardBlocks: Array<Record<string, unknown>> } = { metrics: {}, hardBlocks: [] };

const realReadiness = await import("../../readiness/traderReadiness.js");
mock.module("../../readiness/traderReadiness.js", {
  namedExports: {
    ...realReadiness,
    evaluateReadiness: async () => ({
      overallStatus: state.hardBlocks.length ? "WATCH_ONLY" : "PAPER_ALLOWED", hardBlocks: state.hardBlocks,
      metrics: state.metrics, readinessScore: 40, generatedAt: new Date().toISOString(),
    }),
  },
});
const realAlerts = await import("../../alerts/alertManager.js");
mock.module("../../alerts/alertManager.js", { namedExports: { ...realAlerts, getUnreadCount: async () => 0 } });
const realFleet = await import("../../selfTrade/selfTradeSupervisor.js");
mock.module("../../selfTrade/selfTradeSupervisor.js", {
  namedExports: { ...realFleet, computeFleetHealth: async () => ({ fundedAgents: 0, activeAgents: 0, totalAgents: 0, accounting: { status: "RECORDED" } }) },
});

const { buildAaciSnapshot } = await import("../snapshotService.js");
const { computeRiskAlignment } = await import("@workspace/domain/aaci");

const EXHAUSTED = { code: "PAPER_RISK_COUNT_EQUITY_EXHAUSTED", severity: "BLOCK", message: "used up" };

test("a used-up daily cap (0) is a reached cap: dailyLossHit true, never 'no cap'", async () => {
  state.metrics = { dailyLossLimit: 0, dailyPnl: 0, openPaperTrades: 0 };
  state.hardBlocks = [EXHAUSTED];
  const snap = await buildAaciSnapshot({ userId: 7, role: "user" });
  assert.equal(snap.risk?.dailyLossHit, true, "readiness says the daily cap is used up");
  assert.equal(snap.risk?.hardPass, false);
});

test("the risk-alignment score counts the used-up cap as 0, not as a dropped factor", async () => {
  state.metrics = { dailyLossLimit: 0, dailyPnl: 0, openPaperTrades: 0 };
  state.hardBlocks = [EXHAUSTED];
  const usedUp = await buildAaciSnapshot({ userId: 7, role: "user" });
  const dropped = { ...usedUp, risk: { ...usedUp.risk!, dailyLossHit: undefined } };
  assert.ok(computeRiskAlignment(usedUp) < computeRiskAlignment(dropped),
    `scored ${computeRiskAlignment(usedUp)} vs dropped ${computeRiskAlignment(dropped)}`);
});

test("no daily cap enforced (null) stays unknown, and a positive cap is measured as before", async () => {
  state.hardBlocks = [];
  state.metrics = { dailyLossLimit: null, dailyPnl: -50, openPaperTrades: 0 };
  assert.equal((await buildAaciSnapshot({ userId: 7, role: "user" })).risk?.dailyLossHit, undefined);
  state.metrics = { dailyLossLimit: 250, dailyPnl: -100, openPaperTrades: 0 };
  assert.equal((await buildAaciSnapshot({ userId: 7, role: "user" })).risk?.dailyLossHit, false);
  state.metrics = { dailyLossLimit: 250, dailyPnl: -250, openPaperTrades: 0 };
  assert.equal((await buildAaciSnapshot({ userId: 7, role: "user" })).risk?.dailyLossHit, true);
});
