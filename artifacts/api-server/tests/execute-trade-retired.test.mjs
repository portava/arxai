// Owner decision 14 (2026-10-25): POST /api/execute-trade stays retired.
//
// Against the running server (full app, global auth gate, real database),
// with the Safety Core set up exactly as the old route needed to approve and
// book (fresh MT5 heartbeat, NORMAL, PAPER_TRADING, kill switch released):
//   - unauthenticated PAPER-, DEMO- and LIVE-shaped bodies are refused by the
//     auth gate (401);
//   - authenticated ones, from the owner and from a plain trader, get 410
//     EXECUTE_TRADE_RETIRED, executed=false, converted=false, no trade id,
//     and the governed paths to use instead;
//   - none of them writes a trade, paper order, broker command (MT5 / live /
//     demo queue), execution event, approval, confirmation, trade action,
//     self-trade execution, Risk Governor decision or vault/audit row: every
//     table in support/governed.mjs EXECUTION_TABLES keeps its row count;
//   - a confirmation id in the body is not claimed.
// Nothing is sent to a broker: no broker command row is written, and the
// isolated runner fails any external connection and prints the count.
//
// The unauthenticated cases need the API without the owner proxy
// (ISOLATED_API_DIRECT_URL, set by scripts/isolated-lane/run.mjs).
//
// Usage: pnpm --filter @workspace/api-server run test:isolated-server-lane

import { test, before, beforeEach, after } from "node:test";
import assert from "node:assert/strict";
import pkg from "pg";
import { BASE, DIRECT, call, countRows, freshTrader } from "./support/governed.mjs";

const { Client } = pkg;

const TICKET = {
  symbol: "Volatility 75 Index", direction: "BUY", lot: 0.5, entry: 100, sl: 95, tp: 110,
  strategy: "Trend Continuation", confidence: 99,
};
const BODIES = {
  PAPER: { ...TICKET },
  DEMO: { ...TICKET, mode: "DEMO", accountType: "demo" },
  LIVE: { ...TICKET, mode: "LIVE", accountType: "live", liveConfirmPhrase: "CONFIRM LIVE", confirmedByUser: true },
};

let pg;
before(async () => {
  pg = new Client({ connectionString: process.env.DATABASE_URL });
  await pg.connect();
  const s = await call(BASE, "GET", "/system/status");
  assert.equal(s.status, 200, "API server must be reachable");
});
after(async () => { try { await pg.end(); } catch {} });

// The state in which the retired route used to approve and book a trade.
beforeEach(async () => {
  await pg.query(`
    UPDATE safety_core SET operational_mode='PAPER_TRADING', global_state='NORMAL',
      kill_switch_engaged=false, kill_switch_engaged_at=NULL, kill_switch_reason=NULL, updated_at=NOW()
  `);
  const ts = new Date(Date.now() - 2000);
  const exists = await pg.query("SELECT id FROM mt5_state LIMIT 1");
  if (exists.rows.length === 0) await pg.query("INSERT INTO mt5_state (last_heartbeat_at) VALUES ($1)", [ts]);
  else await pg.query("UPDATE mt5_state SET last_heartbeat_at = $1", [ts]);
});

function assertRetired(r, label) {
  assert.equal(r.status, 410, `${label}: ${JSON.stringify(r.data)}`);
  assert.equal(r.data.code, "EXECUTE_TRADE_RETIRED");
  assert.equal(r.data.ok, false);
  assert.equal(r.data.success, false);
  assert.equal(r.data.executed, false);
  assert.equal(r.data.converted, false, `${label}: never converted into another mode`);
  assert.equal(r.data.tradeId, undefined, `${label}: no trade id, nothing was booked`);
  assert.equal(r.data.instead.PAPER.path, "/api/paper/orders");
  assert.equal(r.data.instead.DEMO.path, "/api/me/trade-actions");
  assert.equal(r.data.instead.LIVE.path, "/api/me/trade-actions");
  assert.equal(r.data.history.path, "/api/trades");
}

test("RET-1 unauthenticated PAPER, DEMO and LIVE bodies are refused by the auth gate and write nothing",
  { skip: DIRECT ? false : "needs ISOLATED_API_DIRECT_URL (run through scripts/isolated-lane/run.mjs)" }, async () => {
    const before = await countRows(pg);
    for (const [label, body] of Object.entries(BODIES)) {
      const r = await call(DIRECT, "POST", "/execute-trade", body);
      assert.equal(r.status, 401, `${label}: ${JSON.stringify(r.data)}`);
      assert.notEqual(r.data?.code, "EXECUTE_TRADE_RETIRED", "the auth gate answers first");
    }
    assert.deepEqual(await countRows(pg), before);
  });

test("RET-2 the owner gets 410 EXECUTE_TRADE_RETIRED for PAPER, DEMO and LIVE bodies, and nothing is written", async () => {
  const before = await countRows(pg);
  for (const [label, body] of Object.entries(BODIES)) assertRetired(await call(BASE, "POST", "/execute-trade", body), `owner ${label}`);
  assertRetired(await call(BASE, "POST", "/execute-trade", {}), "owner empty body");
  assert.deepEqual(await countRows(pg), before, "no execution, order, command, audit or vault row");
});

test("RET-3 a plain trader gets 410 for PAPER, DEMO and LIVE bodies, and nothing is written for anyone", async () => {
  const t = await freshTrader(pg, "retired-RET-3");
  const before = await countRows(pg);
  for (const [label, body] of Object.entries(BODIES)) assertRetired(await t.call("POST", "/execute-trade", body), `trader ${label}`);
  assert.deepEqual(await countRows(pg), before, "no execution, order, command, audit or vault row");
  const trades = await t.call("GET", "/trades");
  assert.equal(trades.status, 200);
  assert.deepEqual(trades.data, [], "the trader has no trade history");
});

test("RET-4 a confirmation id in the body is not claimed or rejected", async () => {
  const { rows: [conf] } = await pg.query(`
    INSERT INTO execution_confirmations (user_id, symbol, direction, lot_size, entry_price, stop_loss, take_profit,
      estimated_risk, reward_to_risk, market_condition, permission_status, status, user_confirmed, confirmed_at, expires_at)
    VALUES ('retired-lane', $1, 'BUY', 0.5, 100, 95, 110, 10, 2, 'UNKNOWN', 'CLEAR', 'CONFIRMED', true, NOW(), NOW() + interval '10 minutes')
    RETURNING id
  `, [TICKET.symbol]);
  try {
    const before = await countRows(pg);
    assertRetired(await call(BASE, "POST", "/execute-trade", { ...BODIES.LIVE, confirmationId: conf.id }), "owner LIVE with confirmation");
    const { rows: [afterRow] } = await pg.query("SELECT status FROM execution_confirmations WHERE id = $1", [conf.id]);
    assert.equal(afterRow.status, "CONFIRMED", "the retired endpoint never claims a confirmation");
    assert.deepEqual(await countRows(pg), before);
  } finally {
    await pg.query("DELETE FROM execution_confirmations WHERE id = $1", [conf.id]);
  }
});
