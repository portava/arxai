// GET /me/first-run-readiness spread a frozen { liveLocked: true,
// allowOrderExecution: false } into every response and hard-coded the
// live_locked item as PASS "Live execution is BLOCKED by the safety core" and
// the paper_mode item as PASS "No live broker order can be placed". The
// dashboard's "Setup & readiness" panel printed "live trading locked" and
// "Live trading remains BLOCKED" from that constant, also for a live-approved
// user whose per-user safety envelope permits live order execution.
//
// The lock now comes from the user's safety envelope (getEnvelope, which fails
// closed). An envelope that could not be read keeps liveLocked=true (same
// shape) but says liveLockRead=false and earns no PASS.
//
// The real router runs, called in-process (no server, no network); auth, the
// envelope, broker connections, provider, notifications and the database
// handle are stubbed.
//
// Run: node --import tsx --experimental-test-module-mocks --test --test-force-exit \
//        src/routes/__qa__/firstRunReadinessLiveLock.test.ts

import { mock, test } from "node:test";
import assert from "node:assert/strict";

const database = await import("@workspace/db");

function chain(): Record<string, unknown> {
  const q: Record<string, unknown> = {};
  const self = () => q;
  q.from = self; q.where = self; q.groupBy = self; q.orderBy = self; q.limit = self;
  q.then = (resolve: (v: unknown[]) => unknown, reject?: (e: unknown) => unknown) => Promise.resolve([]).then(resolve, reject);
  return q;
}
mock.module("@workspace/db", {
  namedExports: { ...database, db: { select: () => chain() } },
});

type Env = Record<string, unknown>;
const FAIL_CLOSED_ENVELOPE: Env = {
  tradingMode: "DISABLED", allowOrderExecution: false, liveLocked: true, readOnlyMode: true,
  bannerLabel: "Trading Off", bannerReason: "Default fail-closed state.", safetyMode: "off",
};
const LIVE: Env = {
  tradingMode: "LIVE", allowOrderExecution: true, liveLocked: false, readOnlyMode: false,
  bannerLabel: "Live Trading Active", bannerReason: "Live trading is active. Real money is at risk.", safetyMode: "live",
};
const DEMO: Env = {
  tradingMode: "DEMO", allowOrderExecution: false, liveLocked: true, readOnlyMode: false,
  bannerLabel: "Demo Trading Active", bannerReason: "Demo trading is active. No real money is at risk.", safetyMode: "demo",
};
const state: { env: Env | Error } = { env: DEMO };

mock.module("../../lib/adminTrading/safetyEnvelope.js", {
  namedExports: {
    FAIL_CLOSED_ENVELOPE,
    envelopeUnread: (env: Env) => env === FAIL_CLOSED_ENVELOPE,
    getEnvelope: async () => {
      if (state.env instanceof Error) throw state.env;
      return state.env;
    },
  },
});
mock.module("../../lib/auth/middleware.js", {
  namedExports: {
    requireUser: (req: { authUser?: unknown }, _res: unknown, next: () => void) => { req.authUser = { id: 7 }; next(); },
  },
});
mock.module("../../lib/brokerHub/connections.js", { namedExports: { listUserConnections: async () => [] } });
mock.module("../../lib/assistant/marketProvider.js", {
  namedExports: { getMarketProvider: () => ({ name: "none", features: {} }) },
});
mock.module("../../lib/notifications/service.js", { namedExports: { getPreferences: async () => ({ inAppEnabled: true }) } });

const { default: router } = await import("../meFirstRunReadiness.js");

interface Item { key: string; label: string; status: string; detail: string }

async function call(): Promise<{ status: number; body: Record<string, unknown> }> {
  return await new Promise((resolve, reject) => {
    let status = 200;
    const res = {
      status(c: number) { status = c; return res; },
      json(b: Record<string, unknown>) { resolve({ status, body: b }); return res; },
      setHeader() {}, getHeader() { return undefined; },
    };
    const url = "/me/first-run-readiness";
    const req = {
      method: "GET", url, originalUrl: url, path: url, headers: {}, query: {}, params: {}, body: {},
      log: { error() {}, warn() {}, info() {} },
    };
    (router as unknown as { handle: (q: unknown, s: unknown, n: (e?: unknown) => void) => void })
      .handle(req, res, (e?: unknown) => reject(e ?? new Error("no route")));
  });
}

function item(body: Record<string, unknown>, key: string): Item {
  const it = (body.items as Item[]).find((i) => i.key === key);
  assert.ok(it, key);
  return it;
}

test("a LIVE envelope: liveLocked=false, and no item says live is blocked or orders are paper-only", async () => {
  state.env = LIVE;
  const { status, body } = await call();
  assert.equal(status, 200);
  assert.equal(body.liveLocked, false);
  assert.equal(body.allowOrderExecution, true);
  assert.equal(body.liveLockRead, true);
  const lock = item(body, "live_locked");
  assert.notEqual(lock.status, "PASS");
  assert.doesNotMatch(lock.detail, /BLOCKED|locked for your account/i);
  assert.match(lock.detail, /permits live order execution/);
  const paper = item(body, "paper_mode");
  assert.notEqual(paper.status, "PASS");
  assert.doesNotMatch(paper.detail, /No live broker order can be placed|All order flows route to the paper engine/);
});

test("a DEMO envelope: the lock is read from the envelope and passes", async () => {
  state.env = DEMO;
  const { body } = await call();
  assert.equal(body.liveLocked, true);
  assert.equal(body.allowOrderExecution, false);
  assert.equal(body.liveLockRead, true);
  const lock = item(body, "live_locked");
  assert.equal(lock.status, "PASS");
  assert.match(lock.detail, /locked for your account/);
  assert.match(lock.detail, /Demo trading is active/);
});

test("an unread envelope (fail-closed default or a throw) keeps liveLocked=true but is not a PASS", async () => {
  for (const env of [FAIL_CLOSED_ENVELOPE, new Error("db down")]) {
    state.env = env;
    const { status, body } = await call();
    assert.equal(status, 200);
    assert.equal(body.liveLocked, true, "fails closed, same shape");
    assert.equal(body.allowOrderExecution, false);
    assert.equal(body.liveLockRead, false);
    const lock = item(body, "live_locked");
    assert.notEqual(lock.status, "PASS");
    assert.match(lock.detail, /could not be read/);
    assert.notEqual(item(body, "paper_mode").status, "PASS");
  }
});

// The row headline must match the reading: the admin "Setup & readiness" panel
// prints the label in bold above the detail, so a constant "Live trading
// locked" sat over "Not locked: ... permits live order execution" (LIVE) and
// over "could not be read" (unread). Same for "Paper mode enabled" over
// "your account is not paper-only".
test("row labels follow the envelope: no 'locked' headline for a LIVE or unread envelope", async () => {
  state.env = LIVE;
  let { body } = await call();
  assert.notEqual(item(body, "live_locked").label, "Live trading locked");
  assert.match(item(body, "live_locked").label, /not locked/i);
  assert.doesNotMatch(item(body, "paper_mode").label, /Paper mode enabled/);
  for (const env of [FAIL_CLOSED_ENVELOPE, new Error("db down")]) {
    state.env = env;
    ({ body } = await call());
    const lock = item(body, "live_locked");
    assert.doesNotMatch(lock.label, /^Live trading locked$/);
    assert.match(lock.label, /could not be read/i);
    assert.doesNotMatch(item(body, "paper_mode").label, /Paper mode enabled/);
  }
  state.env = DEMO;
  ({ body } = await call());
  assert.equal(item(body, "live_locked").label, "Live trading locked");
});
