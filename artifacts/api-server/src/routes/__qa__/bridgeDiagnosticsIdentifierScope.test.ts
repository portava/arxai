// GET /api/mt5/heartbeat/status and /api/mt5/bridge-diagnostics describe the
// install-wide EA feed: for most callers that is another user's terminal. The
// booleans, counts and timestamps are for everyone; the remote IPs, the
// accepted broker account number and the terminal user agent are operator-only
// and come back null for a non-operator, with the response saying so.
//
// Only the database handle is stubbed; the real router runs. No network, no broker.
//
// Run: node --import tsx --experimental-test-module-mocks --test --test-force-exit \
//        src/routes/__qa__/bridgeDiagnosticsIdentifierScope.test.ts

import { mock, test } from "node:test";
import assert from "node:assert/strict";
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";

const PLATFORM_ROW = {
  id: 1, userId: null, account: "99887766", broker: "Other Tenant Broker", server: "OT-Live",
  balance: 1, equity: 1, margin: 0, freeMargin: 1, marginLevel: 0, currency: "USD", liveAllowed: false,
  positions: [], lastHeartbeatAt: new Date(Date.now() - 2_000), lastSyncAt: new Date(Date.now() - 2_000),
};

const database = await import("@workspace/db");
function chain(rows: unknown[]): Record<string, unknown> {
  const q: Record<string, unknown> = {};
  const self = () => q;
  q.from = self; q.where = self; q.groupBy = self; q.orderBy = self; q.limit = self;
  q.then = (resolve: (v: unknown[]) => unknown) => Promise.resolve(rows).then(resolve);
  return q;
}
mock.module("@workspace/db", {
  namedExports: {
    ...database,
    db: {
      select: () => chain([PLATFORM_ROW]),
      insert: () => { throw new Error("diagnostics reads must not write"); },
    },
  },
});

const { default: express } = await import("express");
const { default: router } = await import("../mt5.js");

const IDENTIFIER_FIELDS = ["lastRejectRemoteIp", "lastAcceptedAccount", "lastAcceptedRemoteIp", "lastAcceptedUserAgent"] as const;

async function get(path: string, authUser: { id: number; role: string } | null): Promise<{ status: number; body: Record<string, unknown> }> {
  const app = express();
  app.use((req, _res, next) => {
    if (authUser) (req as unknown as { authUser: unknown }).authUser = authUser;
    (req as unknown as { log: unknown }).log = { info() {}, warn() {}, error() {} };
    next();
  });
  app.use(router);
  const server: Server = await new Promise((resolve) => { const s = app.listen(0, "127.0.0.1", () => resolve(s)); });
  try {
    const port = (server.address() as AddressInfo).port;
    const res = await fetch(`http://127.0.0.1:${port}${path}`);
    return { status: res.status, body: (await res.json()) as Record<string, unknown> };
  } finally {
    await new Promise<void>((r) => server.close(() => r()));
  }
}

test("heartbeat status: a trader gets the platform booleans but no identifiers, and is told so", async () => {
  const r = await get("/mt5/heartbeat/status", { id: 31, role: "USER" });
  assert.equal(r.status, 200);
  assert.equal(r.body["scope"], "platform");
  assert.equal(r.body["requesterScope"], "user");
  assert.equal(typeof r.body["redactionNote"], "string");
  assert.equal(typeof r.body["eaConnected"], "boolean");
  for (const f of IDENTIFIER_FIELDS) {
    assert.ok(f in r.body, `${f} key stays in the shape`);
    assert.equal(r.body[f], null, `${f} is null for a non-operator`);
  }
});

test("heartbeat status: an operator sees the identifier fields with no redaction note", async () => {
  const r = await get("/mt5/heartbeat/status", { id: 1, role: "ADMIN" });
  assert.equal(r.status, 200);
  assert.equal(r.body["requesterScope"], "operator");
  assert.equal(r.body["redactionNote"], null);
  for (const f of IDENTIFIER_FIELDS) assert.ok(f in r.body, `${f} present for an operator`);
});

test("bridge diagnostics: the scope and redaction statement are present for a trader, absent for an operator", async () => {
  const user = await get("/mt5/bridge-diagnostics", { id: 31, role: "USER" });
  assert.equal(user.status, 200);
  assert.equal(user.body["scope"], "platform");
  assert.equal(user.body["requesterScope"], "user");
  assert.equal(typeof user.body["redactionNote"], "string");
  assert.equal(typeof user.body["bridgeConnected"], "boolean");
  assert.equal(typeof user.body["heartbeatAgeSeconds"] === "number" || user.body["heartbeatAgeSeconds"] === null, true);

  const op = await get("/mt5/bridge-diagnostics", { id: 1, role: "OWNER" });
  assert.equal(op.status, 200);
  assert.equal(op.body["requesterScope"], "operator");
  assert.equal(op.body["redactionNote"], null);
});
