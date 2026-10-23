// Test: deterministic chart-read ROUTING for Ruby chat (Task #602 follow-up).
//
// The bug: Ruby CHAT collapsed to "Data insufficient / no primary timeframe /
// key levels not available" for a single-symbol read ("read V75 1h") while the
// Scanner "Ruby Chart Read" panel produced a real structural read. Root cause:
// the chat handler used tool_choice:"auto" and the model drifted to the OLD
// getSymbolMarketContext path instead of readChartStructure.
//
// The fix makes routing DETERMINISTIC: detectChartReadIntent() classifies the
// user's first message, and resolveAssistantToolChoice() FORCES tool_choice to
// readChartStructure on the first turn of a chart-read request (else "auto").
// Both are pure (no DB / no network / no LLM), so this test proves the routing
// decision WITHOUT invoking the model — the exact gap the parity harness (which
// bypasses the LLM at the service layer) could not cover.
//
// Run: pnpm --filter @workspace/scripts run test:ruby-chart-read-intent-routing

import {
  detectChartReadIntent,
  detectTradeOptionsIntent,
  resolveAssistantToolChoice,
} from "../../artifacts/api-server/src/lib/assistant/chartReadRouting.js";

let passes = 0;
let failures = 0;
function assert(cond: boolean, label: string): void {
  if (cond) {
    passes++;
    // eslint-disable-next-line no-console
    console.log(`  \u2713 ${label}`);
  } else {
    failures++;
    // eslint-disable-next-line no-console
    console.error(`  \u2717 ${label}`);
  }
}

// Messages that MUST route to the structural chart read.
const SHOULD_DETECT: string[] = [
  "read V75 1h",
  "read v75 on the 15m",
  "read the chart",
  "read my chart",
  "read this",
  "read it",
  "re-read the structure",
  "redo on GBPUSD",
  "redo the chart",
  "analyze EURUSD",
  "analyse boom 1000",
  "can you analyze XAUUSD for me",
  "analysis on V75",
  "analysis of EURUSD please",
  "what do you see",
  "what can you see on this chart",
  "what's the structure",
  "whats the setup here",
  "what is the read",
  "your read on gold",
  "give me a read",
  "chart read",
  "chart structure please",
  "structure on V75",
  "bias for EURUSD",
];

// Messages that MUST NOT be hijacked into the chart read (balance/account,
// pure execution, trade-management, and own-performance analysis all keep their
// existing flows).
const SHOULD_NOT_DETECT: string[] = [
  "what's my balance",
  "how much money do I have",
  "buy EURUSD",
  "sell V75 now",
  "place a trade on V75",
  "close all my positions",
  "should I hold these V75 buys",
  "how is my trade looking",
  "analyze my performance",
  "analyze my trades",
  "analyze my open positions",
  "analyze my positions",
  "analyse my current orders",
  "analyze my holdings",
  "analyse my trading journal",
  "show me my journal",
  "where are the analysis tools",
  "what's the weather",
  "hello ruby",
  "",
  "   ",
];

// Trade-OPTIONS requests that MUST force the honesty-gated structural read
// (Upgrade Eleanor Options Response Logic). detectChartReadIntent misses most of
// these; detectTradeOptionsIntent is the added coverage.
const SHOULD_DETECT_OPTIONS: string[] = [
  "what are my options",
  "what are my options here",
  "what are the options",
  "give me some options",
  "show me my options",
  "any options on V75",
  "trade options for gold",
  "possible entries",
  "possible entries on EURUSD",
  "where can I enter",
  "where do I get in",
  "where to enter",
  "entry points",
  "entry ideas for V75",
  "how would I trade this",
  "how do I trade this",
  "trade setups",
  "any setups",
  "show me some setups",
  "give me a trade plan",
  "what's the game plan",
];

// "options" / "setups" phrasings that MUST NOT be hijacked: equity-derivatives
// sense, account / billing / navigation options, and own-account performance.
const SHOULD_NOT_DETECT_OPTIONS: string[] = [
  "what are the payment options",
  "show me withdrawal options",
  "options trading strategy",
  "option chain for AAPL",
  "what are my account options",
  "settings options",
  "the options menu is confusing",
  "options for withdrawing funds",
  "analyze my performance",
  "analyze my positions",
  "what's my balance",
  "buy EURUSD",
  "close all my positions",
  "hello ruby",
  "",
  "   ",
];

export async function run(): Promise<{ name: string; passes: number; failures: number }> {
  passes = 0;
  failures = 0;
  // eslint-disable-next-line no-console
  console.log("rubyChartReadIntentRoutingTest");
  // eslint-disable-next-line no-console
  console.log("==============================\n");

  // ── A — detectChartReadIntent: chart-read phrasings are detected ──────────
  // eslint-disable-next-line no-console
  console.log("A — chart-read phrasings ARE detected");
  for (const msg of SHOULD_DETECT) {
    assert(detectChartReadIntent(msg) === true, `detect: ${JSON.stringify(msg)}`);
  }

  // ── B — detectChartReadIntent: non-chart-read phrasings are NOT detected ──
  // eslint-disable-next-line no-console
  console.log("\nB — balance / execution / trade-mgmt / own-performance are NOT detected");
  for (const msg of SHOULD_NOT_DETECT) {
    assert(detectChartReadIntent(msg) === false, `skip:   ${JSON.stringify(msg)}`);
  }

  // ── C — resolveAssistantToolChoice forces readChartStructure correctly ────
  // eslint-disable-next-line no-console
  console.log("\nC — tool_choice resolution (first-turn force, else auto)");
  const forced = resolveAssistantToolChoice(0, true);
  assert(
    typeof forced === "object" &&
      forced.type === "function" &&
      forced.function.name === "readChartStructure",
    "turn 0 + chart-read intent → force readChartStructure",
  );
  assert(
    resolveAssistantToolChoice(0, false) === "auto",
    "turn 0 + no chart-read intent → auto",
  );
  assert(
    resolveAssistantToolChoice(1, true) === "auto",
    "turn 1 + chart-read intent → auto (model finalizes after the forced read)",
  );
  assert(
    resolveAssistantToolChoice(3, true) === "auto",
    "later turn + chart-read intent → auto (no re-force loop)",
  );

  // ── D — detectTradeOptionsIntent: options/setups requests ARE detected ────
  // eslint-disable-next-line no-console
  console.log("\nD — trade-OPTIONS phrasings ARE detected (Upgrade Eleanor Options Logic)");
  for (const msg of SHOULD_DETECT_OPTIONS) {
    assert(detectTradeOptionsIntent(msg) === true, `options-detect: ${JSON.stringify(msg)}`);
  }

  // ── E — account / billing / derivatives / performance are NOT detected ────
  // eslint-disable-next-line no-console
  console.log("\nE — billing / derivatives / navigation / performance 'options' are NOT detected");
  for (const msg of SHOULD_NOT_DETECT_OPTIONS) {
    assert(detectTradeOptionsIntent(msg) === false, `options-skip:   ${JSON.stringify(msg)}`);
  }

  // ── F — the force decision ORs chart-read intent + options intent ─────────
  // eslint-disable-next-line no-console
  console.log("\nF — options intent forces readChartStructure via the OR at the call site");
  const optionsMsg = "what are my options";
  assert(
    detectChartReadIntent(optionsMsg) === false,
    "control: the chart-read classifier alone misses 'what are my options'",
  );
  const forcedByOptions = resolveAssistantToolChoice(
    0,
    detectChartReadIntent(optionsMsg) || detectTradeOptionsIntent(optionsMsg),
  );
  assert(
    typeof forcedByOptions === "object" &&
      forcedByOptions.type === "function" &&
      forcedByOptions.function.name === "readChartStructure",
    "turn 0 + options intent → force readChartStructure",
  );
  const balanceMsg = "what's my balance";
  const notForced = resolveAssistantToolChoice(
    0,
    detectChartReadIntent(balanceMsg) || detectTradeOptionsIntent(balanceMsg),
  );
  assert(notForced === "auto", "turn 0 + neither intent → auto");

  // eslint-disable-next-line no-console
  console.log(`\nResult: ${passes} passed, ${failures} failed`);
  return { name: "rubyChartReadIntentRoutingTest", passes, failures };
}

if (import.meta.url === `file://${process.argv[1]}`) {
  run().then(
    (r) => process.exit(r.failures > 0 ? 1 : 0),
    (err) => {
      // eslint-disable-next-line no-console
      console.error("[rubyChartReadIntentRoutingTest] FAILED:", err);
      process.exit(1);
    },
  );
}
