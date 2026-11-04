// GET /api/alerts/scanner — the scanner alert list is one in-memory list for
// the whole platform. It must say so (scope), must not keep alerts forever,
// must label alerts whose timeframe has moved on, and its count must be the
// true number of open alerts or say it is a lower bound — never silently
// stop at 100.
//
// The real scanner module and router run; time is mocked. No DB, no network.
//
// Run: node --import tsx --experimental-test-module-mocks --test --test-force-exit \
//        src/routes/__qa__/scannerAlertsScope.test.ts

import { mock, test } from "node:test";
import assert from "node:assert/strict";
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";

mock.timers.enable({ apis: ["Date"], now: Date.parse("2026-10-28T10:00:00Z") });

const { pushAlert } = await import("../../lib/marketScanner.js");
const { default: express } = await import("express");
const { default: router } = await import("../scanner.js");

async function get(path: string): Promise<Record<string, unknown>> {
  const app = express();
  app.use((req, _res, next) => {
    (req as unknown as { authUser: unknown }).authUser = { id: 7, role: "USER" };
    (req as unknown as { log: unknown }).log = { info() {}, warn() {}, error() {} };
    next();
  });
  app.use(router);
  const server: Server = await new Promise((resolve) => { const s = app.listen(0, "127.0.0.1", () => resolve(s)); });
  try {
    const port = (server.address() as AddressInfo).port;
    const res = await fetch(`http://127.0.0.1:${port}${path}`);
    assert.equal(res.status, 200);
    return (await res.json()) as Record<string, unknown>;
  } finally {
    await new Promise<void>((r) => server.close(() => r()));
  }
}

function push(n: number, tag: string): void {
  for (let i = 0; i < n; i += 1) {
    pushAlert({
      severity: "info", source: "SCANNER", symbol: `SYM${i}`, timeframe: "M15",
      message: `${tag} ${i}`, reason: "qa", recommendedAction: "qa",
    });
  }
}

test("an old alert expires, a superseded one is labeled stale, and the list says it is shared", async () => {
  push(1, "ancient");
  mock.timers.tick(25 * 60 * 60_000);
  push(1, "older");
  mock.timers.tick(20 * 60_000);
  push(1, "fresh");
  const r = await get("/alerts/scanner?unackedOnly=true");
  assert.equal(r["scope"], "platform_shared");
  assert.match(String(r["scopeNote"]), /not personal to you/);
  const list = r["alerts"] as Array<Record<string, unknown>>;
  assert.ok(!list.some((a) => String(a["message"]).startsWith("ancient")), "a 25-hour-old alert is still listed");
  const older = list.find((a) => String(a["message"]).startsWith("older"))!;
  const fresh = list.find((a) => String(a["message"]).startsWith("fresh"))!;
  assert.equal(older["stale"], true, "an M15 alert 20 minutes old is not labeled stale");
  assert.equal(fresh["stale"], false);
  assert.equal(r["count"], 2);
  assert.equal(r["countComplete"], true);
});

test("the open count is the true number, not the 100-row list limit", async () => {
  mock.timers.tick(25 * 60 * 60_000); // expire the earlier test's alerts
  push(150, "bulk");
  const r = await get("/alerts/scanner?unackedOnly=true");
  assert.equal((r["alerts"] as unknown[]).length, 100);
  assert.equal(r["count"], 150);
  assert.equal(r["countComplete"], true);
});

test("once the store has pushed out open alerts, the count says it is a lower bound", async () => {
  push(100, "overflow");
  const r = await get("/alerts/scanner?unackedOnly=true");
  assert.equal(r["count"], 200);
  assert.equal(r["countComplete"], false);
  assert.match(String(r["countNote"]), /At least this many: 50 older open alerts were pushed out/);
});
