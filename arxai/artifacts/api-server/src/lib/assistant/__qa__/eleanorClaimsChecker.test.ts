// Eleanor claims checker: unit tests (pure, offline).
import { test } from "node:test";
import assert from "node:assert/strict";
import { checkClaims, splitSegments } from "../grounding/claimsChecker.js";
import { buildEvidenceIndex } from "../grounding/evidence.js";

const snap = (over: Record<string, unknown> = {}) => ({
  name: "getMarketSnapshot",
  result: { symbol: "EURUSD", isLive: true, stale: false, freshness: "REALTIME", lastPrice: 1.08523, lastCandleTime: "2026-11-09T14:31:00.000Z", quote: { bid: 1.08519, ask: 1.08527, spread: 0.00008, stale: false, freshness: "fresh", observedAt: "2026-11-09T14:32:05.000Z", ageMs: 1200 }, ...over },
});
const kinds = (text: string, outputs: Array<{ name: string; result: unknown }>, user = "") => checkClaims(text, outputs, user).findings.map((f) => f.kind);

test("segments never split a decimal and keep exact offsets", () => {
  const t = "Price is 1.0852. Next line!\nThird? Yes";
  const segs = splitSegments(t);
  assert.deepEqual(segs.map((s) => s.text), ["Price is 1.0852.", " Next line!", "\n", "Third?", " Yes"]);
  assert.equal(segs.map((s) => s.text).join(""), t);
  for (const s of segs) assert.equal(t.slice(s.start, s.end), s.text);
});

test("prices match at the precision written (rounding), never beyond it", () => {
  assert.deepEqual(kinds("EURUSD is 1.08523.", [snap()]), []);
  assert.deepEqual(kinds("EURUSD is 1.0852.", [snap()]), []);
  assert.deepEqual(kinds("EURUSD is 1.085.", [snap()]), []);
  assert.deepEqual(kinds("EURUSD is 1.0860.", [snap()]), ["FABRICATION"], "no field rounds to 1.0860");
  assert.deepEqual(kinds("EURUSD is 1.08530.", [snap()]), ["FABRICATION"], "1.08527 is not 1.08530 at five decimals");
});

test("non-claims are ignored: symbols, timeframes, list markers, ordinals, x/100 denominators", () => {
  const out = [{ name: "readChartStructure", result: { symbol: "R_75", timeframe: "M15", confidenceScore: 64 } }];
  assert.deepEqual(kinds("1. R_75 on M15 and H4.\n2. Volatility 75 Index and 1HZ100V scored 64/100 in step 3.", out), []);
});

test("thousands separators, currency, sign, k-suffix and percent forms ground", () => {
  const out = [{ name: "getAccountSnapshot", result: { balance: 10250.37, todaysRealizedPnl: -45.2, winRate: 55, drawdownPct: 0.042 } }];
  assert.deepEqual(kinds("Balance $10,250.37, about $10.3k; P&L -45.20; win rate 55%; drawdown 4.2%.", out), []);
});

test("durations ground against *Ms / *Seconds fields", () => {
  const hb = [{ name: "getMT5Heartbeat", result: { ageSeconds: 3120, quoteAgeMs: 45_000 } }];
  assert.deepEqual(kinds("Last heartbeat 52 minutes ago; the quote is 45 seconds old.", hb), []);
  assert.deepEqual(kinds("Last heartbeat 5 minutes ago.", hb), ["FABRICATION"]);
});

test("times and dates must be in the evidence (UTC)", () => {
  assert.deepEqual(kinds("Observed at 14:32 UTC on 2026-11-09 (Nov 9).", [snap()]), []);
  assert.deepEqual(kinds("Observed at 15:32 UTC.", [snap()]), ["FABRICATION"]);
  assert.deepEqual(kinds("Observed on 2026-11-08.", [snap()]), ["FABRICATION"]);
});

test("tickets and ids must appear in the evidence", () => {
  const ex = [{ name: "getActionExecutionResult", result: { actionId: 5123, mt5PositionTicket: 70011224, status: "executed", fillPrice: 1.08531, executedAt: "2026-11-09T14:33:02.000Z" } }];
  assert.deepEqual(kinds("Ticket #70011224 for action 5123.", ex), []);
  assert.deepEqual(kinds("Your position ticket is 70011299.", ex), ["FABRICATION"]);
});

test("a labelled figure that disagrees with its field is WRONG_NUMBER, not merely unverified", () => {
  const pos = [{ name: "getOpenPositions", result: { count: 2, positions: [{ id: 1, symbol: "EURUSD", stopLoss: 1.0895, takeProfit: 1.079 }, { id: 2, symbol: "GBPUSD", stopLoss: 1.2712, takeProfit: 1.2802 }] } }];
  assert.deepEqual(kinds("Stop loss 1.0895, TP 1.0790.", pos), []);
  assert.deepEqual(kinds("Your stop loss is 1.0790.", pos), ["WRONG_NUMBER"], "TP value presented as the stop");
  assert.deepEqual(kinds("You have 3 open positions.", pos), ["WRONG_NUMBER"]);
  assert.deepEqual(kinds("You have 2 open positions.", pos), []);
  // Derived distances are not checked against the raw level label.
  assert.deepEqual(kinds("The stop is 35 pips away.", pos), ["FABRICATION"]);
});

test("user-provided numbers may be echoed", () => {
  assert.deepEqual(kinds("You asked to risk 1.5% with a stop at 1.0800.", [], "risk 1.5% stop 1.0800"), []);
});

test("stale data presented as live is flagged; disclosed staleness is not", () => {
  const stale = [snap({ stale: true, isLive: false, freshness: "STALE", quote: null })];
  assert.deepEqual(kinds("EURUSD is trading live at 1.0852 right now.", stale), ["STALE_AS_LIVE"]);
  assert.deepEqual(kinds("EURUSD's last recorded price is 1.0852, but the feed is stale.", stale), []);
  assert.deepEqual(kinds("EURUSD is trading live at 1.0852 right now.", [snap()]), [], "fresh data may be called live");
  // The nearest freshness verdict wins: a stale nested quote under a realtime snapshot.
  const nested = [snap({ quote: { bid: 1.08519, stale: true, freshness: "stale", observedAt: "2026-11-09T13:58:00.000Z" } })];
  assert.deepEqual(kinds("The live bid is 1.08519.", nested), ["STALE_AS_LIVE"]);
  assert.deepEqual(kinds("The live price is 1.08523.", nested), []);
});

test("scores and unsupported figures presented as probabilities are flagged", () => {
  const scan = [{ name: "getMarketScannerOpportunities", result: { opportunities: [{ symbol: "GBPUSD", confidenceScore: 72, riskRewardRatio: 2.1 }] } }];
  assert.deepEqual(kinds("GBPUSD has a 72% chance of hitting TP.", scan), ["UNCALIBRATED_PROBABILITY"]);
  assert.deepEqual(kinds("GBPUSD is 72% likely to work.", scan), ["UNCALIBRATED_PROBABILITY"]);
  assert.deepEqual(kinds("GBPUSD rates 72% on the scanner.", scan), ["UNCALIBRATED_PROBABILITY"], "score shown as a percent");
  assert.deepEqual(kinds("GBPUSD has a confidence score of 72/100.", scan), []);
  assert.deepEqual(kinds("A 0.72 probability of success.", scan), ["UNCALIBRATED_PROBABILITY"]);
  assert.deepEqual(kinds("The score is 72; it is not a calibrated probability.", scan), []);
  // Only a value the tool marks calibrated may be stated as a probability.
  const cal = [{ name: "x", result: { hitProbability: 0.61, calibrated: true } }];
  assert.deepEqual(kinds("The calibrated hit probability is 61%.", cal), []);
});

test("execution claims need an executed result; negated and conditional statements are not claims", () => {
  const none = [{ name: "getTradeActionStatus", result: { actionId: 5130, status: "awaiting_confirmation" } }];
  const done = [{ name: "getTradeActionStatus", result: { actionId: 5123, status: "executed", mt5PositionTicket: 70011224 } }];
  assert.deepEqual(kinds("Your order was filled.", none), ["EXECUTION_UNCONFIRMED"]);
  assert.deepEqual(kinds("I've opened the trade for you.", []), ["EXECUTION_UNCONFIRMED"]);
  assert.deepEqual(kinds("Your order was filled.", done), []);
  assert.deepEqual(kinds("Your order has not been filled yet.", none), []);
  assert.deepEqual(kinds("Once you confirm, the order will be placed.", none), []);
  assert.deepEqual(kinds("If it fills, I'll tell you.", none), []);
  // A named ticket must belong to the executed result.
  assert.deepEqual(kinds("Order 5123 was filled.", done), []);
  assert.deepEqual(kinds("Order 5130 was filled.", [...none, ...done]), ["EXECUTION_UNCONFIRMED"]);
  // Partial fills prove only a partial claim.
  const partial = [{ name: "getActionExecutionResult", result: { actionId: 5124, status: "partially_filled", filledLotSize: 0.05 } }];
  assert.deepEqual(kinds("Order 5124 is partially filled.", partial), []);
  assert.deepEqual(kinds("Order 5124 was executed.", partial), ["EXECUTION_UNCONFIRMED"]);
});

test("evidence index: numbers in text, array lengths, freshness frames, execution ids", () => {
  const idx = buildEvidenceIndex([{ name: "t", result: { note: "MAX_OPEN_TRADES_REACHED (3/5)", rows: [{}, {}], q: { stale: true, observedAt: "2026-11-09T13:58:00Z", bid: 1.2 }, order: { actionId: 7, mt5OrderTicket: 99, status: "executed" } } }], "risk 2%");
  const vals = idx.numbers.map((n) => n.value);
  for (const v of [3, 5, 2, 1.2, 7, 99]) assert.ok(vals.includes(v), `has ${v}`);
  assert.equal(idx.numbers.find((n) => n.value === 1.2)?.stale, true);
  assert.equal(idx.numbers.find((n) => n.value === 1.2)?.staleAsOf, "2026-11-09T13:58:00Z");
  assert.deepEqual(idx.executions.find((e) => e.executed)?.ids.sort(), ["7", "99"]);
  assert.ok(idx.numbers.some((n) => n.source === "user" && n.value === 2));
});
