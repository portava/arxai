// getUserPermissions swallows a failed read of user_trading_permissions and
// returns null, and getEnvelope then took its "no permission row" branch: a
// new fail-closed object with bannerReason "Trading not enabled for this
// account.". GET /me/first-run-readiness only treated the FAIL_CLOSED_ENVELOPE
// object itself as unread, so a failed read came back as liveLockRead=true,
// live_locked PASS "Live order execution is locked for your account. Trading
// not enabled for this account." — a failed read shown as a confirmed account
// setting, with a reason nobody observed.
//
// Every lock value stays exactly as strict (the order guard reads the same
// envelope). Only the reason text and the "was this read" answer change.
//
// The real getEnvelope and the real router run, in-process; the database
// handle, platform switches, broker connections, auth, provider and
// notifications are stubbed (no server, no network, no database).
//
// Run: node --import tsx --experimental-test-module-mocks --test --test-force-exit \
//        src/routes/__qa__/firstRunReadinessPermissionsUnread.test.ts

import { mock, test } from "node:test";
import assert from "node:assert/strict";

const database = await import("@workspace/db");
const { userTradingPermissionsTable } = await import("@workspace/db/schema");

const state: { permissions: "throw" | "none" | Record<string, unknown> } = { permissions: "throw" };

function chain(rows: () => unknown[]): Record<string, unknown> {
  const q: Record<string, unknown> = {};
  let target: unknown = null;
  const self = () => q;
  q.from = (t: unknown) => { target = t; return q; };
  q.where = self; q.groupBy = self; q.orderBy = self; q.limit = self;
  q.then = (resolve: (v: unknown[]) => unknown, reject?: (e: unknown) => unknown) => {
    if (target === userTradingPermissionsTable) {
      if (state.permissions === "throw") return Promise.reject(new Error("connection terminated")).then(resolve, reject);
      return Promise.resolve(state.permissions === "none" ? [] : [state.permissions]).then(resolve, reject);
    }
    return Promise.resolve(rows()).then(resolve, reject);
  };
  return q;
}
mock.module("@workspace/db", {
  namedExports: { ...database, db: { select: () => chain(() => []) } },
});

const NO_STOP = { engaged: false, sources: [], reason: null, detail: {}, readable: true };
mock.module("../../lib/safety/platformSwitches.js", {
  namedExports: {
    getGlobalTradingConfig: async () => ({ accountRoutingMode: "USER_OWNED_MT5" }),
    loadPlatformSettings: async () => ({
      config: { accountRoutingMode: "USER_OWNED_MT5", sharedDemoConnectionId: null, sharedLiveConnectionId: null, sharedLiveTradingEnabled: false },
      switches: {
        readable: true, unreadableReason: null, rowCount: 1, platformMode: "LIVE",
        venueEnabled: { DEMO: true, LIVE: true }, venueOpen: { DEMO: true, LIVE: true },
        emergencyStop: { engaged: false, reason: null, engagedAt: null },
      },
    }),
    platformStopWith: async () => NO_STOP,
    stopSourceEngaged: (s: { sources: string[] }, src: string) => s.sources.includes(src),
    platformStopReport: (s: typeof NO_STOP) => ({ platformStopEngaged: s.engaged, platformStopSources: [...s.sources], platformStopReason: s.reason }),
  },
});
mock.module("../../lib/brokerHub/connections.js", {
  namedExports: {
    listUserConnections: async () => [],
    getConnection: async () => null,
    getUserPrimaryConnection: async () => null,
  },
});
mock.module("../../lib/auth/middleware.js", {
  namedExports: {
    requireUser: (req: { authUser?: unknown }, _res: unknown, next: () => void) => { req.authUser = { id: 7 }; next(); },
  },
});
mock.module("../../lib/assistant/marketProvider.js", {
  namedExports: { getMarketProvider: () => ({ name: "none", features: {} }) },
});
mock.module("../../lib/notifications/service.js", { namedExports: { getPreferences: async () => ({ inAppEnabled: true }) } });

const { getEnvelope, envelopeUnread } = await import("../../lib/adminTrading/safetyEnvelope.js");
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

test("a failed permissions read keeps every lock fail-closed and says the permissions could not be read", async () => {
  state.permissions = "throw";
  const env = await getEnvelope(7);
  // Every lock value is exactly as strict as before.
  assert.equal(env.tradingMode, "DISABLED");
  assert.equal(env.liveLocked, true);
  assert.equal(env.allowOrderExecution, false);
  assert.equal(env.readOnlyMode, true);
  assert.equal(env.bannerLabel, "Trading Off");
  // The reason is what was observed, not a made-up account setting.
  assert.doesNotMatch(env.bannerReason, /Trading not enabled for this account/);
  assert.match(env.bannerReason, /could not be read/);
  assert.equal(envelopeUnread(env), true);
});

test("no permission row (read succeeded) is still a reading: 'Trading not enabled for this account.'", async () => {
  state.permissions = "none";
  const env = await getEnvelope(7);
  assert.equal(env.liveLocked, true);
  assert.equal(env.allowOrderExecution, false);
  assert.equal(env.bannerReason, "Trading not enabled for this account.");
  assert.equal(envelopeUnread(env), false);
});

test("first-run readiness: a failed permissions read is liveLockRead=false and WARN, never a PASS", async () => {
  state.permissions = "throw";
  const { status, body } = await call();
  assert.equal(status, 200);
  assert.equal(body.liveLocked, true, "fails closed, same shape");
  assert.equal(body.allowOrderExecution, false);
  assert.equal(body.liveLockRead, false);
  const lock = item(body, "live_locked");
  assert.equal(lock.status, "WARN");
  assert.match(lock.detail, /could not be read/);
  assert.doesNotMatch(lock.detail, /Trading not enabled for this account/);
  assert.equal(item(body, "paper_mode").status, "WARN");
});

test("first-run readiness: a read with no permission row is a read lock (PASS)", async () => {
  state.permissions = "none";
  const { body } = await call();
  assert.equal(body.liveLockRead, true);
  const lock = item(body, "live_locked");
  assert.equal(lock.status, "PASS");
  assert.match(lock.detail, /Trading not enabled for this account/);
});
