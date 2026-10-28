// Truth regression: Release Status gates must report what was checked.
// Before: several gates were literal `true` (PASS with a canned detail), the
// MT5 gate always read "mt5Connected=false" whatever the feed was doing, the
// score summed those constants to 100, and "Last updated" was the request
// time of every call.
import { test, mock } from "node:test";
import assert from "node:assert/strict";

let mt5Connected: boolean | "throw" = false;

const realDb = await import("@workspace/db");
mock.module("@workspace/db", { namedExports: { ...realDb, db: {
  select: () => ({ from: () => ({ where: () => ({ limit: async () => [] }) }) }),
} } });
mock.module("../systemHealth/audit.js", { namedExports: { listAudit: async () => [] } });
mock.module("../riskGovernor/riskProfile.js", { namedExports: {
  listRiskEventsView: async () => [],
  platformRiskPermissions: async () => ({ futureMt5: false }),
} });
mock.module("../autopilot.js", { namedExports: {
  listDecisions: () => [],
  status: () => ({ running: false }),
} });
mock.module("../shadowMode.js", { namedExports: {
  shadowStatus: () => ({ ok: true }),
  forwardStatus: () => ({ ok: true }),
  readinessScore: () => ({ score: 1 }),
} });
mock.module("../oms.js", { namedExports: {
  omsDashboardSummary: () => ({ orders: 0 }),
  pnlSummary: () => ({ total: 0 }),
} });
mock.module("../data/providers/mt5Provider.js", { namedExports: {
  mt5Provider: {
    isConnected: async () => {
      if (mt5Connected === "throw") throw new Error("store unavailable");
      return mt5Connected;
    },
  },
} });

const { readinessReport, versionEnvelope } = await import("../release.js");

test("MT5 gate reflects an MT5 feed that is pushing data", async () => {
  mt5Connected = true;
  const r = await readinessReport();
  const g = r.gates.find((x) => x.key === "mt5_deferred_honesty_pass")!;
  assert.ok(g);
  assert.equal(g.pass, false, "a connected MT5 feed contradicts the 'MT5 deferred' claim");
  assert.doesNotMatch(String(g.detail), /mt5Connected=false/);
  assert.match(String(g.detail), /connected/i);
  assert.equal(r.mt5Connected, true);
});

test("MT5 gate passes only when the feed was checked and is not connected", async () => {
  mt5Connected = false;
  const r = await readinessReport();
  const g = r.gates.find((x) => x.key === "mt5_deferred_honesty_pass")!;
  assert.equal(g.pass, true);
  assert.match(String(g.detail), /not connected/i);
});

test("MT5 gate fails closed when the feed state cannot be read", async () => {
  mt5Connected = "throw";
  const r = await readinessReport();
  const g = r.gates.find((x) => x.key === "mt5_deferred_honesty_pass")!;
  assert.equal(g.pass, false);
  assert.match(String(g.detail), /could not be checked/i);
  assert.equal(r.mt5Connected, null);
});

test("gates with no check behind them are not PASS and keep the score under 100", async () => {
  mt5Connected = false;
  const r = await readinessReport();
  const unchecked = r.gates.filter((g) => g.measured === false);
  assert.ok(unchecked.length > 0, "route/simulator/live-intent gates have no check");
  for (const g of unchecked) {
    assert.equal(g.pass, false, `${g.key} must not read PASS without a check`);
    assert.match(String(g.detail), /not checked/i);
  }
  assert.ok(r.readinessScore < 100);
  assert.equal(r.releaseReady, false);
});

test("version 'lastUpdated' is not the request time", async () => {
  const a = versionEnvelope().lastUpdated;
  await new Promise((res) => setTimeout(res, 1100));
  const b = versionEnvelope().lastUpdated;
  assert.equal(a, b);
  assert.equal(versionEnvelope().lastUpdatedBasis, "server_start");
});
