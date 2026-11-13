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

test("full ISO timestamps are exact clock claims, not fragments of numbers", () => {
  for (const timestamp of ["2026-11-09T14:32:05.000Z", "2026-11-09T15:32:05+01:00", "2026-11-09 14:32:05Z"]) {
    const checked = checkClaims(`Observed at ${timestamp}.`, [snap()]);
    assert.deepEqual(checked.findings, [], timestamp);
    assert.equal(checked.claims.length, 1);
  }
  for (const timestamp of ["2026-11-08T14:32:05.000Z", "2026-11-09T14:32:06.000Z", "2026-11-09T14:32:05.001Z", "2026-11-09T15:32:05Z", "2026-11-09T14:32:05+01:00", "2026-02-30T14:32:05Z"]) {
    assert.deepEqual(kinds(`Observed at ${timestamp}.`, [snap()]), ["FABRICATION"], timestamp);
  }
  const source = [{ name:"readChartStructure", result:{observedTimeBasis:"source_clock", observedAt:"2026-11-09T14:32:05.000Z"} }];
  assert.deepEqual(kinds("Observed at 2026-11-09T14:32:05.000Z.", source), ["FABRICATION"]);
  assert.deepEqual(kinds("Observed at 2026-11-09T14:32:05 source clock.", source), []);
});

test("a source-clock chart read cannot be relabelled UTC by Eleanor", () => {
  for (const clock of [{ observedTimeBasis: "source_clock" }, { clockBasis: "broker_server" }, { timeBasisEvidence: { kind: "unavailable", basis: "BROKER_SERVER" } }]) {
    const output=[{name:"readChartStructure",result:{chartRead:{symbol:"EURUSD",observedAt:"2026-11-09T14:32:00.000Z",...clock}}}];
    assert.deepEqual(kinds("Observed at 14:32 source clock.",output),[]);
    assert.deepEqual(kinds("Observed at 14:32 UTC.",output),["FABRICATION"]);
  }
});
test("full timestamp precision may be shortened without changing its clock basis", () => {
  for (const timestamp of ["2026-11-09 14:32 UTC", "2026-11-09T14:32Z", "2026-11-09T15:32+01:00"]) {
    assert.deepEqual(kinds(`Observed at ${timestamp}.`, [snap()]), [], timestamp);
  }
  for (const timestamp of ["2026-11-09 14:33 UTC", "2026-11-08 14:32 UTC", "2026-11-09T15:32Z", "2026-11-09T14:32+01:00"]) {
    assert.deepEqual(kinds(`Observed at ${timestamp}.`, [snap()]), ["FABRICATION"], timestamp);
  }
});
test("a UTC word after a full timestamp still requires UTC evidence", () => {
  for (const evidence of [
    {observedTimeBasis:"source_clock", observedAt:"2026-11-09T14:32:05.000Z"},
    {observedAt:"2026-11-09T14:32:05"},
  ]) {
    const out = [{name:"readChartStructure", result:evidence}];
    for (const timestamp of ["2026-11-09 14:32:05 UTC", "2026-11-09 14:32 GMT", "2026-11-09T14:32Z"]) {
      assert.deepEqual(kinds(`Observed at ${timestamp}.`, out), ["FABRICATION"], timestamp);
    }
    assert.deepEqual(kinds("Observed at 2026-11-09 14:32 source clock.", out), []);
  }
});
test("offset wall-clock and zoneless timestamps never qualify as UTC as written",()=>{
  const offset=[{name:"getMarketSnapshot",result:{observedAt:"2026-11-09T15:32:00+01:00"}}];
  assert.deepEqual(kinds("Observed at 14:32 UTC.",offset),[]);
  assert.deepEqual(kinds("Observed at 15:32 UTC.",offset),["FABRICATION"]);
  assert.deepEqual(kinds("Observed at 15:32 local time.",offset),[]);
  const zoneless=[{name:"getMarketSnapshot",result:{observedAt:"2026-11-09T14:32:00"}}];
  assert.deepEqual(kinds("Observed at 14:32 UTC.",zoneless),["FABRICATION"]);
  assert.deepEqual(kinds("Observed at 14:32 source clock.",zoneless),[]);
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

test("live evaluation: requested risk-check size remains a request, not a market fact", () => {
  const request = "Buy 0.1 EURUSD";
  assert.deepEqual(kinds("Next: if you want, I can help you preview the setup, run a risk check for 0.1 EURUSD, or read EURUSD structure before you submit anything.", [], request), []);
  assert.ok(kinds("I can run a risk check for 0.2 EURUSD.", [], request).length);
  assert.ok(kinds("I can run a risk check for 0.1 GBPUSD.", [], request).length);
  assert.ok(kinds("EURUSD is currently trading at 0.1.", [], request).length, "a user-supplied size cannot prove a live price");
  assert.ok(kinds("I can run a risk check for 0.1 EURUSD, but the entry is 1.2500.", [], request).length, "a separate factual assertion remains checked");
});

test("live evaluation: a supplied action identifier in a conditional is not a status assertion", () => {
  assert.deepEqual(kinds("Next: If 5124 was rejected or failed, I can explain the blocker once the action record is available.", [], "Status of 5124?"), []);
  assert.ok(kinds("If 5125 was rejected or failed, I can explain the blocker.", [], "Status of 5124?").length);
  assert.ok(kinds("Your order 5124 was filled.", [], "Status of 5124?").includes("EXECUTION_UNCONFIRMED"));
  assert.ok(kinds("The fill price is 5124.", [], "Status of 5124?").length);
});

test("live evaluation: proposed response size and suggested command are not observed trading facts", () => {
  assert.deepEqual(kinds("Next: if you want, I can also give you 2–3 trade options for R_75 M15.", []), []);
  assert.deepEqual(kinds("If you want to use the guarded flow, type the direct command exactly as: **buy EURUSD 0.1** in the trade command flow.", []), []);
  assert.ok(kinds("The scanner found 3 trade options for R_75 M15.", []).length);
  assert.ok(kinds("I can show you 3 trade options with an entry of 41250.", []).length);
  assert.ok(kinds("Your order is **buy EURUSD 0.1**.", []).length);
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
  // A legacy boolean cannot replace measured calibration evidence.
  const cal = [{ name: "x", result: { hitProbability: 0.61, calibrated: true } }];
  assert.deepEqual(kinds("The calibrated hit probability is 61%.", cal), ["UNCALIBRATED_PROBABILITY"]);
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

test("live evaluation: capacity articles and hyphenated trade units preserve field identity", () => {
  assert.deepEqual(kinds("You have 2 open trades out of a 5-trade limit.", liveRisk), []);
  assert.deepEqual(kinds("You have 2 open trades out of a 2-trade limit.", liveRisk), ["WRONG_NUMBER"]);
  assert.deepEqual(kinds("You have 2 open trades out of a 9-trade limit.", liveRisk), ["FABRICATION"]);
});

test("live evaluation: terminal ratio punctuation does not invent a unit denominator", () => {
  const chart = [{name:"readChartStructure", result:{riskReward:2}}];
  assert.deepEqual(kinds("Reward to risk is 2:1.", chart), []);
  assert.ok(kinds("Reward to risk is 3:1.", chart).length);
  assert.ok(kinds("Observed at 12:01.", chart).length);
});

test("live evaluation: formatted command alternatives and offered risk preview are suggestions", () => {
  assert.deepEqual(kinds("Type the direct command exactly as: `buy EURUSD 0.1`.", []), []);
  assert.deepEqual(kinds("I can either analyze EURUSD first, run a risk preview for 0.1 lots, or walk you through confirmation.", [], "Buy 0.1 EURUSD"), []);
  assert.ok(kinds("I can run a risk preview for 0.2 lots.", [], "Buy 0.1 EURUSD").length);
  assert.ok(kinds("I can run a risk preview for 0.1 GBPUSD.", [], "Buy 0.1 EURUSD").length);
  assert.deepEqual(kinds("Send just the action ID, like: `142` or `action 142`.", []), []);
  assert.ok(kinds("Send just the action ID, like: `142`, but your order is `action 142`.", []).length);
});

test("live evaluation: a quoted direction explicitly called guesswork is not asserted", () => {
  assert.deepEqual(kinds("Without confirmed live candle context, any “BTC is bullish/bearish” answer would be guesswork.", []), []);
  assert.ok(kinds("The read says “BTC is bullish”.", []).includes("UNSUPPORTED_MARKET_STATE"));
  assert.ok(kinds("Any “BTC is bullish” answer would be guesswork, but BTC is bullish.", []).includes("UNSUPPORTED_MARKET_STATE"));
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
  assert.deepEqual(kinds("Your P&L is -3.65.", liveTrade), ["FABRICATION"], "a real minus sign still parses");
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

test("live run 4: a phrasing after 'send' is an example", () => {
  assert.deepEqual(kinds("Next: send **“check action #123”** or **“show my recent fills”**, and I'll check the actual execution status.", []), []);
  assert.deepEqual(kinds("I sent action #123 to the broker.", []), ["FABRICATION"], "an id stated as fact is still checked");
});

test('review regressions: preserve sign and bind numbers to their entity', () => {
  assert.ok(kinds('Your P&L is +$125.50.', [{name:'getTradeJournalSummary',result:{pnl:-125.5}}]).length);
  const quotes=[{name:'getMarketSnapshot',result:{symbol:'EURUSD',lastPrice:1.08}},{name:'getMarketSnapshot',result:{symbol:'GBPUSD',lastPrice:1.28}}];
  assert.deepEqual(kinds('EURUSD is trading at 1.2800.',quotes),['WRONG_NUMBER']);
  assert.deepEqual(kinds('EURUSD is trading at 1.0800.',quotes),[]);
  const positions=[{name:'getOpenPositions',result:{positions:[{ticket:12345,pnl:-100},{ticket:67890,pnl:500}]}}];
  assert.deepEqual(kinds('Position #12345 has P&L of +$500.',positions),['WRONG_NUMBER']);
});
test('review regressions: execution proof and spelled-out financial facts', () => {
  assert.deepEqual(kinds('Your order was filled, no further action is needed.',[]),['EXECUTION_UNCONFIRMED']);
  assert.deepEqual(kinds('Your order was filled.',[{name:'getMarketSnapshot',result:{status:'completed'}}]),['EXECUTION_UNCONFIRMED']);
  assert.deepEqual(kinds('Your current balance is ten thousand dollars.',[]),['FABRICATION']);
});


test("execution negation is local to each clause", () => {
  assert.deepEqual(kinds("No problem, your order was filled.", []), ["EXECUTION_UNCONFIRMED"]);
  assert.deepEqual(kinds("Your order was not filled, but your trade was executed.", []), ["EXECUTION_UNCONFIRMED"]);
  assert.deepEqual(kinds("Your order was not filled.", []), []);
});

test("live evaluation: typographic negation and status inquiries never assert an execution", () => {
  assert.deepEqual(kinds("If this was meant to be a filled order, I won’t claim it went through without a confirmed execution result.", []), []);
  assert.deepEqual(kinds("I can verify whether it’s still pending, executed, rejected, or failed, and give you the order fill details if available.", []), []);
  assert.deepEqual(kinds("For your order, I can verify whether it is queued, rejected, executed, or failed.", []), []);
  assert.ok(kinds("Your order hasn’t failed, and it was filled.", []).includes("EXECUTION_UNCONFIRMED"));
  assert.ok(kinds("I can verify whether it is pending, but your order was executed.", []).includes("EXECUTION_UNCONFIRMED"));
  assert.ok(kinds("For your order, I can verify whether it is pending, it was executed.", []).includes("EXECUTION_UNCONFIRMED"));
  assert.ok(kinds("I can verify whether it is pending, your order was executed.", []).includes("EXECUTION_UNCONFIRMED"));
});

test("live evaluation: send-me and try-asking quoted examples retain their instructional meaning", () => {
  assert.deepEqual(kinds("Next: try asking **“did my order execute for 5124?”** again in a moment.", []), []);
  assert.deepEqual(kinds("Next: if you have the action number, send me “did action #123 execute” and I’ll check the exact status.", []), []);
  assert.ok(kinds("Your order is “action #123”.", []).length);
  assert.ok(kinds("Send me “action #123”, but your order #123 was executed.", []).includes("EXECUTION_UNCONFIRMED"));
});

test("requested commands and identifier lookups remain requests across line breaks", () => {
  assert.deepEqual(kinds("Type the direct command exactly as:\n**buy EURUSD 0.10**", [], "Buy 0.1 EURUSD"), []);
  for (const command of ["buy EURUSD 0.20", "sell EURUSD 0.10", "buy GBPUSD 0.10", "EURUSD is trading at 0.10"]) {
    assert.ok(kinds(command, [], "Buy 0.1 EURUSD").length, command);
  }
  assert.deepEqual(kinds("Next: you can also open the Action Center and look up action **5124** there for its current status.", [], "Status of 5124?"), []);
  assert.ok(kinds("Look up action **5125** there.", [], "Status of 5124?").length);
  assert.ok(kinds("Check action **5124**, but your order was filled.", [], "Status of 5124?").includes("EXECUTION_UNCONFIRMED"));
});

test("live evaluation: inline requested commands and comma-separated examples preserve factual checks", () => {
  assert.deepEqual(kinds("Use the Trade Ticket and enter: buy EURUSD 0.1.", [], "Buy 0.1 EURUSD"), []);
  assert.deepEqual(kinds("Next: say “analyze EURUSD”, “check risk for EURUSD 0.1”, or “validate this ticket”.", []), []);
  assert.ok(kinds("EURUSD is trading at 0.1, enter: buy EURUSD 0.1.", [], "Buy 0.1 EURUSD").length);
  assert.ok(kinds("Use the ticket and enter: buy GBPUSD 0.1.", [], "Buy 0.1 EURUSD").length);
});

test("live evaluation: filled size without a unit binds to quantity rather than price", () => {
  assert.deepEqual(kinds("Fill price was 1.08531, slippage was 0.00011, filled size was 0.1.", liveFill), []);
  assert.ok(kinds("Filled size was 1.08531.", liveFill).includes("WRONG_NUMBER"));
  assert.ok(kinds("Fill price was 0.1.", liveFill).includes("WRONG_NUMBER"));
});

test("live evaluation: global book count cannot borrow a price or a different symbol's count", () => {
  const book = [{name:"getMyLiveOpenTrades", result:{count:1,trades:[{symbol:"R_75",volume:0.01}]}}];
  assert.deepEqual(kinds("I can see 1 verified live trade: R_75.", book), []);
  assert.ok(kinds("I can see 2 verified live trades: R_75.", book).length);
  assert.ok(kinds("R_75 is trading at 1.", book).length);
  assert.ok(kinds("EURUSD has 1 live trade.", book).length);
});


test("nested instruments replace parent scope and unscoped numbers cannot prove a scoped price", () => {
  const outputs = [{ name: "getMarketSnapshot", result: { symbol: "EURUSD", lastPrice: 1.08, count: 2, related: { symbol: "GBPUSD", lastPrice: 1.28 } } }];
  assert.ok(kinds("EURUSD is trading at 1.2800.", outputs).includes("WRONG_NUMBER"));
  assert.deepEqual(kinds("GBPUSD is trading at 1.2800.", outputs), []);
});


test("a partial fill cannot prove a subsequent complete execution claim", () => {
  const partial = [{ name: "getActionExecutionResult", result: { actionId: 5124, status: "partially_filled", filledLotSize: 0.05 } }];
  assert.ok(kinds("Order 5124 was partially filled and fully executed.", partial).includes("EXECUTION_UNCONFIRMED"));
});
