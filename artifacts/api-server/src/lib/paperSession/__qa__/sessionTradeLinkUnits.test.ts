// Session trade-link units + result labels.
//
// linkTradeToActiveSession used to have NO caller (only the manual
// /paper-sessions/link-trade endpoint, which nothing invoked), so the session
// row's netPnl / trade counters never moved and the session loss limit could
// never trip from real trading. The real open/close paths now call it
// (paperExecutionService open; paperExecutionMonitor + routes/paperTrading
// closes). Two pure contracts every caller shares are locked here:
//
//   * closeResultForPnl — the single WIN/LOSS/BREAK_EVEN mapping
//   * usdToCents at the link boundary — paper_orders.profit_loss is DOLLARS,
//     paper_session_trade_links.pnl / paper_sessions.net_pnl are CENTS
//
// Run: node --import tsx --test src/lib/paperSession/__qa__/sessionTradeLinkUnits.test.ts

process.env["DATABASE_URL"] ??= "postgres://user:pass@127.0.0.1:1/nonexistent";

import { test } from "node:test";
import assert from "node:assert/strict";

const { closeResultForPnl, usdToCents, DEFAULT_RULES, sessionLossLimitBreached } = await import("../manager.js");

test("closeResultForPnl maps sign → label", () => {
  assert.equal(closeResultForPnl(12.5), "WIN");
  assert.equal(closeResultForPnl(-0.01), "LOSS");
  assert.equal(closeResultForPnl(0), "BREAK_EVEN");
});

test("a dollar P&L converts to integer cents at the link boundary", () => {
  assert.equal(usdToCents(-12.34), -1234);
  assert.equal(usdToCents(0), 0);
  assert.equal(usdToCents(7.005), 701); // rounds to whole cents
});

test("closes accumulated in cents actually reach the session loss limit", () => {
  // Three -$50 closes linked with usdToCents each → -15000 cents, which must
  // trip the default $150 session limit. Before the wiring the accumulated
  // netPnl was always the row default 0, so this could never happen.
  const accumulated = usdToCents(-50) * 3;
  assert.equal(accumulated, -15_000);
  assert.equal(sessionLossLimitBreached(accumulated, DEFAULT_RULES.maxSessionLoss), true);
  assert.equal(sessionLossLimitBreached(0, DEFAULT_RULES.maxSessionLoss), false);
});
