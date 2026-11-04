// AICS-2 (2026-11-04): the closed-trade ledger shared by the Performance
// Calendar route and Ruby's performance tools picks the same book the
// calendar does — LIVE_SHARED withheld, LIVE envelope → live trades,
// otherwise paper trades — and labels it.
import { test, mock } from "node:test";
import assert from "node:assert/strict";
import { createFakeDb } from "../../../routes/__qa__/_fakeRouteDb.js";

const closedAt = new Date("2026-10-27T10:00:00.000Z");
const realDb = await import("@workspace/db");
const fake = createFakeDb({
  paper_trades: [{ id: 1, userId: 7, symbol: "EURUSD", side: "buy", status: "closed", pnl: 5, lotSize: 1, entryPrice: 1.085, exitPrice: 1.09, strategyTag: "breakout", riskAmount: 2, closedAt }],
  shared_trade_attribution: [{ id: 2, userId: 7, symbol: "XAUUSD", side: "SELL", status: "closed", pnl: -3, lotSize: 0.1, entryPrice: 2400, closePrice: 2403, closedAt }],
});
mock.module("@workspace/db", { namedExports: { ...realDb, db: fake.db } });

let tradingMode = "LIVE";
let accountMode = "PAPER";
const realEnv = await import("../../adminTrading/safetyEnvelope.js");
mock.module("../../adminTrading/safetyEnvelope.js", { namedExports: {
  ...realEnv, getEnvelope: async () => ({ tradingMode }),
} });
const realScope = await import("../../modeScope/getUserModeScope.js");
mock.module("../../modeScope/getUserModeScope.js", { namedExports: {
  ...realScope, getUserModeScope: async () => ({ currentAccountMode: accountMode }),
} });

const { resolveClosedTradeLedger, resolveLedgerBasis, loadClosedRows, SOURCE_NOTE } = await import("../closedTradeLedger.js");

test("LIVE envelope: the ledger reads closed live trades and labels them", async () => {
  tradingMode = "LIVE"; accountMode = "PAPER";
  const l = await resolveClosedTradeLedger(7);
  assert.equal(l.source, "live_trades");
  assert.equal(l.sourceNote, SOURCE_NOTE.live_trades);
  assert.equal(l.rows.length, 1);
  assert.equal(l.rows[0]!.symbol, "XAUUSD");
  assert.equal(l.rows[0]!.exitPrice, 2403);
  assert.equal(l.rows[0]!.strategyTag, null);
});

test("non-live envelope: the ledger reads paper trades", async () => {
  tradingMode = "DEMO"; accountMode = "DEMO";
  const l = await resolveClosedTradeLedger(7);
  assert.equal(l.source, "paper_trades");
  assert.equal(l.rows[0]!.strategyTag, "breakout");
  const raw = await loadClosedRows(7);
  assert.equal(raw.source, "paper_trades");
});

test("LIVE_SHARED scope: withheld, no rows, even with a LIVE envelope", async () => {
  tradingMode = "LIVE"; accountMode = "LIVE_SHARED";
  const b = await resolveLedgerBasis(7);
  assert.equal(b.source, "withheld_live_shared");
  const l = await resolveClosedTradeLedger(7);
  assert.equal(l.source, "withheld_live_shared");
  assert.deepEqual(l.rows, []);
  assert.equal(l.currentAccountMode, "LIVE_SHARED");
});
