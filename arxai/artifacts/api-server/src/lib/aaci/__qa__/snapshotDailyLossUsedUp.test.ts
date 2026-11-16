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

// Round-3 safety review (s3-views): when readiness could not read the
// trader's paper loss count (PAPER_RISK_COUNT_UNREADABLE "paper_book"), its
// dailyPnl and openPaperTrades are placeholder 0s. The snapshot still read
// them: dailyLossHit was false (0 <= -250 is false), so the risk-alignment
// score counted the daily-loss factor as a measured 100, appOpenCount was 0,
// and lossLimitPass passed, while readiness said the daily loss limit cannot
// be checked. With only the risk-count equity unread and a percent-only cap,
// dailyLossLimit is null and the unvalued cap read as "no cap" (pass). An
// unread loss count is now unknown, never a pass.
const { buildAaciDecision } = await import("../decisionService.js");
const UNREADABLE = { code: "PAPER_RISK_COUNT_UNREADABLE", severity: "BLOCK", message: "could not be loaded" };

test("an unread paper book: the daily-loss factor is unknown (never a measured pass) and the open count is not stated", async () => {
  state.metrics = { dailyLossLimit: 250, dailyPnl: 0, openPaperTrades: 0, paperRiskCountUnreadable: ["paper_book"] };
  state.hardBlocks = [UNREADABLE];
  const snap = await buildAaciSnapshot({ userId: 7, role: "user" });
  assert.equal(snap.risk?.dailyLossHit, undefined, "was false: a placeholder 0 loss scored as under the cap");
  assert.equal(snap.risk?.lossFactsUnread, true);
  assert.equal(snap.positions.appOpenCount, undefined, "was the placeholder 0");
  const scoredPass = { ...snap, risk: { ...snap.risk!, dailyLossHit: false } };
  assert.notEqual(computeRiskAlignment(snap), computeRiskAlignment(scoredPass), "the factor no longer scores 100");
});

test("an unread loss count never passes AACI's loss-limit factor, and the failure says it could not be checked", async () => {
  for (const metrics of [
    { dailyLossLimit: 250, dailyPnl: 0, openPaperTrades: 0, paperRiskCountUnreadable: ["paper_book"] },
    // percent-only cap on an unread risk-count equity: no cap value at all
    { dailyLossLimit: null, dailyPnl: -10, openPaperTrades: 1, paperRiskCountUnreadable: ["risk_count_equity"] },
    // the trader's limits could not be read
    { dailyLossLimit: null, dailyPnl: -10, openPaperTrades: 1, paperRiskCountUnreadable: [], riskLimitsUnreadable: true },
  ]) {
    state.metrics = metrics;
    state.hardBlocks = [UNREADABLE];
    const snap = await buildAaciSnapshot({ userId: 7, role: "user" });
    assert.equal(snap.risk?.dailyLossHit, undefined, JSON.stringify(metrics));
    const d = await buildAaciDecision({ snapshot: snap, userId: 7, actorType: "user", actionRequested: "advisory", persist: false });
    assert.equal(d.hardGatePass, false);
    assert.ok(d.hardGateFailures.includes("LOSS_LIMIT_UNCHECKED"), `${JSON.stringify(metrics)}: failures ${d.hardGateFailures.join(", ")}`);
    assert.ok(!d.hardGateFailures.includes("LOSS_LIMIT_REACHED"), "no limit was shown to be reached");
  }
});

test("a loss count read past the cap is still a reached limit, and a read count under the cap passes as before", async () => {
  state.hardBlocks = [];
  state.metrics = { dailyLossLimit: 250, dailyPnl: -300, openPaperTrades: 1, paperRiskCountUnreadable: [] };
  let d = await buildAaciDecision({ snapshot: await buildAaciSnapshot({ userId: 7, role: "user" }), userId: 7, actorType: "user", actionRequested: "advisory", persist: false });
  assert.ok(d.hardGateFailures.includes("LOSS_LIMIT_REACHED"));
  assert.ok(!d.hardGateFailures.includes("LOSS_LIMIT_UNCHECKED"));
  state.metrics = { dailyLossLimit: 250, dailyPnl: -100, openPaperTrades: 1, paperRiskCountUnreadable: [] };
  const snap = await buildAaciSnapshot({ userId: 7, role: "user" });
  assert.equal(snap.positions.appOpenCount, 1);
  assert.equal(snap.risk?.lossFactsUnread, undefined);
  d = await buildAaciDecision({ snapshot: snap, userId: 7, actorType: "user", actionRequested: "advisory", persist: false });
  assert.ok(!d.hardGateFailures.some((c) => c.startsWith("LOSS_LIMIT")), `failures ${d.hardGateFailures.join(", ")}`);
});
