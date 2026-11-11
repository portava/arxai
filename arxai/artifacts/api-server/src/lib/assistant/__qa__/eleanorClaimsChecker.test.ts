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
  const scan = [{ name: "getMarketScannerOpportunities", result: { opportunities: [{ symbol: "GBPUSD", score: 72, riskRewardRatio: 2.1 }] } }];
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

// ── False alarms found on the first live-model run (gpt-5.4, run 42961788010) ──
// Each answer below is the model's real text. All of it is correct, and the
// checker used to flag it. The paired assertions prove real errors are still caught.
const liveFill = [{ name: "getRecentExecutionResults", result: { ok: true, count: 1, results: [{ actionId: 5123, status: "executed", mt5PositionTicket: 70011224, fillPrice: 1.08531, slippage: 0.00011, filledLotSize: 0.1, executedAt: "2026-11-09T14:33:02.000Z" }] } }];
const liveTrade = [{ name: "getMyLiveOpenTrades", result: { count: 1, trades: [{ ticket: 50012345, side: "SELL", volume: 0.01, openPrice: 412345.12, currentPrice: 411980.5, profit: 3.65, sl: 415000, tp: 405000 }] } }];
const liveRisk = [{ name: "getRiskUtilization", result: { openTrades: 2, maxOpenTrades: 5, openTradesUtilization: 40 } }];

test("live run: a filled size labelled with its unit is the lot-size field, not the fill price", () => {
  assert.deepEqual(kinds("Your fill price was 1.08531 with slippage of 0.00011, and the filled size was 0.1 lots.", liveFill), []);
  assert.deepEqual(kinds("The filled size was 0.2 lots.", liveFill), ["WRONG_NUMBER"], "a wrong size is still caught");
});

test("live run: 'take profit' is the tp field, never the shorter 'profit' field", () => {
  assert.deepEqual(kinds("- Stop loss is 415000\n- Take profit is 405000", liveTrade), []);
  assert.deepEqual(kinds("Take profit is 3.65.", liveTrade), ["WRONG_NUMBER"], "the P&L quoted as the take profit is still wrong");
  assert.deepEqual(kinds("Stop loss is 405000.", liveTrade), ["WRONG_NUMBER"], "the tp quoted as the stop is still wrong");
});

test("live run: 'N out of M' reads M as the capacity, not the count", () => {
  assert.deepEqual(kinds("You're using 40% of your open-trade capacity right now: 2 open trades out of 5.", liveRisk), []);
  assert.deepEqual(kinds("2 open trades out of 7.", liveRisk), ["FABRICATION"], "an invented capacity is still caught");
  assert.deepEqual(kinds("You have 5 open trades.", liveRisk), ["WRONG_NUMBER"], "the capacity quoted as the count is still wrong");
});

test("live run: the 1 of a 2:1 ratio and an offered 'top 5' are not claims", () => {
  const chart = [{ name: "readChartStructure", result: { entry: 41250.5, invalidation: 41020, takeProfit: 41710, riskReward: 2 } }];
  assert.deepEqual(kinds("Entry at 41250.5, invalidation at 41020, and take profit at 41710, with 2:1 reward-to-risk.", chart), []);
  assert.deepEqual(kinds("Next: I can rescan for the top 5 setups only.", chart), []);
  assert.deepEqual(kinds("Entry is 41300.", chart), ["WRONG_NUMBER"], "a real price is still checked");
});

test("live run: phrasings suggested to the user are examples, not claims", () => {
  for (const t of [
    "If you have an action ID, send something like “did action #123 execute?” and I'll check the broker result.",
    "Which action do you want me to check — give me the action number, like **#123**.",
    "Next: reply with something like “action 42” or “check my recent fills.”",
    "Next: send the action number like “check action 42” or say “show my live trades.”",
    "Send the action ID, like “action #123”, and I'll check whether it executed.",
    "- “check this trade ticket: buy stop EURUSD 0.01, entry 1.0850, SL 1.0820, TP 1.0910”",
  ]) assert.deepEqual(kinds(t, []), [], t);
  // A quoted figure stated as fact, with no example cue, is still a claim.
  assert.deepEqual(kinds("Your stop is “1.0820”.", []), ["FABRICATION"]);
  assert.deepEqual(kinds("Your order #123 executed at 1.0850.", []).sort(), ["EXECUTION_UNCONFIRMED", "FABRICATION", "FABRICATION"].sort());
});

test("live run 2: a bullet dash is not a minus, and 'profit target' is the tp field", () => {
  const text = "It's currently up 3.65, opened at 412345.12, with price around 411980.5, stop at 415000 and target at 405000.\n\nWhat to watch:\n- Price staying below 412345.12 keeps the short under less pressure.\n- 415000 is the clear invalidation level from your stop.\n- 405000 is the profit target already set on the trade.";
  assert.deepEqual(kinds(text, liveTrade), []);
  assert.deepEqual(kinds("- 3.65 is the profit target.", liveTrade), ["WRONG_NUMBER"], "the P&L quoted as the target is still wrong");
  assert.deepEqual(kinds("Your P&L is -3.65.", liveTrade), [], "a real minus sign still parses");
});

test("live run 3: 'nothing was filled', 'N of M slots' and a `code` example are not false claims", () => {
  const rejected = [{ name: "getActionExecutionResult", result: { ok: true, actionId: 5126, status: "rejected", fillPrice: null, rejectionReason: "Market closed for EURUSD." } }];
  assert.deepEqual(kinds("Fill price, slippage, lot fill, and execution time are all unknown because nothing was filled.", rejected), []);
  assert.deepEqual(kinds("Your buy was filled.", rejected), ["EXECUTION_UNCONFIRMED"], "a claimed fill on a rejection is still caught");
  assert.deepEqual(kinds("You're using 2 of 5 open trade slots, so your open-trade usage is 40%.", liveRisk), []);
  assert.deepEqual(kinds("You're using 2 of 9 open trade slots.", liveRisk), ["FABRICATION"], "an invented capacity is still caught");
  assert.deepEqual(kinds("If you share the idea — for example `buy EURUSD, entry 1.0820, stop 1.0790, TP 1.0880` — I can score it.", []), []);
  assert.deepEqual(kinds("Your entry is `1.0820`.", []), ["FABRICATION"], "a code-formatted fact without an example cue is still checked");
});
