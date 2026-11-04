// Trader Coach readiness truth. When the Risk Governor / readiness evaluation
// could not run, the coach report must say so: no readiness score, grade or
// level (the old fallbacks 0 / "F" / "NOT_READY" read as a measured verdict),
// no paper/autopilot permission claim either way, and a header that agrees
// with the coaching summary's "Readiness unavailable.".
//
// evaluateReadiness is the only stub; generateCoachReport is the real code
// (its DB reads fail against the unreachable test DATABASE_URL and are
// recorded as missing sources, which is what the coach already handles).
//
// Run: pnpm --filter @workspace/api-server run test:truth-component-evidence

import { mock, test } from "node:test";
import assert from "node:assert/strict";

let governorThrows = true;
const realReadiness = await import("../../readiness/traderReadiness.js");
mock.module("../../readiness/traderReadiness.js", {
  namedExports: {
    ...realReadiness,
    evaluateReadiness: async () => {
      if (governorThrows) throw new Error("db hiccup");
      return {
        governor_id: "gov_qa", overallStatus: "PAPER_CAUTION", paperTradingAllowed: true, autopilotAllowed: false,
        readinessScore: 64, readinessGrade: "C", readinessLevel: "DEVELOPING",
        hardBlocks: [], softWarnings: [], riskFlags: [],
      };
    },
  },
});

const { generateCoachReport } = await import("../coach.js");

test("governor not evaluated: traderStatus carries no readiness verdict and agrees with the summary", async () => {
  governorThrows = true;
  const r = await generateCoachReport({ userId: 991, persist: false });
  assert.equal(r.traderStatus.readinessEvaluated, false);
  assert.equal(r.traderStatus.readinessScore, null, "0 is not a measured readiness score");
  assert.equal(r.traderStatus.readinessGrade, null, "F is not a measured grade");
  assert.equal(r.traderStatus.readinessLevel, null, "NOT_READY is not a measured level");
  assert.equal(r.traderStatus.paperTradingAllowed, null, "permission is unknown, not false");
  assert.equal(r.traderStatus.autopilotAllowed, null);
  assert.equal(r.traderStatus.liveTradingAllowed, false);
  assert.equal(r.traderStatus.governorStatus, "UNKNOWN");
  assert.match(r.traderStatus.readinessUnavailableReason ?? "", /could not be evaluated/i);
  assert.match(r.coachingSummary, /Readiness unavailable\./);
  assert.ok(r.missingDataSources.includes("risk_governor_evaluations"));
});

test("governor evaluated: traderStatus reports the governor's own readiness", async () => {
  governorThrows = false;
  const r = await generateCoachReport({ userId: 991, persist: false });
  assert.equal(r.traderStatus.readinessEvaluated, true);
  assert.equal(r.traderStatus.readinessScore, 64);
  assert.equal(r.traderStatus.readinessGrade, "C");
  assert.equal(r.traderStatus.readinessLevel, "DEVELOPING");
  assert.equal(r.traderStatus.paperTradingAllowed, true);
  assert.equal(r.traderStatus.autopilotAllowed, false);
  assert.equal(r.traderStatus.readinessUnavailableReason, null);
  assert.match(r.coachingSummary, /Readiness 64\/C \(DEVELOPING\)\./);
});
