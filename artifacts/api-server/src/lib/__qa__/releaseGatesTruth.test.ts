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
  select: () => ({ from: () => ({
    where: () => ({ limit: async () => [], orderBy: () => ({ limit: async () => [] }) }),
    orderBy: () => ({ limit: async () => [] }),
  }) }),
} } });
mock.module("../systemHealth/audit.js", { namedExports: { listAudit: async () => [] } });
mock.module("../riskGovernor/riskProfile.js", { namedExports: {
  listRiskEventsView: async () => [],
  platformRiskPermissions: async () => ({ futureMt5: false }),
} });
mock.module("../autopilot.js", { namedExports: {
  listDecisions: () => [],
  listSessions: () => [],
  status: () => ({ running: false }),
} });
mock.module("../shadowMode.js", { namedExports: {
  shadowStatus: () => ({ ok: true }),
  forwardStatus: () => ({ ok: true }),
  readinessScore: () => ({ score: 1 }),
  listDecisions: () => [],
} });
mock.module("../oms.js", { namedExports: {
  omsDashboardSummary: () => ({ orders: 0 }),
  pnlSummary: () => ({ total: 0 }),
  listOrders: () => [],
  listPositions: () => [],
} });
mock.module("../data/providers/mt5Provider.js", { namedExports: {
  mt5Provider: {
    isConnected: async () => {
      if (mt5Connected === "throw") throw new Error("store unavailable");
      return mt5Connected;
    },
  },
} });

const { readinessReport, versionEnvelope, observedVersionEnvelope, diagnosticsPackage, diagnosticsSafetyAgrees } = await import("../release.js");
const { mt5SetupStatusFrom, exportWeeklyReport, exportDailyReport, startSession, dailyTestingStatus } = await import("../dailyTesting.js");

// Round 3: a connected feed was reported as mt5Deferred: true next to
// mt5Connected: true, and the gate failed it, so a working MT5 feed read as a
// release failure. The MT5 fields now follow the observation; the gate still
// observes the feed (it is no literal) and still fails closed when unreadable.
test("a connected MT5 feed is reported connected, not deferred, and is not a failed gate", async () => {
  mt5Connected = true;
  const r = await readinessReport();
  const g = r.gates.find((x) => x.key === "mt5_deferred_honesty_pass")!;
  assert.ok(g);
  assert.equal(r.mt5Connected, true);
  assert.equal(r.mt5Deferred, false, "no 'deferred' next to an observed connection");
  assert.equal(g.pass, true, "the report's MT5 fields match the observation");
  assert.equal(g.measured, true);
  assert.ok(!r.failedGates.includes("mt5_deferred_honesty_pass"));
  assert.doesNotMatch(String(g.detail), /mt5Connected=false/);
  assert.match(String(g.detail), /observed connected/i);
  assert.equal(r.realBrokerExecutionAvailable, false);
});

test("MT5 gate passes when the feed was checked and is not connected, reported as deferred", async () => {
  mt5Connected = false;
  const r = await readinessReport();
  const g = r.gates.find((x) => x.key === "mt5_deferred_honesty_pass")!;
  assert.equal(g.pass, true);
  assert.match(String(g.detail), /not connected/i);
  assert.equal(r.mt5Deferred, true);
  assert.equal(r.mt5Connected, false);
});

test("the version envelope's mt5Deferred follows the feed observed now", async () => {
  mt5Connected = true;
  const on = await observedVersionEnvelope();
  assert.equal(on.mt5Connected, true);
  assert.equal(on.mt5Deferred, false);
  assert.ok(on.mt5CheckedAt);
  mt5Connected = false;
  const off = await observedVersionEnvelope();
  assert.equal(off.mt5Deferred, true);
  mt5Connected = "throw";
  const unknown = await observedVersionEnvelope();
  assert.equal(unknown.mt5Connected, null, "unreadable is not 'not connected'");
});

test("the weekly report's MT5 line follows the readiness observation", () => {
  const at = "2026-10-28T09:00:00.000Z";
  assert.deepEqual(
    { connected: mt5SetupStatusFrom({ mt5Connected: true, evaluatedAt: at }).connected, deferred: mt5SetupStatusFrom({ mt5Connected: true, evaluatedAt: at }).deferred },
    { connected: true, deferred: false },
  );
  assert.equal(mt5SetupStatusFrom({ mt5Connected: false, evaluatedAt: at }).connected, false);
  assert.equal(mt5SetupStatusFrom({ mt5Connected: null, evaluatedAt: at }).connected, null);
  assert.match(mt5SetupStatusFrom({ mt5Connected: null, evaluatedAt: at }).note, /could not be checked/);
  assert.equal(mt5SetupStatusFrom(null).connected, null);
  assert.match(mt5SetupStatusFrom({ mt5Connected: true, evaluatedAt: at }).note, /observed connected/);
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

// Round 3 review: the diagnostics package embedded the observed readiness
// (mt5Connected: true, mt5Deferred: false) next to a literal safety block
// { mt5Connected: false, mt5Deferred: true }, so one payload contradicted
// itself, and acceptance S10 called it "honest" only because of the literals.
test("the diagnostics package's MT5 safety flags are the readiness observation, not literals", async () => {
  mt5Connected = true;
  const on = await diagnosticsPackage();
  assert.equal(on.readiness.mt5Connected, true);
  assert.equal(on.safety.mt5Connected, true, "no 'not connected' next to an observed connection");
  assert.equal(on.safety.mt5Deferred, false, "no 'deferred' next to an observed connection");
  assert.equal(on.safety.mt5CheckedAt, on.readiness.evaluatedAt);
  assert.equal(on.safety.realBrokerExecutionAvailable, false);
  assert.equal(diagnosticsSafetyAgrees(on), true);

  mt5Connected = false;
  const off = await diagnosticsPackage();
  assert.equal(off.safety.mt5Connected, false);
  assert.equal(off.safety.mt5Deferred, true);
  assert.equal(diagnosticsSafetyAgrees(off), true);

  mt5Connected = "throw";
  const unknown = await diagnosticsPackage();
  assert.equal(unknown.safety.mt5Connected, null, "unreadable is not 'not connected'");
  assert.equal(unknown.safety.mt5Deferred, true);
  assert.equal(diagnosticsSafetyAgrees(unknown), true);
});

test("S10's honesty check fails a safety block that contradicts the readiness observation", async () => {
  mt5Connected = true;
  const pkg = await diagnosticsPackage();
  assert.equal(diagnosticsSafetyAgrees({ ...pkg, safety: { ...pkg.safety, mt5Connected: false, mt5Deferred: true } }), false,
    "the old literal block next to an observed connection is not honest");
  assert.equal(diagnosticsSafetyAgrees({ ...pkg, safety: { ...pkg.safety, realBrokerExecutionAvailable: true } }), false);
  assert.equal(diagnosticsSafetyAgrees({ ...pkg, safety: undefined }), false);
});

test("the weekly export's note says what the MT5 feed was observed doing, not 'MT5 deferred'", async () => {
  mt5Connected = true;
  const out = await exportWeeklyReport();
  assert.equal(out.summary.mt5SetupStatus.connected, true);
  assert.doesNotMatch(out.note, /MT5 deferred/i, "no 'deferred' next to connected: true");
  assert.ok(out.note.startsWith(out.summary.mt5SetupStatus.note), out.note);

  mt5Connected = "throw";
  const unknown = await exportWeeklyReport();
  assert.match(unknown.note, /could not be checked/i);
});

// The daily export and the daily-testing status still printed a fixed
// "MT5 deferred." / mt5Deferred: true whatever the feed was doing, and both
// exports said "No real broker orders placed" although neither reads any live
// order or command table.
test("the daily export's note follows the MT5 observation, and no export claims an unchecked 'no real broker orders'", async () => {
  const s = startSession({ userRole: "OWNER" });
  mt5Connected = true;
  const daily = await exportDailyReport(s.sessionId);
  assert.ok(!("error" in daily), JSON.stringify(daily));
  const note = (daily as { note: string }).note;
  assert.doesNotMatch(note, /MT5 deferred/i, note);
  assert.match(note, /^MT5 feed observed connected/, note);
  assert.doesNotMatch(note, /No real broker orders placed/i, note);
  assert.match(note, /real broker orders were not checked/i, note);

  const weekly = await exportWeeklyReport();
  assert.doesNotMatch(weekly.note, /No real broker orders placed/i, weekly.note);
  assert.match(weekly.note, /real broker orders were not checked/i, weekly.note);

  mt5Connected = "throw";
  const unknown = await exportDailyReport(s.sessionId);
  assert.match((unknown as { note: string }).note, /could not be checked/i);
});

test("the daily-testing status reports mt5Deferred from the observation, not a literal", async () => {
  mt5Connected = true;
  const on = await dailyTestingStatus();
  assert.equal(on.mt5Deferred, false);
  assert.equal(on.mt5Connected, true);
  assert.ok(on.mt5CheckedAt);
  assert.doesNotMatch(on.note, /MT5 deferred/i, on.note);
  mt5Connected = false;
  const off = await dailyTestingStatus();
  assert.equal(off.mt5Deferred, true);
  assert.equal(off.mt5Connected, false);
  mt5Connected = "throw";
  const unread = await dailyTestingStatus();
  assert.equal(unread.mt5Deferred, true);
  assert.equal(unread.mt5Connected, null);
  assert.match(unread.note, /could not be checked/i);
});
