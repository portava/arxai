// instantTradeParserTest — proves the Ruby trade-command parser
// distinguishes CLEAR direct commands from VAGUE analysis questions.
// Vague questions MUST never reach the executor. Run with:
//   pnpm --filter @workspace/scripts run test:ruby-parser
import { parseTradeCommand } from "../../artifacts/api-server/src/lib/assistant/parseTradeCommand.js";

type Case = { name: string; text: string; expectKind: string; extra?: (got: ReturnType<typeof parseTradeCommand>) => boolean };
const defaults = { defaultSymbol: "EURUSD", defaultVolume: 0.01, defaultOrderType: "MARKET_BUY" };

const CASES: Case[] = [
  // Clear directives
  { name: "buy with size", text: "buy EURUSD 0.01", expectKind: "OPEN", extra: g => g.kind === "OPEN" && g.side === "BUY" && g.symbol === "EURUSD" && g.volume === 0.01 },
  { name: "sell gold", text: "sell gold 0.05", expectKind: "OPEN", extra: g => g.kind === "OPEN" && g.side === "SELL" && g.symbol === "XAUUSD" && g.volume === 0.05 },
  { name: "go long no size uses default", text: "go long XAUUSD", expectKind: "OPEN", extra: g => g.kind === "OPEN" && g.side === "BUY" && g.symbol === "XAUUSD" && g.volume === 0.01 },
  { name: "close one symbol", text: "close my EURUSD", expectKind: "CLOSE_ONE", extra: g => g.kind === "CLOSE_ONE" && g.symbol === "EURUSD" },
  { name: "close all", text: "close all trades", expectKind: "CLOSE_ALL" },
  { name: "close all winners", text: "close all winners", expectKind: "CLOSE_PROFITABLE" },
  { name: "close all losers", text: "close all losers", expectKind: "CLOSE_LOSING" },
  // SAFETY-CRITICAL: "close all EURUSD" must NEVER classify as CLOSE_ALL
  { name: "close all <symbol> refused", text: "close all EURUSD", expectKind: "CLOSE_ALL_SYMBOL_UNSUPPORTED", extra: g => g.kind === "CLOSE_ALL_SYMBOL_UNSUPPORTED" && g.symbol === "EURUSD" },
  { name: "close all gold refused", text: "close all gold", expectKind: "CLOSE_ALL_SYMBOL_UNSUPPORTED", extra: g => g.kind === "CLOSE_ALL_SYMBOL_UNSUPPORTED" && g.symbol === "XAUUSD" },
  { name: "set TP", text: "set TP on EURUSD to 1.0920", expectKind: "MODIFY", extra: g => g.kind === "MODIFY" && g.newTakeProfit === 1.092 },
  { name: "move SL to break even", text: "move SL on XAUUSD to break even", expectKind: "MOVE_SL_TO_BREAKEVEN", extra: g => g.kind === "MOVE_SL_TO_BREAKEVEN" && g.positionRef?.symbol === "XAUUSD" },
  // SAFETY-CRITICAL: "close 50%" must be a PARTIAL_CLOSE, never a full CLOSE_ONE
  { name: "close 50% partial", text: "close 50% of EURUSD", expectKind: "PARTIAL_CLOSE", extra: g => g.kind === "PARTIAL_CLOSE" && g.symbol === "EURUSD" && g.fraction === 0.5 },
  { name: "close 50% no-of partial", text: "close 50% EURUSD", expectKind: "PARTIAL_CLOSE", extra: g => g.kind === "PARTIAL_CLOSE" && g.symbol === "EURUSD" && g.fraction === 0.5 },
  // Missing-data
  { name: "buy no size no default", text: "buy XAUUSD", expectKind: "OPEN", extra: g => g.kind === "OPEN" && g.volume === 0.01 }, // default kicks in
  // --- Task #750 new actions (conditional entries, pending, trailing, risk%) ---
  // Conditional/pending ENTRY with a price → watch-and-enter (CAS-fires a gated
  // MARKET order at the trigger). "limit"/"stop" are copy hints, NOT a
  // broker-native pending order.
  { name: "buy limit with price", text: "buy EURUSD limit when it hits 1.0850", expectKind: "WATCH_AND_ENTER", extra: g => g.kind === "WATCH_AND_ENTER" && g.side === "BUY" && g.symbol === "EURUSD" && g.pendingKind === "LIMIT" },
  { name: "sell stop with price", text: "sell gold stop order when it hits 1830", expectKind: "WATCH_AND_ENTER", extra: g => g.kind === "WATCH_AND_ENTER" && g.side === "SELL" && g.symbol === "XAUUSD" && g.pendingKind === "STOP" },
  { name: "conditional entry with expiry", text: "buy EURUSD when it hits 1.0850 expire in 30 minutes", expectKind: "WATCH_AND_ENTER", extra: g => g.kind === "WATCH_AND_ENTER" && g.expiresInMinutes === 30 },
  { name: "expiry hours capped phrasing", text: "buy EURUSD when it hits 1.0850 good for 2 hours", expectKind: "WATCH_AND_ENTER", extra: g => g.kind === "WATCH_AND_ENTER" && g.expiresInMinutes === 120 },
  // Pending entry intent WITHOUT a price → must ask, never guess a level.
  { name: "limit without price asks", text: "set a buy limit on EURUSD", expectKind: "PENDING_NEEDS_PRICE", extra: g => g.kind === "PENDING_NEEDS_PRICE" && g.side === "BUY" && g.symbol === "EURUSD" && g.pendingKind === "LIMIT" },
  { name: "stop entry without price asks", text: "place a sell stop order on gold", expectKind: "PENDING_NEEDS_PRICE", extra: g => g.kind === "PENDING_NEEDS_PRICE" && g.side === "SELL" && g.symbol === "XAUUSD" && g.pendingKind === "STOP" },
  // Cancel a pending/conditional order → distinct copy, same stand-down handler.
  { name: "cancel pending order with symbol", text: "cancel my pending order on EURUSD", expectKind: "CANCEL_PENDING_ORDER", extra: g => g.kind === "CANCEL_PENDING_ORDER" && g.symbol === "EURUSD" },
  { name: "cancel limit order no symbol", text: "cancel the limit order", expectKind: "CANCEL_PENDING_ORDER", extra: g => g.kind === "CANCEL_PENDING_ORDER" && g.symbol === undefined },
  // "cancel my stop order" must NOT be confused with "cancel" / stop-loss.
  { name: "cancel stop order not stoploss", text: "cancel my buy stop order on gold", expectKind: "CANCEL_PENDING_ORDER", extra: g => g.kind === "CANCEL_PENDING_ORDER" && g.symbol === "XAUUSD" },
  // Trailing stop → honest decline (no schema/EA path), never a fixed stop.
  { name: "trailing stop unsupported", text: "set a trailing stop on EURUSD", expectKind: "TRAILING_STOP_UNSUPPORTED", extra: g => g.kind === "TRAILING_STOP_UNSUPPORTED" && g.symbol === "EURUSD" },
  { name: "trail my stop unsupported", text: "trail my stop 20 pips on gold", expectKind: "TRAILING_STOP_UNSUPPORTED", extra: g => g.kind === "TRAILING_STOP_UNSUPPORTED" && g.symbol === "XAUUSD" },
  // Risk-percent sizing → ask for exact lots (can't size safely w/o specs).
  { name: "risk percent sizing", text: "buy EURUSD risking 1%", expectKind: "RISK_PERCENT_SIZING", extra: g => g.kind === "RISK_PERCENT_SIZING" && g.side === "BUY" && g.symbol === "EURUSD" && g.riskPercent === 1 },
  { name: "risk percent trailing word", text: "sell gold with 2% risk", expectKind: "RISK_PERCENT_SIZING", extra: g => g.kind === "RISK_PERCENT_SIZING" && g.side === "SELL" && g.symbol === "XAUUSD" && g.riskPercent === 2 },
  // Explicit lot wins over risk% (never both-size a single order).
  { name: "explicit lot beats risk percent", text: "buy EURUSD 0.02 risking 1%", expectKind: "OPEN", extra: g => g.kind === "OPEN" && g.volume === 0.02 },
  // "set stop loss" must NOT be mistaken for a trailing/pending action.
  { name: "plain SL still modify", text: "set SL on EURUSD to 1.0800", expectKind: "MODIFY", extra: g => g.kind === "MODIFY" && g.newStopLoss === 1.08 },

  // VAGUE — must NEVER execute
  { name: "vague: what should I trade", text: "what should I trade today?", expectKind: "VAGUE" },
  { name: "vague: is gold bullish", text: "is gold bullish?", expectKind: "VAGUE" },
  { name: "vague: do you think", text: "do you think EURUSD is going up?", expectKind: "VAGUE" },
  { name: "vague: should I buy", text: "should I buy gold?", expectKind: "VAGUE" },
  { name: "vague: find me a setup", text: "find me a setup", expectKind: "VAGUE" },
  { name: "vague: any ideas", text: "any ideas?", expectKind: "VAGUE" },
  // UNKNOWN
  { name: "unknown gibberish", text: "lorem ipsum dolor", expectKind: "UNKNOWN" },
];

let pass = 0, fail = 0;
for (const c of CASES) {
  const got = parseTradeCommand(c.text, defaults);
  const kindOk = got.kind === c.expectKind;
  const extraOk = c.extra ? c.extra(got) : true;
  if (kindOk && extraOk) { pass++; console.log(`PASS  ${c.name}  (${got.kind})`); }
  else { fail++; console.log(`FAIL  ${c.name}  expected=${c.expectKind} got=${JSON.stringify(got)}`); }
}
console.log(`\n${pass}/${pass + fail} PASS`);
if (fail > 0) process.exit(1);
