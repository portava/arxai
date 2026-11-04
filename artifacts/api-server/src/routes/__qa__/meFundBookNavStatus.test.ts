// Truth: GET /me/investor/fundbook defaulted a pool with no NAV row to
// navStatus "OK" and navPerUnit 1, so a NAV that was never computed read as a
// healthy one. A missing NAV row must be disclosed as NOT_COMPUTED; a real NAV
// row keeps its own status.
import { test, mock } from "node:test";
import assert from "node:assert/strict";
import { createFakeDb, withRouter, type FakeRows } from "./_fakeRouteDb.js";

const realDb = await import("@workspace/db");
let fake = createFakeDb({});
const dbProxy = new Proxy({}, { get: (_t, p) => (fake.db as Record<string | symbol, unknown>)[p] });
mock.module("@workspace/db", { namedExports: { ...realDb, db: dbProxy } });
const realNav = await import("../../lib/fundbook/navEngine.js");
mock.module("../../lib/fundbook/navEngine.js", {
  namedExports: {
    ...realNav,
    ensurePools: async () => [{ id: 11, poolKey: "BALANCED", name: "Balanced", riskLevel: "Moderate", status: "ACTIVE" }],
  },
});
const realMirror = await import("../../lib/fundbook/brokerMirror.js");
mock.module("../../lib/fundbook/brokerMirror.js", {
  namedExports: {
    ...realMirror,
    getPoolFloatingPl: async () => ({ aggregate: { byPoolId: new Map(), unassigned: [] }, positions: [] }),
    getOverlayFreshness: async () => ({ freshness: "MISSING", asOf: null }),
  },
});
const router = (await import("../meFundBook.js")).meFundBookRouter;

async function pools(rows: FakeRows): Promise<Array<Record<string, unknown>>> {
  fake = createFakeDb(rows);
  let body: Record<string, unknown> = {};
  await withRouter(router, { id: 7 }, async (base) => {
    const r = await fetch(`${base}/me/investor/fundbook`);
    assert.equal(r.status, 200);
    body = await r.json() as Record<string, unknown>;
  });
  return body["pools"] as Array<Record<string, unknown>>;
}

const holding = { strategyPoolId: 11, userId: 7, unitsOwned: 10, averageNav: 1, costBasis: 10, realizedPl: 0, status: "ACTIVE" };

test("a pool with no NAV row is NOT_COMPUTED, never 'OK'", async () => {
  const p = await pools({ investor_pool_holdings: [holding] });
  assert.equal(p[0]!["navStatus"], "NOT_COMPUTED");
});

test("a pool with a NAV row keeps that row's status", async () => {
  const nav = { strategyPoolId: 11, navPerUnit: 1.2, totalUnitsOutstanding: 100, navStatus: "OK" };
  const p = await pools({ strategy_pool_nav: [nav], investor_pool_holdings: [holding] });
  assert.equal(p[0]!["navStatus"], "OK");
  assert.equal(p[0]!["navPerUnit"], 1.2);
});
