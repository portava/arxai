// /admin/live-test-readiness panel C must not report settings it never read.
//
// The checklist on that page turns panelC_operatorAccess into PASS / FAIL
// rows. Before this fix the route sent `requireStopLoss: true` for an admin
// with no user_master_live_access row (a fallback default, not a stored
// setting) and never sent `requireTakeProfit` at all, so the page showed
// "Take profit required" PASS for a value nobody read.
//
// The database is replaced by an empty in-memory stub (every query returns
// no rows); nothing reaches a database, broker or network.
//
// Run: pnpm --filter @workspace/api-server run test:truth-component-evidence

import { after, before, mock, test } from "node:test";
import assert from "node:assert/strict";
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

const { default: express } = await import("express");
const { default: router } = await import("../../../routes/adminLiveTestReadiness.js");
const { buildOperatorAccessPanel } = await import("../liveTestReadinessOperatorAccess.js");

let server: Server;
let base = "";

before(async () => {
  const app = express();
  app.use((req, _res, next) => {
    (req as unknown as { authUser: { id: number; role: string } }).authUser = { id: 4242, role: "OWNER" };
    next();
  });
  app.use("/api", router);
  server = app.listen(0);
  await new Promise<void>((r) => server.once("listening", () => r()));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

after(async () => {
  await new Promise<void>((r) => server.close(() => r()));
});

test("state route: no operator access row → stop-loss / take-profit requirements are unknown (null), not configured", async () => {
  const res = await fetch(`${base}/api/admin/live-test-readiness/state`);
  assert.equal(res.status, 200);
  const body = await res.json() as { panelC_operatorAccess: Record<string, unknown> };
  const c = body.panelC_operatorAccess;
  assert.equal(c["operatorAccessRowFound"], false);
  assert.equal(c["requireStopLoss"], null, "a missing access row must not be reported as stop loss required");
  assert.ok("requireTakeProfit" in c, "take-profit requirement must be reported (as null when unread)");
  assert.equal(c["requireTakeProfit"], null);
});

test("buildOperatorAccessPanel: a stored access row reports its own stop-loss / take-profit settings", () => {
  const row = {
    approvedForMasterLive: true, masterLiveTradingEnabled: true, masterLiveStatus: "APPROVED",
    riskDisclosureAcceptedAt: null, riskSettingsConfiguredAt: null,
    maxLot: 0.01, maxOpenPositions: 1, maxExposurePerSymbolLots: null,
    requireStopLoss: false, requireTakeProfit: true, scannerLiveEnabled: false,
  };
  const p = buildOperatorAccessPanel({
    adminUserId: 1, adminEmail: null, role: "OWNER", access: row, arming: null, allowedSymbols: ["EURUSD"],
  });
  assert.equal(p.operatorAccessRowFound, true);
  assert.equal(p.requireStopLoss, false);
  assert.equal(p.requireTakeProfit, true);
  const none = buildOperatorAccessPanel({
    adminUserId: 1, adminEmail: null, role: "OWNER", access: null, arming: null, allowedSymbols: [],
  });
  assert.equal(none.requireStopLoss, null);
  assert.equal(none.requireTakeProfit, null);
  assert.equal(none.approvedForMasterLive, false);
});
