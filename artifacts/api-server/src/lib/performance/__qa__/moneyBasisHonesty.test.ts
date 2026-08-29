// Money-basis honesty — the governing rule for every figure a user reads as
// their money.
//
//   A money number must state its basis (LIVE vs DEMO/simulated, assigned vs
//   notional, broker-confirmed vs UNKNOWN) or not render at all.
//
// Each block below pins one defect the production-readiness audit confirmed,
// so it cannot silently reopen:
//
//   1. ENVIRONMENT MIXING — /performance/* and computeExposure summed
//      broker-realised P/L (trades.mode="LIVE") and simulator P/L
//      (mode="DEMO") into one "Realized P/L", with no basis stated, while
//      the Win/Loss Report promised in writing that results are never mixed.
//   2. FLOATING P&L $0.00 — computeExposure summed `trades.pnl` over OPEN
//      rows, but every writer of that column writes only at close, so a
//      permanent confident "$0.00" sat beside genuinely open positions.
//   3. UNTRUSTED CLOSES — pnlStatus="UNKNOWN" rows (broker never reported a
//      usable close fill) were counted as CLOSED wins/losses contributing $0,
//      under-counting realised P/L with no trace.
//   4. "DAILY DRAWDOWN" — min(0, sum of today's closed P/L) is a NET figure;
//      a day that ran +$500 then -$300 showed $0.00 "drawdown".
//   5. TOURNAMENT EXPECTANCY — the loss leg was subtracted twice and pinned
//      to a hardcoded 1R, so the column was systematically negative and could
//      recommend retiring a profitable strategy.
//   6. THE x100 "mock" P/L CALCULATOR — a universal x100 with no contract
//      size wrote invented dollars straight into trades.pnl on the
//      /trade-management/:id/close path.
//
// Pure unit + source-structure proofs. No DB, no network. The dummy
// DATABASE_URL satisfies @workspace/db module init (reached transitively via
// shadowMode.ts); the pg Pool is lazy and no query is ever issued.
//
// Run: node --import tsx --test --test-force-exit \
//   src/lib/performance/__qa__/moneyBasisHonesty.test.ts

process.env.DATABASE_URL ??= "postgres://qa:qa@127.0.0.1:1/qa_offline_never_connects";

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import {
  resolveTradeScope,
  inScope,
  countClosedOutOfScope,
  normaliseTradeMode,
} from "../tradeScope.js";
import { computeExposure } from "../../portfolio/exposure.js";
// shadowMode.ts is imported DYNAMICALLY inside its test: static ESM imports
// are hoisted above the DATABASE_URL assignment above, and shadowMode pulls
// in @workspace/db transitively, whose module init throws without it.

// ── fixtures ───────────────────────────────────────────────────────────────
type TradeRow = Parameters<typeof computeExposure>[0][number];

let nextId = 1;
function trade(over: Partial<TradeRow> = {}): TradeRow {
  return {
    id: nextId++,
    userId: 1,
    symbol: "EURUSD",
    direction: "BUY",
    lot: 1,
    entryPrice: 1.1,
    stopLoss: 1.09,
    takeProfit: 1.12,
    strategy: "Trend Continuation",
    confidence: 70,
    status: "CLOSED_WIN",
    mode: "DEMO",
    pnl: 0,
    pnlStatus: null,
    dataQualityFlag: null,
    reportedEaVersion: null,
    originClass: null,
    originClassSource: null,
    closedAt: new Date(),
    createdAt: new Date(),
    ...over,
  } as TradeRow;
}

// ── 1 · environment scoping ────────────────────────────────────────────────
test("normaliseTradeMode: anything that is not LIVE is DEMO", () => {
  assert.equal(normaliseTradeMode("LIVE"), "LIVE");
  assert.equal(normaliseTradeMode(" live "), "LIVE");
  assert.equal(normaliseTradeMode("DEMO"), "DEMO");
  assert.equal(normaliseTradeMode(null), "DEMO");
  assert.equal(normaliseTradeMode(undefined), "DEMO");
  assert.equal(normaliseTradeMode("something-else"), "DEMO");
});

test("resolveTradeScope: any non-cancelled LIVE row makes the scope LIVE", () => {
  assert.deepEqual(resolveTradeScope([]), { mode: "DEMO", reason: "NO_TRADES" });
  assert.deepEqual(
    resolveTradeScope([trade({ mode: "DEMO" })]),
    { mode: "DEMO", reason: "ONLY_DEMO_TRADES" },
  );
  // An OPEN live position still means the account is live.
  assert.deepEqual(
    resolveTradeScope([trade({ mode: "DEMO" }), trade({ mode: "LIVE", status: "OPEN" })]),
    { mode: "LIVE", reason: "LIVE_TRADES_PRESENT" },
  );
  // A cancelled live row never produced money anywhere.
  assert.deepEqual(
    resolveTradeScope([trade({ mode: "DEMO" }), trade({ mode: "LIVE", status: "CANCELLED" })]),
    { mode: "DEMO", reason: "ONLY_DEMO_TRADES" },
  );
});

test("inScope / countClosedOutOfScope: the dropped rows are counted, never silent", () => {
  const rows = [
    trade({ mode: "LIVE", pnl: 100 }),
    trade({ mode: "DEMO", pnl: 500 }),
    trade({ mode: "DEMO", pnl: 500 }),
    trade({ mode: "DEMO", status: "OPEN" }),      // open — not a closed exclusion
    trade({ mode: "DEMO", status: "CANCELLED" }), // cancelled — never counted
  ];
  assert.equal(inScope(rows, "LIVE").length, 1);
  assert.equal(countClosedOutOfScope(rows, "LIVE"), 2);
});

// ── 2 · computeExposure never sums real money into simulated money ─────────
test("computeExposure: real broker P/L is NEVER added to simulator P/L", () => {
  const exposure = computeExposure([
    trade({ mode: "LIVE", status: "CLOSED_WIN", pnl: 100 }),
    trade({ mode: "DEMO", status: "CLOSED_WIN", pnl: 9999 }),
    trade({ mode: "DEMO", status: "CLOSED_WIN", pnl: 9999 }),
  ]);
  assert.equal(exposure.scopeMode, "LIVE", "scope must be declared");
  assert.equal(exposure.realizedPnl, 100, "must be the LIVE figure alone");
  assert.notEqual(exposure.realizedPnl, 20098, "must not be the mixed sum");
  assert.equal(exposure.totalClosed, 1);
});

test("computeExposure: a demo-only account reports DEMO as its basis", () => {
  const exposure = computeExposure([
    trade({ mode: "DEMO", status: "CLOSED_WIN", pnl: 25 }),
    trade({ mode: "DEMO", status: "CLOSED_LOSS", pnl: -10 }),
  ]);
  assert.equal(exposure.scopeMode, "DEMO");
  assert.equal(Math.round(exposure.realizedPnl), 15);
});

// ── 3 · floating P&L is a typed null, never a confident zero ───────────────
test("computeExposure: floatingPnl is null with a reason while positions are open", () => {
  const exposure = computeExposure([
    // Even if an OPEN row somehow carries a stale pnl, it must not be
    // presented as a mark-to-market floating figure.
    trade({ mode: "DEMO", status: "OPEN", pnl: 42, closedAt: null }),
    trade({ mode: "DEMO", status: "OPEN", pnl: null, closedAt: null }),
  ]);
  assert.equal(exposure.totalOpen, 2);
  assert.equal(exposure.floatingPnl, null, "must not render a number");
  assert.equal(exposure.floatingPnlStatus, "NOT_MARKED_TO_MARKET");
  assert.notEqual(exposure.floatingPnl as unknown, 0, "a confident $0.00 is the defect");
});

// ── 4 · untrusted closes are excluded AND surfaced ─────────────────────────
test("computeExposure: pnlStatus=UNKNOWN rows leave realizedPnl and are counted", () => {
  const exposure = computeExposure([
    trade({ mode: "DEMO", status: "CLOSED_WIN", pnl: 50 }),
    // Non-null pnl on purpose: filtering on `pnl == null` instead of
    // pnlStatus would let this 9999 through and the assertion would fail.
    trade({ mode: "DEMO", status: "CLOSED_WIN", pnl: 9999, pnlStatus: "UNKNOWN" }),
    trade({ mode: "DEMO", status: "CLOSED_LOSS", pnl: 9999, pnlStatus: "UNKNOWN" }),
  ]);
  assert.equal(exposure.realizedPnl, 50);
  assert.equal(exposure.realizedPnlExcludedUnknownCount, 2);
  assert.equal(exposure.totalClosed, 1, "an unpriced close is not a counted win/loss");
});

// ── 5 · "daily drawdown" was a net figure, and is named as one ─────────────
test("computeExposure: netPnlToday is the true net, not clamped to <= 0", () => {
  const exposure = computeExposure([
    trade({ mode: "DEMO", status: "CLOSED_WIN", pnl: 500, closedAt: new Date() }),
    trade({ mode: "DEMO", status: "CLOSED_LOSS", pnl: -300, closedAt: new Date() }),
  ]);
  // The old `dailyDrawdown = Math.min(0, ...)` reported 0 here and called it
  // a drawdown, hiding a real $300 intraday give-back behind a reassuring $0.
  assert.equal(exposure.netPnlToday, 200);
  assert.equal(exposure.netPnlWeek, 200);
  assert.equal(
    Object.prototype.hasOwnProperty.call(exposure, "dailyDrawdown"),
    false,
    "the misleading `dailyDrawdown` name must not come back",
  );
});

// ── 6 · tournament expectancy ──────────────────────────────────────────────
test("expectancyFromLegs: the loss leg is subtracted exactly once", async () => {
  const { expectancyFromLegs } = await import("../../shadowMode.js");
  // 50% win rate, wins average +2R, losses average -1R → +0.5R per trade.
  assert.equal(expectancyFromLegs(0.5, 2, -1), 0.5);
  // The old formula, for the same strategy: avgR = (2 + -1)/2 = 0.5, so
  // 0.5 * max(0, 0.5) - 0.5 * 1 = -0.25 — a profitable strategy reported as
  // negative, which is what `toRetire` selects on.
  const legacy = 0.5 * Math.max(0, 0.5) - (1 - 0.5) * 1;
  assert.equal(legacy, -0.25);
  assert.ok(expectancyFromLegs(0.5, 2, -1) > 0, "must be positive for a +EV strategy");

  // All wins, no losses.
  assert.equal(expectancyFromLegs(1, 1.5, 0), 1.5);
  // All losses.
  assert.equal(expectancyFromLegs(0, 0, -2), -2);
  // A genuinely -EV strategy still reads negative.
  assert.ok(expectancyFromLegs(0.3, 1, -1) < 0);
});

// ── 7 · the x100 "mock" calculator writes no dollars ───────────────────────
function readSource(rel: string): string {
  return readFileSync(fileURLToPath(new URL(rel, import.meta.url)), "utf8");
}

test("tradeManager no longer invents a dollar P/L with a universal x100", () => {
  const src = readSource("../../tradeManagement/tradeManager.ts");
  assert.ok(
    !/\*\s*trade\.lot\s*\*\s*100/.test(src),
    "the (price - entry) * direction * lot * 100 calculator must stay deleted",
  );
  assert.ok(/floatingPnl:\s*null/.test(src), "floatingPnl must be null on this path");
  assert.ok(/floatingPnlStatus:\s*"NOT_PRICEABLE"/.test(src));
});

test("POST /trade-management/:id/close writes no pnl and marks the row UNKNOWN", () => {
  const src = readSource("../../../routes/tradeManagement.ts");
  const closeHandler = src.slice(src.indexOf(`"/trade-management/:id/close"`));
  assert.ok(closeHandler.length > 0, "close handler must exist");
  assert.ok(/pnl:\s*null/.test(closeHandler), "must not write a numeric pnl");
  assert.ok(/pnlStatus:\s*"UNKNOWN"/.test(closeHandler), "must mark the close untrusted");
  assert.ok(
    !/pnl:\s*Number\(/.test(closeHandler),
    "must not write a computed dollar figure into trades.pnl",
  );
});

// ── 8 · broker reconciliation reports nulls, not fabricated zeros ──────────
test("brokerReconStatus reports null counts and NOT_IMPLEMENTED, never zeros", () => {
  const src = readSource("../../oms.ts");
  const fn = src.slice(src.indexOf("export function brokerReconStatus"));
  const body = fn.slice(0, fn.indexOf("\n}"));
  assert.ok(/brokerOrders:\s*null/.test(body), "an unread count is null, not 0");
  assert.ok(/brokerPositions:\s*null/.test(body));
  assert.ok(/mismatches:\s*null/.test(body), "no comparison means no mismatch count");
  assert.ok(/comparisonPerformed:\s*false/.test(body));
  assert.ok(
    !/mismatches:\s*\[\]/.test(body),
    "an empty mismatch array rendered as 'Mismatches: 0' — a fabricated recon result",
  );
});
