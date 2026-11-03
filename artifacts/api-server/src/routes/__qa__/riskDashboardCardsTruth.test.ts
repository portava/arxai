// Regression: Risk Command Center's "Overtrading" card (GET
// /risk/dashboard-cards) read "NORMAL" when the trader's activity could not
// be read (no paper account, or the paper closes read failed and
// riskOverview set activity: null). "Trades today" and "Losses in a row"
// already showed "—" for the same state, so NORMAL was an unmeasured pass.
// It is now UNKNOWN when there is no activity to judge.
//
// The route runs for real; riskOverview, propFirmStatus and requireUser are
// mocked. No database, no network.
//
// Run: node --import tsx --experimental-test-module-mocks --test --test-force-exit \
//        src/routes/__qa__/riskDashboardCardsTruth.test.ts

import { after, before, test, mock } from "node:test";
import assert from "node:assert/strict";
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import express from "express";

const state: { activity: Record<string, number> | null; budget: Record<string, unknown> } = { activity: null, budget: {} };

mock.module("../../lib/auth/middleware.js", {
  namedExports: {
    requireUser: (req: { authUser?: unknown }, _res: unknown, next: () => void) => {
      req.authUser = { id: 7, role: "USER" };
      next();
    },
  },
});
mock.module("../../lib/live/liveArming.js", {
  namedExports: { engageKillSwitchForUser: async () => undefined, releaseKillSwitchForUser: async () => undefined },
});
mock.module("../../lib/riskGovernor/riskEvents.js", {
  namedExports: { getOrCreateRiskSettings: async () => ({ riskPreset: null }) },
});
mock.module("../../lib/riskGovernor/journal.js", {
  namedExports: { previewJournalTicket: async () => { throw new Error("not used"); } },
});
mock.module("../../lib/riskGovernor/riskProfile.js", {
  namedExports: {
    RISK_PRESETS: ["CONSERVATIVE"],
    applyRiskPreset: async () => ({}),
    configurePropFirm: async () => ({ config: {} }),
    listRiskEventsView: async () => [],
    propFirmStatus: async () => ({ config: { enabled: false } }),
    riskOverview: async () => ({
      venue: "PAPER",
      limits: {},
      budget: {
        riskStatus: "OK", dailyRiskRemaining: 100, weeklyRiskRemaining: 300, openRisk: 0, openPositions: 0,
        ...state.budget,
      },
      activity: state.activity,
      halt: { engaged: false, sources: [], reason: null },
      permissions: { trading: true, pauseReason: null, stopSwitchEngaged: false, blockedBy: [] },
    }),
  },
});

const { default: router } = await import("../riskProfile.js");

let server: Server;
let base = "";
before(async () => {
  const app = express();
  app.use(express.json());
  app.use(router);
  server = app.listen(0);
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
after(() => { server?.close(); });

async function cards() {
  const r = await fetch(`${base}/risk/dashboard-cards`);
  assert.equal(r.status, 200);
  return r.json() as Promise<Record<string, unknown>>;
}

test("no activity measured: Overtrading is UNKNOWN, not NORMAL", async () => {
  state.activity = null;
  const c = await cards();
  assert.equal(c["tradesToday"], null);
  assert.equal(c["consecutiveLosses"], null);
  assert.equal(c["overtrading"], "UNKNOWN", "nothing was measured, so there is no NORMAL to report");
});

test("measured activity keeps its verdicts", async () => {
  const quiet = { tradesToday: 1, consecutiveLosses: 0, closesInLastHour: 0, reentriesAfterLossInLastHour: 0 };
  state.activity = quiet;
  assert.equal((await cards())["overtrading"], "NORMAL");
  state.activity = { ...quiet, closesInLastHour: 5 };
  assert.equal((await cards())["overtrading"], "OVERTRADING_RISK");
  state.activity = { ...quiet, reentriesAfterLossInLastHour: 2 };
  assert.equal((await cards())["overtrading"], "REVENGE_TRADING_RISK");
});

// A weekly cap whose use could not be measured comes back with a null
// weeklyRiskRemaining. Without the flag the card could not tell that from
// "no cap set", which is what the page then said.
test("an unmeasured daily / weekly use is flagged on the cards, so a null 'left' is not 'no cap set'", async () => {
  state.budget = { weeklyRiskRemaining: null, weeklyRiskUsedUnmeasured: true, dailyRiskUsedUnmeasured: false };
  try {
    const c = await cards();
    assert.equal(c["weeklyRiskRemaining"], null);
    assert.equal(c["weeklyRiskUsedUnmeasured"], true);
    assert.equal(c["dailyRiskUsedUnmeasured"], false);
  } finally {
    state.budget = {};
  }
});
