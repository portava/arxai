// A future-dated heartbeat never counts as fresh in the live dispatch gate,
// the live arming check, the live-test preflight, /me/live or the watchdog.
//
// The defect this locks: liveCommandPipeline (gate 7 input), liveArming
// (check #3 HEARTBEAT_FRESH), adminLiveTestReadiness (preflight bridge facts),
// meLive (/me/live/bridge-debug) and bridgeWatchdog computed
// Math.max(0, floor((now - lastHeartbeat) / 1000)), so a heartbeat dated 30 s
// after the server's clock (clock skew between instances) read as 0 s —
// fresh — while the shared heartbeat policy says a future-dated heartbeat's
// age cannot be verified: unknown, never fresh. This only makes the gates
// stricter.
//
// The database is an empty in-memory stub and the connection list is
// replaced; nothing reaches a database, broker or network.
//
// Run: node --import tsx --experimental-test-module-mocks --test --test-force-exit \
//        src/lib/live/__qa__/futureHeartbeatGates.test.ts

import { after, before, beforeEach, mock, test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";

type Chain = ((...a: unknown[]) => Chain) & { [k: string]: unknown };
function emptyChain(): Chain {
  const target = function () { /* stub */ } as unknown as Chain;
  const p: Chain = new Proxy(target, {
    get(_t, k) {
      if (k === "then") return (resolve: (v: unknown[]) => void) => resolve([]);
      return () => p;
    },
    apply() { return p; },
  });
  return p;
}

const dbModule = await import("@workspace/db");
mock.module("@workspace/db", { namedExports: { ...dbModule, db: emptyChain() } });

let bridgeRow: Record<string, unknown> | null = null;
const connMod = await import("../../brokerHub/connections.js");
mock.module("../../brokerHub/connections.js", {
  namedExports: {
    ...connMod,
    getUserActiveConnection: async () => bridgeRow,
    listConnections: async () => (bridgeRow ? [bridgeRow] : []),
    listUserConnections: async () => (bridgeRow ? [bridgeRow] : []),
  },
});

const { evaluateLiveArmingGate } = await import("../liveArming.js");
const { classifyBridge } = await import("../bridgeWatchdog.js");
const { heartbeatAgeSecondsFrom } = await import("../../brokerHub/freshness.js");
const { evaluateLivePhaseBDispatchGate } = await import("@workspace/domain/safety-contracts/livePhaseBDispatchGate");
const { default: express } = await import("express");
const { default: readinessRouter } = await import("../../../routes/adminLiveTestReadiness.js");

function liveBridge(lastHeartbeat: Date) {
  return {
    id: 31, userId: 4242, mode: "LIVE", accountType: "live", eaVersion: "1.50", status: "ACTIVE",
    brokerName: "Broker", serverName: "Broker-Live", accountNumber: "77001234",
    lastHeartbeat, tokenRevokedAt: null,
    capabilities: { eaInputs: { terminalConnected: true, algoTradingAllowed: true, readOnlyMode: false, enableLiveExecution: true } },
  };
}

const future = () => new Date(Date.now() + 30_000);
const recent = () => new Date(Date.now() - 2_000);

let server: Server;
let base = "";
before(async () => {
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    (req as unknown as { authUser: { id: number; role: string } }).authUser = { id: 4242, role: "OWNER" };
    next();
  });
  app.use("/api", readinessRouter);
  server = app.listen(0);
  await new Promise<void>((r) => server.once("listening", () => r()));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
after(async () => { await new Promise<void>((r) => server.close(() => r())); });
beforeEach(() => { bridgeRow = null; });

test("shared helper: a future-dated heartbeat has no age; a past one is whole seconds", () => {
  const now = Date.parse("2026-11-03T12:00:00.000Z");
  assert.equal(heartbeatAgeSecondsFrom(new Date(now + 30_000), now), null);
  assert.equal(heartbeatAgeSecondsFrom(new Date(now + 1), now), null);
  assert.equal(heartbeatAgeSecondsFrom(new Date(now - 4_500), now), 4);
  assert.equal(heartbeatAgeSecondsFrom(new Date(now), now), 0);
  assert.equal(heartbeatAgeSecondsFrom(null, now), null);
  assert.equal(heartbeatAgeSecondsFrom("not a date", now), null);
});

test("dispatch gate 7: a bridge heartbeat 30 s in the future fails EA_HEARTBEAT_STALE and says why", () => {
  const now = Date.now();
  const hb = new Date(now + 30_000);
  const result = evaluateLivePhaseBDispatchGate({
    liveBrokerExecutionEnabled: true, globalLiveEnabled: true, userLiveApproved: true, userArmed: true,
    killSwitchEngaged: false, bridgeAccountType: "live",
    bridgeHeartbeatAgeSec: heartbeatAgeSecondsFrom(hb, now),
    bridgeLastHeartbeatAt: hb.toISOString(),
    bridgeEaVersion: "1.50", bridgeEnableLiveExecution: true, bridgeReadOnlyMode: false,
    bridgeTerminalConnected: true, bridgeAlgoTradingAllowed: true,
    commandSymbol: "EURUSD", commandVolume: 0.01, commandHasStopLoss: true,
    allowedSymbols: ["EURUSD"], maxLotForSymbol: 1, dailyLossLimitUsd: 0, realisedDailyLossUsd: 0,
    requireStopLoss: true, adminAllowNoStopLoss: false, requireTakeProfit: false, adminAllowNoTakeProfit: true,
    commandHasTakeProfit: true, disclosureAccepted: true,
  });
  const gate = result.gates.find((g) => g.key === "EA_HEARTBEAT_STALE");
  assert.ok(gate, "gate 7 is evaluated");
  assert.equal(gate.passed, false);
  assert.ok(result.blockReasons.includes("EA_HEARTBEAT_STALE"));
  assert.match(gate.detail ?? "", /after the server's clock/);
  assert.doesNotMatch(gate.detail ?? "", /No heartbeat received yet/);
});

test("the dispatch pipeline and the other sites no longer clamp a heartbeat age to 0", () => {
  const here = fileURLToPath(new URL(".", import.meta.url));
  const files = [
    "../liveCommandPipeline.ts", "../liveArming.ts", "../bridgeWatchdog.ts",
    "../../../routes/adminLiveTestReadiness.ts", "../../../routes/meLive.ts",
  ];
  const clamp = /Math\.max\(\s*0\s*,\s*Math\.floor\(\s*\((?:Date\.now\(\)|now(?:\.getTime\(\))?)\s*-\s*(?:new Date\()?[\w.?]*[lL]astHeartbeat/;
  for (const f of files) {
    const src = readFileSync(here + f, "utf8");
    assert.ok(!clamp.test(src), `${f} still clamps a future-dated heartbeat to 0s`);
  }
  const pipeline = readFileSync(here + "../liveCommandPipeline.ts", "utf8");
  assert.ok(/bridgeHeartbeatAgeSec: hbAge/.test(pipeline), "gate 7 reads hbAge");
  assert.ok(/const hbAge = heartbeatAgeSecondsFrom\(/.test(pipeline), "hbAge comes from the shared policy helper");
});

test("arming check #3: a heartbeat 30 s in the future is not fresh", async () => {
  bridgeRow = liveBridge(future());
  const r = await evaluateLiveArmingGate({
    userId: 4242, isAdmin: true, confirmationPhrase: "", riskAcknowledged: false, accountNumberConfirmed: "",
    maxLotConfirmed: 0, dailyLossLimitConfirmed: 0, killSwitchAcknowledged: false,
  });
  const check = r.checks.find((c) => c.key === "HEARTBEAT_FRESH");
  assert.ok(check);
  assert.equal(check.passed, false);
  assert.match(check.reason ?? "", /after the server's clock/);
  assert.equal(r.evidence.heartbeatAgeSeconds, null);
});

test("arming check #3: the same bridge with a 2 s old heartbeat still passes", async () => {
  bridgeRow = liveBridge(recent());
  const r = await evaluateLiveArmingGate({
    userId: 4242, isAdmin: true, confirmationPhrase: "", riskAcknowledged: false, accountNumberConfirmed: "",
    maxLotConfirmed: 0, dailyLossLimitConfirmed: 0, killSwitchAcknowledged: false,
  });
  assert.equal(r.checks.find((c) => c.key === "HEARTBEAT_FRESH")?.passed, true);
});

test("arming check #3: an invalid heartbeat is refused without a formatting exception", async () => {
  bridgeRow = liveBridge(new Date(Number.NaN));
  const r = await evaluateLiveArmingGate({
    userId: 4242, isAdmin: true, confirmationPhrase: "", riskAcknowledged: false, accountNumberConfirmed: "",
    maxLotConfirmed: 0, dailyLossLimitConfirmed: 0, killSwitchAcknowledged: false,
  });
  const check = r.checks.find(c => c.key === "HEARTBEAT_FRESH");
  assert.equal(check?.passed, false);
  assert.match(check?.reason ?? "", /invalid timestamp/);
  assert.equal(r.evidence.heartbeatAgeSeconds, null);
});

test("preflight: a future-dated master bridge heartbeat has no age and fails gate 7", async () => {
  bridgeRow = liveBridge(future());
  const stateRes = await fetch(`${base}/api/admin/live-test-readiness/state`);
  const stateText = await stateRes.text();
  assert.equal(stateRes.status, 200, stateText.slice(0, 600));
  const state = JSON.parse(stateText) as {
    panelA_currentConnectedBridge: { heartbeatAgeSeconds: number | null; lastHeartbeatAt: string | null };
  };
  assert.equal(state.panelA_currentConnectedBridge.heartbeatAgeSeconds, null);
  assert.ok(state.panelA_currentConnectedBridge.lastHeartbeatAt);
  const preRes = await fetch(`${base}/api/admin/live-test-readiness/preflight`, {
    method: "POST", headers: { "content-type": "application/json" }, body: "{}",
  });
  const preText = await preRes.text();
  assert.equal(preRes.status, 200, preText.slice(0, 400));
  const pre = JSON.parse(preText) as { gates: Array<{ key: string; passed: boolean; detail: string | null }>; currentConnectedBridge: { heartbeatAgeSeconds: number | null } };
  assert.equal(pre.currentConnectedBridge.heartbeatAgeSeconds, null);
  const g7 = pre.gates.find((g) => g.key === "EA_HEARTBEAT_STALE");
  assert.equal(g7?.passed, false);
  assert.match(g7?.detail ?? "", /after the server's clock/);
});

test("watchdog: a future-dated heartbeat is offline with no age, never 'last heartbeat 0s ago'", () => {
  const now = new Date("2026-11-03T12:00:00.000Z");
  const v = classifyBridge({
    connectionId: 1, userId: 1, connectionName: "c", tokenRevokedAt: null,
    lastHeartbeat: new Date(now.getTime() + 30_000), accountType: "live", eaVersion: "1.50",
    eaInputs: {}, now,
  });
  assert.equal(v.liveness, "offline");
  assert.equal(v.heartbeatAgeSeconds, null);
  assert.doesNotMatch(v.summary, /0s ago|never sent/);
  assert.match(v.summary, /after the server's clock/);
  const never = classifyBridge({
    connectionId: 1, userId: 1, connectionName: "c", tokenRevokedAt: null,
    lastHeartbeat: null, accountType: "live", eaVersion: "1.50", eaInputs: {}, now,
  });
  assert.match(never.summary, /never sent a heartbeat/);
});
