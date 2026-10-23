// QA gate — stop-limit relationship verifier (Phase TU P0 fix).
//
// Runs the canonical MT5 stop-limit truth table against the REAL backend
// validator (`validateOrderTicket`) used by the trade-ticket UI, the
// pending-order draft route, and the AI assistant. Prints PASS/FAIL per
// case and exits non-zero on any failure.
//
// Canonical MT5 rules verified here:
//   BUY_STOP_LIMIT : trigger >  currentAsk  AND  stopLimit  <  trigger
//   SELL_STOP_LIMIT: trigger <  currentBid  AND  stopLimit  >  trigger
//
// Run: pnpm --filter @workspace/api-server run qa:stop-limit

import { validateOrderTicket } from "../orderTicketValidation.js";
import type { OrderType } from "../orderTypes.js";

type Case = {
  name: string;
  orderType: OrderType;
  currentPrice: number | null;
  stopTriggerPrice: number | null;
  stopLimitPrice: number | null;
  stopLoss: number | null;
  takeProfit: number | null;
  expectOk: boolean;
  expectErrorIncludes?: string;
};

const base = {
  lotSize: 0.10,
  entryPrice: null,
  minStopDistance: null,
  minPendingDistance: null,
  minLotSize: null,
  maxLotSize: null,
  requireStopLoss: false,
  symbolPipSize: 0.0001,
};

// Hypothetical EURUSD-like setup. Current Ask = 1.1000, Current Bid = 1.0999.
const cases: Case[] = [
  // ── BUY_STOP_LIMIT ────────────────────────────────────────────────────
  {
    name: "BUY_STOP_LIMIT valid (trigger>Ask, limit<trigger, SL<limit, TP>limit)",
    orderType: "BUY_STOP_LIMIT",
    currentPrice: 1.1000,
    stopTriggerPrice: 1.1050,
    stopLimitPrice:   1.1020,
    stopLoss:         1.0990,
    takeProfit:       1.1100,
    expectOk: true,
  },
  {
    name: "BUY_STOP_LIMIT INVALID — limit ABOVE trigger",
    orderType: "BUY_STOP_LIMIT",
    currentPrice: 1.1000,
    stopTriggerPrice: 1.1050,
    stopLimitPrice:   1.1080,
    stopLoss:         1.0990,
    takeProfit:       1.1200,
    expectOk: false,
    expectErrorIncludes: "STRICTLY BELOW",
  },
  {
    name: "BUY_STOP_LIMIT INVALID — limit EQUAL trigger (broker would reject)",
    orderType: "BUY_STOP_LIMIT",
    currentPrice: 1.1000,
    stopTriggerPrice: 1.1050,
    stopLimitPrice:   1.1050,
    stopLoss:         1.0990,
    takeProfit:       1.1200,
    expectOk: false,
    expectErrorIncludes: "STRICTLY BELOW",
  },
  {
    name: "BUY_STOP_LIMIT INVALID — trigger BELOW current Ask",
    orderType: "BUY_STOP_LIMIT",
    currentPrice: 1.1100,
    stopTriggerPrice: 1.1050,
    stopLimitPrice:   1.1020,
    stopLoss:         1.0990,
    takeProfit:       1.1200,
    expectOk: false,
    expectErrorIncludes: "ABOVE the current ask",
  },

  // ── SELL_STOP_LIMIT ───────────────────────────────────────────────────
  {
    name: "SELL_STOP_LIMIT valid (trigger<Bid, limit>trigger, SL>limit, TP<limit)",
    orderType: "SELL_STOP_LIMIT",
    currentPrice: 1.1000,
    stopTriggerPrice: 1.0950,
    stopLimitPrice:   1.0980,
    stopLoss:         1.1010,
    takeProfit:       1.0900,
    expectOk: true,
  },
  {
    name: "SELL_STOP_LIMIT INVALID — limit BELOW trigger",
    orderType: "SELL_STOP_LIMIT",
    currentPrice: 1.1000,
    stopTriggerPrice: 1.0950,
    stopLimitPrice:   1.0920,
    stopLoss:         1.1010,
    takeProfit:       1.0800,
    expectOk: false,
    expectErrorIncludes: "STRICTLY ABOVE",
  },
  {
    name: "SELL_STOP_LIMIT INVALID — limit EQUAL trigger",
    orderType: "SELL_STOP_LIMIT",
    currentPrice: 1.1000,
    stopTriggerPrice: 1.0950,
    stopLimitPrice:   1.0950,
    stopLoss:         1.1010,
    takeProfit:       1.0800,
    expectOk: false,
    expectErrorIncludes: "STRICTLY ABOVE",
  },
  {
    name: "SELL_STOP_LIMIT INVALID — trigger ABOVE current Bid",
    orderType: "SELL_STOP_LIMIT",
    currentPrice: 1.0900,
    stopTriggerPrice: 1.0950,
    stopLimitPrice:   1.0980,
    stopLoss:         1.1010,
    takeProfit:       1.0800,
    expectOk: false,
    expectErrorIncludes: "BELOW the current bid",
  },
];

let pass = 0;
let fail = 0;
const failures: string[] = [];

for (const c of cases) {
  const out = validateOrderTicket({
    ...base,
    orderType: c.orderType,
    currentPrice: c.currentPrice,
    stopTriggerPrice: c.stopTriggerPrice,
    stopLimitPrice: c.stopLimitPrice,
    stopLoss: c.stopLoss,
    takeProfit: c.takeProfit,
  });
  const okMatches = out.ok === c.expectOk;
  const errorMatches =
    c.expectErrorIncludes == null ||
    out.errors.some((e) => e.includes(c.expectErrorIncludes!));
  if (okMatches && errorMatches) {
    pass++;
    process.stdout.write(`PASS  ${c.name}\n`);
  } else {
    fail++;
    failures.push(c.name);
    process.stdout.write(
      `FAIL  ${c.name}\n  got ok=${out.ok} errors=${JSON.stringify(out.errors)}\n`,
    );
  }
}

process.stdout.write(`\n${pass}/${pass + fail} passed.\n`);
if (fail > 0) {
  process.stdout.write(`Failures: ${failures.join("; ")}\n`);
  process.exit(1);
}
