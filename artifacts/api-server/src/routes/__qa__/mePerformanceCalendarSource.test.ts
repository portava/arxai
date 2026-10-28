// GET /api/me/performance-calendar (My Performance → Performance) reads the
// demo trades a trader logs by hand (paper_trades) or, in LIVE mode, their
// attributed live trades — a different ledger from the Trading Calendar's
// simulated orders (paper_orders). Both pages said "your demo trades", so the
// same date showed different P&L with nothing naming either source. The
// response now names its ledger.
//
// The real router runs; the database, envelope and mode-scope reads are stubbed.
//
// Run: node --import tsx --experimental-test-module-mocks --test --test-force-exit \
//        src/routes/__qa__/mePerformanceCalendarSource.test.ts

import { mock, test } from "node:test";
import assert from "node:assert/strict";
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";

const database = await import("@workspace/db");
const state = { tradingMode: "PAPER" };
function chain(): Record<string, unknown> {
  const q: Record<string, unknown> = {};
  const self = () => q;
  q.from = self; q.where = self; q.groupBy = self; q.orderBy = self; q.limit = self;
  q.then = (resolve: (v: unknown[]) => unknown) => Promise.resolve([]).then(resolve);
  return q;
}
mock.module("@workspace/db", { namedExports: { ...database, db: { select: () => chain() } } });
mock.module("../../lib/adminTrading/safetyEnvelope.js", {
  namedExports: { getEnvelope: async () => ({ tradingMode: state.tradingMode }) },
});
mock.module("../../lib/modeScope/getUserModeScope.js", {
  namedExports: { getUserModeScope: async () => ({ currentAccountMode: state.tradingMode === "LIVE" ? "LIVE_DIRECT" : "PAPER" }) },
});
mock.module("../../lib/auth/middleware.js", {
  namedExports: { requireUser: (_req: unknown, _res: unknown, next: () => void) => next() },
});

const { default: express } = await import("express");
const { default: router } = await import("../mePerformanceCalendar.js");

async function get(path: string): Promise<Record<string, unknown>> {
  const app = express();
  app.use((req, _res, next) => {
    (req as unknown as { authUser: unknown }).authUser = { id: 44, role: "USER" };
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

for (const path of ["/me/performance-calendar", "/me/performance-calendar/2026-05-04", "/me/performance-summary"]) {
  test(`${path} (demo): names the hand-logged demo-trade ledger, not the simulated orders`, async () => {
    state.tradingMode = "PAPER";
    const r = await get(path);
    assert.equal(r.source, "PAPER_TRADES");
    assert.match(String(r.sourceNote), /demo trades you log/i);
    assert.match(String(r.sourceNote), /Trading Calendar/);
  });

  test(`${path} (live): names the live-trade ledger`, async () => {
    state.tradingMode = "LIVE";
    const r = await get(path);
    assert.equal(r.source, "LIVE_TRADE_ATTRIBUTION");
    assert.match(String(r.sourceNote), /closed live trades/i);
  });
}
