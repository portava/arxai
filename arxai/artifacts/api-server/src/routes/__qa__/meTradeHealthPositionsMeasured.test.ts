// /me/trade-health dropped the service's positionsMeasured / positionsNote, so
// the dashboard could not tell "your demo positions could not be checked"
// from "you have no open positions" and showed its own "No open positions to
// monitor right now" for both. The route now forwards both fields.
//
// Runs the REAL router with the trade-health service and auth replaced by
// fixtures: no database, no broker, no network. Mounted on loopback.
//
// Run: node --import tsx --experimental-test-module-mocks --test --test-force-exit \
//        src/routes/__qa__/meTradeHealthPositionsMeasured.test.ts

import { test, mock, before, after } from "node:test";
import assert from "node:assert/strict";
import express from "express";
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";

const NOTE = "Your MT5 account state could not be attributed to you.";
const state: { measured: boolean; userId: number } = { measured: false, userId: 41 };

mock.module("../../lib/auth/middleware.js", {
  namedExports: {
    requireUser: (req: { authUser?: unknown }, _res: unknown, next: () => void) => {
      req.authUser = { id: state.userId, role: "TRADER" }; next();
    },
  },
});
mock.module("../../lib/tradeHealth/tradeHealthService.js", {
  namedExports: {
    buildTradeHealthForUser: async () => ({
      report: {
        evaluatedAt: "2026-10-28T11:00:00.000Z",
        assessments: [],
        conflicts: [],
        correlations: [],
        overtrading: [],
        overlays: [],
        summary: state.measured
          ? "You have no open positions."
          : `Your demo positions could not be checked. ${NOTE}`,
      },
      chartSymbol: null,
      positionsMeasured: state.measured,
      positionsNote: state.measured ? null : NOTE,
    }),
  },
});

const { default: router } = await import("../meTradeHealth.js");

let server: Server;
let base: string;
before(async () => {
  const app = express();
  app.use((req, _res, next) => {
    (req as unknown as { log: unknown }).log = { info: () => undefined, error: () => undefined };
    next();
  });
  app.use(router);
  server = await new Promise<Server>((resolve) => {
    const s = app.listen(0, "127.0.0.1", () => resolve(s));
  });
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
after(() => new Promise<void>((resolve) => server.close(() => resolve())));

async function get(): Promise<Record<string, unknown>> {
  const r = await fetch(`${base}/me/trade-health`);
  assert.equal(r.status, 200);
  return (await r.json()) as Record<string, unknown>;
}

test("positions not read: the response says so (positionsMeasured false + the reason)", async () => {
  state.measured = false; state.userId = 41;
  const body = await get();
  assert.equal(body["positionsMeasured"], false, "an unread book is not reported as measured");
  assert.equal(body["positionsNote"], NOTE);
  assert.deepEqual(body["assessments"], []);
  assert.match(String(body["summary"]), /could not be checked/);
});

test("positions read: positionsMeasured true and no note", async () => {
  state.measured = true; state.userId = 42; // a different user: a fresh cache key
  const body = await get();
  assert.equal(body["positionsMeasured"], true);
  assert.equal(body["positionsNote"], null);
});
