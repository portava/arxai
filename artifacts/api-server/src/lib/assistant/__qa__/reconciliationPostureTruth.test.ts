// Truth regression: getReconciliationStatus must describe the user's REAL
// live-execution posture (the derived envelope every other assistant surface
// reads), never a hard-coded "paper-only by construction / placement always
// BLOCKED" constant. An armed live account and a paper account must not get the
// same placement claim. Reporting only — nothing here opens or loosens a gate.
//
// Run with --experimental-test-module-mocks (test:truth-component-evidence).
import { test, mock } from "node:test";
import assert from "node:assert/strict";

// A chainable fake drizzle query: every builder method returns the chain and
// awaiting it yields no rows (no attribution rows, no unattributed fills).
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

let primaryConnection: Record<string, unknown> | null = null;
const realConnections = await import("../../brokerHub/connections.js");
mock.module("../../brokerHub/connections.js", {
  namedExports: {
    ...realConnections,
    getUserPrimaryConnection: async () => primaryConnection,
  },
});

type Env = Awaited<ReturnType<typeof import("../derivedEnvelope.js").deriveAssistantEnvelope>>;
const realEnvelope = await import("../derivedEnvelope.js");
let currentEnv: Env = realEnvelope.FAIL_CLOSED_ENVELOPE;
mock.module("../derivedEnvelope.js", {
  namedExports: {
    ...realEnvelope,
    deriveAssistantEnvelope: async () => currentEnv,
  },
});

const { getReconciliationStatus } = await import("../tools.js");

const ARMED_LIVE: Env = {
  ...realEnvelope.FAIL_CLOSED_ENVELOPE,
  liveLocked: false,
  allowOrderExecution: true,
  bannerLabel: "Live Trading Active",
  bannerReason: "",
} as Env;

const PAPER: Env = {
  ...realEnvelope.FAIL_CLOSED_ENVELOPE,
  liveLocked: true,
  allowOrderExecution: false,
  bannerLabel: "Trading Off",
  bannerReason: "Trading not enabled for this account.",
} as Env;

function connectedBridge(): Record<string, unknown> {
  return {
    id: 1,
    lastHeartbeat: new Date(Date.now() - 5_000).toISOString(),
    liveLocked: false,
    readOnlyMode: false,
    accountNumber: "123",
    serverName: "Demo-Server",
  };
}

const PAPER_CONSTANTS = [/paper-only by construction/i, /placeLiveOrderGuarded always/i, /Real placement is still BLOCKED/i];

test("armed live account: no 'paper-only / always BLOCKED' constant, placement reads the live note", async () => {
  currentEnv = ARMED_LIVE;
  primaryConnection = connectedBridge();
  const r = await getReconciliationStatus(7);
  assert.equal(r.reconciliationStatus, "NO_ROUTED_TRADES");
  for (const re of PAPER_CONSTANTS) {
    assert.doesNotMatch(r.note, re, `note must not hard-code paper posture: ${r.note}`);
    assert.doesNotMatch(r.placementLayerNote, re, `placementLayerNote must not hard-code paper posture: ${r.placementLayerNote}`);
  }
  assert.notEqual(r.placementLayer, "BROKER_PLACEMENT_LAYER_NOT_IMPLEMENTED");
  assert.equal(r.placementLayer, "LIVE_DISPATCH_GATED");
  assert.match(r.placementLayerNote, /Live order execution is available for your account/);
  assert.match(r.placementLayerNote, /confirmation/);
});

test("paper / locked account: placement reads locked with the envelope's real reason", async () => {
  currentEnv = PAPER;
  primaryConnection = connectedBridge();
  const r = await getReconciliationStatus(8);
  assert.equal(r.placementLayer, "LIVE_LOCKED_FOR_ACCOUNT");
  assert.equal(r.placementLayerNote, "Trading not enabled for this account.");
  assert.match(r.note, /nothing to reconcile yet/);
  assert.match(r.note, /Trading not enabled for this account\./);
});

test("bridge offline: still says reconciliation cannot run, and never claims live is on", async () => {
  currentEnv = PAPER;
  primaryConnection = null;
  const r = await getReconciliationStatus(9);
  assert.equal(r.reconciliationStatus, "BRIDGE_OFFLINE");
  assert.equal(r.bridge.connected, false);
  assert.equal(r.placementLayer, "LIVE_LOCKED_FOR_ACCOUNT");
  assert.doesNotMatch(r.placementLayerNote, /available for your account/);
});

test("connected bridge label is not presented as the account's live permission", async () => {
  currentEnv = ARMED_LIVE;
  primaryConnection = connectedBridge();
  const r = await getReconciliationStatus(10);
  assert.equal(r.bridge.mode, "READ_ONLY");
  assert.match(r.bridge.modeNote, /connection label only — it is not this account's live-trading permission/);
  primaryConnection = null;
  const off = await getReconciliationStatus(11);
  assert.match(off.bridge.modeNote, /offline/);
});
