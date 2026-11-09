// Truth: Eleanor's Memory (GET /performance/ai-command-center and
// /performance/equity-curve) is built from the paper book (paper_orders).
// The calendar and day routes in the same file withhold the paper book from
// a LIVE_SHARED session; these two did not, so paper win rate, P&L and the
// equity curve appeared under a LIVE account strip. They now return the same
// mode-scoped envelope, and say which book a non-live view is built from.
import { test, mock } from "node:test";
import assert from "node:assert/strict";
import { withRouter } from "./_fakeRouteDb.js";

let accountMode: "LIVE_SHARED" | "PAPER" = "LIVE_SHARED";
const realScope = await import("../../lib/modeScope/getUserModeScope.js");
mock.module("../../lib/modeScope/getUserModeScope.js", { namedExports: {
  ...realScope,
  getUserModeScope: async () => ({ currentAccountMode: accountMode }),
} });
let paperReads = 0;
const realAgg = await import("../../lib/performanceCC/aggregator.js");
mock.module("../../lib/performanceCC/aggregator.js", { namedExports: {
  ...realAgg,
  computeEquityCurve: async () => { paperReads++; return { points: [{ trade_id: 1, cumulative: 12.5 }] }; },
  computeAutopilotSummary: async () => { paperReads++; return { cycles: 1 }; },
} });
const realCc = await import("../../lib/performanceCC/commandCenter.js");
mock.module("../../lib/performanceCC/commandCenter.js", { namedExports: {
  ...realCc,
  buildCommandCenter: async () => { paperReads++; return { winRate: 60, netPnl: 12.5, totalClosedTrades: 5, insights: [], warnings: [] }; },
} });
const router = (await import("../performanceCommandCenter.js")).default;

async function getJson(path: string): Promise<Record<string, any>> {
  let body: Record<string, any> = {};
  await withRouter(router, { id: 7, role: "user" }, async (base) => {
    const r = await fetch(`${base}${path}`);
    body = await r.json() as Record<string, any>;
    assert.equal(r.status, 200, JSON.stringify(body));
  });
  return body;
}

test("LIVE_SHARED: Eleanor's Memory does not carry paper win rate / P&L", async () => {
  accountMode = "LIVE_SHARED";
  paperReads = 0;
  const body = await getJson("/performance/ai-command-center");
  assert.equal(body.currentAccountMode, "LIVE_SHARED");
  assert.equal(body.modeScopeApplied, true);
  assert.equal(body.commandCenter, null);
  assert.equal(body.autopilot, null);
  assert.match(String(body.modeNote), /live account/i);
  assert.match(String(body.modeNote), /paper/i);
  assert.equal(paperReads, 0, "the paper book is not read for a live session");
});

test("LIVE_SHARED: the 30d equity curve is not the paper curve", async () => {
  accountMode = "LIVE_SHARED";
  paperReads = 0;
  const body = await getJson("/performance/equity-curve?range=30d");
  assert.equal(body.currentAccountMode, "LIVE_SHARED");
  assert.equal(body.equityCurve, null);
  assert.match(String(body.modeNote), /live account/i);
  assert.equal(paperReads, 0);
});

test("PAPER: the envelope says the figures are from the paper book", async () => {
  accountMode = "PAPER";
  const cc = await getJson("/performance/ai-command-center");
  assert.equal(cc.currentAccountMode, "PAPER");
  assert.equal(cc.modeScopeApplied, true);
  assert.equal(cc.dataSource, "paper_orders");
  assert.equal(cc.commandCenter.netPnl, 12.5);
  const eq = await getJson("/performance/equity-curve?range=30d");
  assert.equal(eq.dataSource, "paper_orders");
  assert.equal(eq.equityCurve.points.length, 1);
});
