// Truth regression: Ruby must describe a pending-order draft's status the way
// the unified pending-order resolver does. Saving a draft, GET
// /me/bridge-capabilities and POST /:id/submit answer READ_ONLY for a
// connected EA that reports pendingOrders, because ARX's pending-order path is
// read-only and paper-only — not because the user's connection or account is
// locked. Ruby's prompt called READ_ONLY an "account-level lock" and said
// BLOCKED_BY_PAPER_LOCK was the expected status for an upgraded bridge, and its
// own getBridgeCapabilities tool used a different set of inputs, so it could
// answer BLOCKED_BY_PAPER_LOCK (or "your connection is in read-only mode")
// while the page said READ_ONLY. Reporting only — nothing here opens a gate.
//
// Run with --experimental-test-module-mocks (test:truth-component-evidence).
import { test, mock } from "node:test";
import assert from "node:assert/strict";

function emptyChain(): unknown {
  const chain: Record<string | symbol, unknown> = {};
  const proxy: unknown = new Proxy(chain, {
    get(_t, prop) {
      if (prop === "then") return (resolve: (v: unknown[]) => void) => resolve([]);
      return () => proxy;
    },
  });
  return proxy;
}
const fakeDb = { select: () => emptyChain() };

const realDb = await import("@workspace/db");
mock.module("@workspace/db", { namedExports: { ...realDb, db: fakeDb } });

let connection: Record<string, unknown> | null = null;
const realConnections = await import("../../brokerHub/connections.js");
mock.module("../../brokerHub/connections.js", {
  namedExports: {
    ...realConnections,
    getUserPrimaryConnection: async () => connection,
    listUserConnections: async () => (connection ? [connection] : []),
  },
});

const { getBridgeCapabilitiesTool, TOOL_DEFINITIONS } = await import("../tools.js");
const { buildSessionSystemMessages } = await import("../systemPrompt.js");
const { resolveRoutePendingStatus } = await import("../../../routes/pendingOrderDraft.js");
const { FAIL_CLOSED_ENVELOPE } = await import("../derivedEnvelope.js");

type Env = Parameters<typeof getBridgeCapabilitiesTool>[1];
const upgradedEa = () => ({
  lastHeartbeat: new Date(Date.now() - 5_000),
  eaVersion: "1.40",
  capabilities: { pendingOrders: true, stopLimitOrders: true, marketOrders: true },
  capabilitiesReportedAt: new Date(Date.now() - 5_000),
});

test("Ruby's getBridgeCapabilities gives the same status and reason as the pending-order route, whatever the account envelope", async () => {
  connection = upgradedEa();
  const route = resolveRoutePendingStatus(connection as never, false, Date.now());
  assert.equal(route.status, "READ_ONLY");

  const envs: Array<[string, Env]> = [
    ["armed live account", { ...FAIL_CLOSED_ENVELOPE, liveLocked: false, readOnlyMode: false, allowOrderExecution: true } as Env],
    ["paper account", { ...FAIL_CLOSED_ENVELOPE, liveLocked: true, readOnlyMode: false, allowOrderExecution: false } as Env],
    ["trading disabled", { ...FAIL_CLOSED_ENVELOPE, liveLocked: true, readOnlyMode: true, allowOrderExecution: false } as Env],
  ];
  for (const [label, env] of envs) {
    const out = await getBridgeCapabilitiesTool(7, env) as Record<string, unknown>;
    assert.equal(out.ok, true, label);
    assert.equal(out.currentSubmitStatus, route.status, `${label}: Ruby and the page give one status`);
    assert.equal(out.currentSubmitExplanation, route.reason, `${label}: Ruby and the page give one reason`);
    assert.doesNotMatch(String(out.currentSubmitExplanation), /connection is in read-only mode/, label);
    assert.equal(out.pendingOrderExecutable, false, label);
  }

  // No heartbeat: disconnected, and Ruby says so the same way the page does.
  connection = { ...upgradedEa(), lastHeartbeat: new Date(Date.now() - 10 * 60_000) };
  const stale = await getBridgeCapabilitiesTool(7, envs[0]![1]) as Record<string, unknown>;
  const staleRoute = resolveRoutePendingStatus(connection as never, false, Date.now());
  assert.equal(stale.currentSubmitStatus, "BRIDGE_DISCONNECTED");
  assert.equal(stale.currentSubmitExplanation, staleRoute.reason);
});

test("Ruby's prompt and tool descriptions do not call READ_ONLY an account lock or BLOCKED_BY_PAPER_LOCK the expected status", () => {
  const prompt = buildSessionSystemMessages(7, null, null, null).map((m) => m.content).join("\n");
  assert.doesNotMatch(prompt, /READ_ONLY \/ LIVE_LOCKED \(account-level locks\)/);
  assert.doesNotMatch(prompt, /BLOCKED_BY_PAPER_LOCK \([^)]*expected status even when the bridge is fully upgraded/);
  assert.match(prompt, /READ_ONLY is the expected answer for a connected EA that reports pendingOrders/);
  assert.match(prompt, /not because of the user's connection or account/);

  const describe = (name: string) => String((TOOL_DEFINITIONS as unknown as Array<{ name: string; description: string }>)
    .find((t) => t.name === name)?.description);
  assert.doesNotMatch(describe("getMyPendingOrderDrafts"), /nearly every submit returns BLOCKED_BY_PAPER_LOCK/);
  assert.match(describe("getMyPendingOrderDrafts"), /READ_ONLY/);
  assert.match(describe("getMyPendingOrderDrafts"), /currentSubmitExplanation/);
  assert.match(describe("getBridgeCapabilities"), /same answer as the pending-order page/);
});

// bridgeConnected is the shared heartbeat policy (online under 60 s), and the
// same description says BRIDGE_DISCONNECTED means "no heartbeat in the last
// minute", yet it told Ruby bridgeConnected was true "within the last ~90s".
// With a heartbeat 75 s old Ruby got bridgeConnected:false and a 90 s window.
test("Ruby is told the bridgeConnected window the tool actually uses (60 seconds)", async () => {
  const { MT5_HEARTBEAT_OFFLINE_AT_SECONDS } = await import("@workspace/domain/broker-health/heartbeatPolicy");
  const describe = String((TOOL_DEFINITIONS as unknown as Array<{ name: string; description: string }>)
    .find((t) => t.name === "getBridgeCapabilities")?.description);
  assert.doesNotMatch(describe, /~90s|90 ?s(econds)?/);
  assert.match(describe, new RegExp(`bridgeConnected \\(bool, true only if a heartbeat arrived within the last ${MT5_HEARTBEAT_OFFLINE_AT_SECONDS} seconds`));

  connection = { ...upgradedEa(), lastHeartbeat: new Date(Date.now() - 75_000) };
  const out = await getBridgeCapabilitiesTool(7, FAIL_CLOSED_ENVELOPE as Env) as Record<string, unknown>;
  assert.equal(out.bridgeConnected, false, "75 s old is outside the window the description now states");
});
