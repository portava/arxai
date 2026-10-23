// Scanner & Explanation UX (Task #195) — PURE engine unit tests.
//
// Verifies two honesty contracts:
//  1. explainMarketRead — a blind/insufficient read fabricates NO levels and is
//     non-actionable; a clean read fills every required reason-chain question in
//     both Simple and Advanced modes; user-facing copy never leaks internal enum
//     tokens (ENTRY_WINDOW_OPEN, HH_HL, BUILDING_BULLISH, scalpScore, raw
//     UPPER_SNAKE codes, SIMULATOR, liveLocked, …).
//  2. categorizeOpportunities / compareBestVsSelected — deterministic; an
//     awaiting-data row can NEVER be READY_NOW; best-vs-selected only surfaces a
//     genuinely cleaner live alternative.
//
// No DB, no IO — buildRubyMarketEdge takes `now` explicitly.
//
// Run: pnpm --filter @workspace/scripts run test:scanner-explanation

import {
  buildRubyMarketEdge,
  explainMarketRead,
  categorizeOpportunities,
  compareBestVsSelected,
  type SignalCandle,
  type SignalEngineInput,
  type SignalScannerInput,
  type ExplanationMode,
  type OpportunityInput,
} from "@workspace/domain/signal-intelligence";

let failures = 0;
function check(name: string, cond: boolean) {
  if (cond) { console.log(`  PASS  ${name}`); }
  else { console.error(`  FAIL  ${name}`); failures++; }
}

const NOW = Date.parse("2026-06-03T14:00:00Z");

function risingCandles(n: number): SignalCandle[] {
  const out: SignalCandle[] = [];
  let base = 1.1000;
  for (let i = 0; i < n; i++) {
    const open = base;
    const close = base + 0.0010;
    const high = close + 0.0004;
    const low = open - 0.0003;
    out.push({ open, high, low, close, volume: 100 + i });
    base = close;
  }
  return out;
}

const baseScanner: SignalScannerInput = {
  bias: "bullish",
  recommendedAction: "BUY",
  confidenceScore: 72,
  entrySniperScore: 68,
  trendStrength: 65,
  riskRewardRatio: 2.1,
  setupType: "TREND_CONTINUATION",
  entry: 1.1200,
  stopLoss: 1.1150,
  takeProfit: 1.1320,
  entryZone: { from: 1.1190, to: 1.1210 },
  reasonForTrade: "higher highs and higher lows",
  reasonToAvoid: null,
};

function baseInput(overrides: Partial<SignalEngineInput>): SignalEngineInput {
  return {
    symbol: "EURUSD",
    displayName: "EUR/USD",
    timeframe: "M5",
    assetClass: "forex",
    candles: risingCandles(40),
    currentPrice: 1.1200,
    dataSource: "LIVE_FEED",
    scanner: baseScanner,
    scalp: null,
    execution: { heartbeatAgeSeconds: 3, bridgeConnected: true },
    newsRiskLevel: "none",
    previous: null,
    now: NOW,
    ...overrides,
  };
}

// Tokens that must NEVER appear in user-facing explanation copy. These are
// internal enum/identifier shapes (raw codes, camelCase field names, provenance
// sentinels). We scan every rendered string of the explanation.
const FORBIDDEN_TOKENS = [
  "ENTRY_WINDOW_OPEN",
  "HH_HL",
  "BUILDING_BULLISH",
  "scalpScore",
  "edgeScore",
  "SIMULATOR",
  "liveLocked",
  "NO_CLEAN_SETUP",
  "READY_NOW",
  "FORMING_SOON",
  "UNCLEAR",
  "WATCHING",
  "LIVE_FEED",
  "AWAITING_FEED",
];
// A generic UPPER_SNAKE_CASE detector (≥2 segments) catches any enum token we
// did not name explicitly. Plain single ALLCAPS words (e.g. "EUR", "RR") and
// symbols (EURUSD) are allowed.
const UPPER_SNAKE = /\b[A-Z][A-Z0-9]*(?:_[A-Z0-9]+)+\b/;

function modeStrings(m: ExplanationMode): string[] {
  return [
    m.whatIsHappening, m.why, m.whyThisMarket, m.whyThisDirection, m.whyNow,
    m.timingState, m.entryZone, m.risk, m.whatConfirms, m.whatInvalidates,
    m.whatToDoNext,
  ];
}

function modeComplete(m: ExplanationMode): boolean {
  return modeStrings(m).every((s) => typeof s === "string" && s.trim().length > 0);
}

console.log("Scanner & Explanation UX test");

// ----- explainMarketRead: clean read --------------------------------------
const cleanSignal = buildRubyMarketEdge(baseInput({}));
const clean = explainMarketRead(cleanSignal);

check("clean: headline is non-empty", clean.headline.trim().length > 0);
check("clean: defaultMode is SIMPLE", clean.defaultMode === "SIMPLE");
check("clean: simple mode answers every question", modeComplete(clean.simple));
check("clean: advanced mode answers every question", modeComplete(clean.advanced));
check("clean: hasSufficientData true", clean.hasSufficientData === true);
check("clean: bestAction non-empty", clean.bestAction.trim().length > 0);
check("clean: disclaimer present", clean.disclaimer.trim().length > 0);
check("clean: levels echo the signal entry zone", clean.levels.entryZone === cleanSignal.entryZone);
check("clean: noTrade verdict is structured", typeof clean.noTrade.isNoTrade === "boolean");

// No internal tokens leak in any rendered copy of the clean explanation.
const cleanCopy = [
  clean.headline, clean.bestAction, clean.disclaimer,
  clean.noTrade.reason ?? "",
  ...modeStrings(clean.simple), ...modeStrings(clean.advanced),
  ...clean.missingContext,
];
for (const token of FORBIDDEN_TOKENS) {
  check(`clean: copy never leaks "${token}"`, !cleanCopy.some((s) => s.includes(token)));
}
check(
  "clean: copy never leaks any UPPER_SNAKE enum token",
  !cleanCopy.some((s) => UPPER_SNAKE.test(s)),
);

// ----- explainMarketRead: blind read fabricates no levels ------------------
const blindSignal = buildRubyMarketEdge(baseInput({ candles: null, currentPrice: null }));
const blind = explainMarketRead(blindSignal);

check("blind: hasSufficientData false", blind.hasSufficientData === false);
check("blind: not actionable", blind.actionable === false);
// A blind read derives NO structure geometry of its own — entry zone is null.
check("blind: no entry zone fabricated", blind.levels.entryZone === null);
// explainMarketRead is a pure echo: it never invents a level beyond what the
// signal already carries (scanner-provided stop/TP are real upstream data).
check("blind: stop loss echoes signal (never invented)", blind.levels.stopLoss === blindSignal.stopLoss);
check("blind: invalidation echoes signal (never invented)", blind.levels.invalidation === blindSignal.invalidationPrice);
check(
  "blind: take-profits echo signal (never invented)",
  JSON.stringify(blind.levels.takeProfits) === JSON.stringify(blindSignal.takeProfitZones),
);
check("blind: still answers Simple mode honestly", modeComplete(blind.simple));
check("blind: surfaces missing context", blind.missingContext.length > 0);

const blindCopy = [
  blind.headline, blind.bestAction, blind.disclaimer,
  blind.noTrade.reason ?? "",
  ...modeStrings(blind.simple), ...modeStrings(blind.advanced),
  ...blind.missingContext,
];
for (const token of FORBIDDEN_TOKENS) {
  check(`blind: copy never leaks "${token}"`, !blindCopy.some((s) => s.includes(token)));
}
check(
  "blind: copy never leaks any UPPER_SNAKE enum token",
  !blindCopy.some((s) => UPPER_SNAKE.test(s)),
);

// ----- explainMarketRead determinism --------------------------------------
const e1 = explainMarketRead(buildRubyMarketEdge(baseInput({})));
const e2 = explainMarketRead(buildRubyMarketEdge(baseInput({})));
check("deterministic: same signal → same headline", e1.headline === e2.headline);
check("deterministic: same signal → same bestAction", e1.bestAction === e2.bestAction);

// ----- categorizeOpportunities --------------------------------------------
function row(overrides: Partial<OpportunityInput>): OpportunityInput {
  return {
    symbol: "EURUSD",
    displayName: "EUR/USD",
    direction: "BUY",
    recommendedAction: "BUY",
    setupType: "TREND_CONTINUATION",
    edgeScore: 70,
    entryQuality: 65,
    executionQuality: 80,
    newsRisk: "none",
    hasLiveData: true,
    isLate: false,
    reason: null,
    ...overrides,
  };
}

const readyNow = categorizeOpportunities([row({})]);
check("cat: a clean live setup is READY_NOW", readyNow.categories.READY_NOW.length === 1);
check("cat: liveCount counts live rows", readyNow.liveCount === 1);
check("cat: scannedCount counts all rows", readyNow.scannedCount === 1);

// An awaiting-data row can NEVER be READY_NOW.
const awaiting = categorizeOpportunities([row({ symbol: "GBPUSD", hasLiveData: false })]);
check("cat: awaiting-data row is never READY_NOW", awaiting.categories.READY_NOW.length === 0);
check("cat: awaiting-data row collapses to NO_CLEAN_SETUP", awaiting.categories.NO_CLEAN_SETUP.length === 1);
check("cat: awaiting-data row excluded from liveCount", awaiting.liveCount === 0);

// Late + news routing.
const late = categorizeOpportunities([row({ symbol: "USDJPY", isLate: true })]);
check("cat: late row is TOO_LATE", late.categories.TOO_LATE.length === 1);
const news = categorizeOpportunities([row({ symbol: "XAUUSD", newsRisk: "critical" })]);
check("cat: critical-news row is WATCH_AFTER_NEWS", news.categories.WATCH_AFTER_NEWS.length === 1);

// Determinism.
const c1 = categorizeOpportunities([row({}), row({ symbol: "GBPUSD", edgeScore: 60 })]);
const c2 = categorizeOpportunities([row({}), row({ symbol: "GBPUSD", edgeScore: 60 })]);
check("cat: deterministic ordering", JSON.stringify(c1.rows.map((r) => r.symbol)) === JSON.stringify(c2.rows.map((r) => r.symbol)));

// Row copy never leaks enum tokens.
check(
  "cat: row bestAction never leaks UPPER_SNAKE enum token",
  !readyNow.rows.some((r) => UPPER_SNAKE.test(r.bestAction) || UPPER_SNAKE.test(r.stageLabel)),
);

// ----- compareBestVsSelected ----------------------------------------------
const mixed = categorizeOpportunities([
  row({ symbol: "EURUSD", edgeScore: 50, entryQuality: 50 }),
  row({ symbol: "GBPUSD", edgeScore: 85, entryQuality: 80 }),
]);
const cleaner = compareBestVsSelected(mixed, "EURUSD");
check("bvs: surfaces a clearly cleaner alternative", cleaner.hasCleanerAlternative === true);
check("bvs: cleaner alternative is the higher-edge symbol", cleaner.best?.symbol === "GBPUSD");
check("bvs: message is human copy without enum tokens", !!cleaner.message && !UPPER_SNAKE.test(cleaner.message));

// When the selected IS the best, no cleaner alternative is claimed.
const selectedIsBest = compareBestVsSelected(mixed, "GBPUSD");
check("bvs: selected-is-best claims no cleaner alternative", selectedIsBest.hasCleanerAlternative === false);

// Display-honesty cap: a no-live-data selected symbol's edge is simulator-derived
// and must NEVER be surfaced on the Opportunity Map — not as selectedEdge, and not
// in the "vs <edge>" banner copy. (TSLA-style: a non-live symbol carries a
// simulator edge that must stay hidden.)
const noLiveSelected = categorizeOpportunities([
  row({ symbol: "TSLA", displayName: "TSLA", hasLiveData: false, edgeScore: 78 }),
  row({ symbol: "GBPUSD", displayName: "GBP/USD", edgeScore: 85, entryQuality: 80 }),
]);
const bvsNoLive = compareBestVsSelected(noLiveSelected, "TSLA");
check("bvs: no-live selected symbol exposes null selectedEdge", bvsNoLive.selectedEdge === null);
check(
  "bvs: no-live selected symbol's simulator edge never leaks into the banner",
  !bvsNoLive.message || !bvsNoLive.message.includes("78"),
);
check(
  "bvs: still surfaces the live cleaner alternative without a 'vs' comparison",
  bvsNoLive.hasCleanerAlternative === true &&
    !!bvsNoLive.message &&
    !bvsNoLive.message.includes(" vs "),
);

if (failures > 0) {
  console.error(`\nScanner & Explanation UX test: ${failures} FAILED`);
  process.exit(1);
}
console.log("\nScanner & Explanation UX test: all checks passed");

export {};
