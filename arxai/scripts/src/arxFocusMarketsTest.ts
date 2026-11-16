// ── ARX Focus Market Registry — deterministic resolver tests (Task #558) ─────
//
// Pure unit tests for the single-source-of-truth Focus registry. No DB, no
// server, no IO. Covers spec STEP 8 items 1–3:
//   1. resolveArxMarket resolves all 36 by canonicalSymbol AND every
//      alias/mt5Alias; the (1s) variants resolve DISTINCTLY from standards.
//   2. isApprovedArxMarket is false for representative unapproved symbols,
//      true for all 36.
//   3. The registry has exactly 43 markets, in the canonical default order,
//      with the correct tier-1 set, and no normalized-alias collisions.

import {
  ARX_FOCUS_MARKETS,
  getAllApprovedArxMarkets,
  getApprovedMarketsByCategory,
  getTierOneMarkets,
  isApprovedArxMarket,
  normalizeArxSymbol,
  resolveArxMarket,
  assertApprovedArxMarket,
  UnapprovedArxMarketError,
  type ArxMarketCategory,
} from "../../lib/domain/src/market/arxFocusMarkets.js";

type CaseResult = { name: string; ok: boolean; detail?: string };
const results: CaseResult[] = [];
function record(name: string, ok: boolean, detail?: string) {
  results.push({ name, ok, detail });
  // eslint-disable-next-line no-console
  console.log(`  ${ok ? "PASS" : "FAIL"}  ${name}${detail ? ` — ${detail}` : ""}`);
}

// ── 1. Exactly 43, default order, expected canonical set ─────────────────────
console.log("\nPART 1 — registry shape");

const EXPECTED_ORDER = [
  "V75", "V75_1S", "V100", "V50", "V50_1S", "V25_1S", "V10",
  "BOOM1000", "CRASH1000", "BOOM500", "CRASH500",
  "JUMP10", "JUMP25", "JUMP50", "JUMP75", "JUMP100", "BOOM300", "CRASH300",
  "EURUSD", "GBPUSD", "USDJPY", "USDCHF", "USDCAD", "AUDUSD", "NZDUSD",
  "EURJPY", "EURGBP", "EURAUD", "EURCAD", "GBPJPY", "GBPAUD", "GBPCAD",
  "AUDJPY", "CADJPY", "CHFJPY",
  "XAUUSD", "XAGUSD", "DXY", "SPX500", "GER30", "US30", "BTCUSD", "ETHUSD",
];

record("registry has exactly 43 markets", ARX_FOCUS_MARKETS.length === 43, `count=${ARX_FOCUS_MARKETS.length}`);

const actualOrder = ARX_FOCUS_MARKETS.map((m) => m.canonicalSymbol);
record(
  "canonical symbols match the default order exactly",
  JSON.stringify(actualOrder) === JSON.stringify(EXPECTED_ORDER),
  actualOrder.join(","),
);
record(
  "getAllApprovedArxMarkets returns the same default order",
  JSON.stringify(getAllApprovedArxMarkets().map((m) => m.canonicalSymbol)) ===
    JSON.stringify(EXPECTED_ORDER),
);

// canonicalSymbol uniqueness
const canonSet = new Set(actualOrder);
record("canonical symbols are unique", canonSet.size === 43, `unique=${canonSet.size}`);

// ── 2. Tier-1 set ───────────────────────────────────────────────────────────
console.log("\nPART 2 — tier-1 set");
const EXPECTED_TIER1 = [
  "V75", "V75_1S", "V100", "V50", "BOOM1000", "CRASH1000",
  "JUMP10", "JUMP25", "JUMP50", "JUMP75", "JUMP100", "BOOM300", "CRASH300",
  "EURUSD", "GBPUSD", "XAUUSD", "XAGUSD", "DXY", "SPX500", "GER30", "US30",
  "BTCUSD", "ETHUSD",
];
const actualTier1 = getTierOneMarkets().map((m) => m.canonicalSymbol);
record(
  "tier-1 markets match spec (23 markets)",
  JSON.stringify(actualTier1) === JSON.stringify(EXPECTED_TIER1),
  actualTier1.join(","),
);

// ── 3. Category counts ──────────────────────────────────────────────────────
console.log("\nPART 3 — category buckets");
const catCounts: Record<ArxMarketCategory, number> = {
  synthetic: 18, forex_major: 7, forex_minor: 10, metal: 2, index: 4, crypto: 2,
};
let catTotal = 0;
for (const [cat, expected] of Object.entries(catCounts) as [ArxMarketCategory, number][]) {
  const got = getApprovedMarketsByCategory(cat).length;
  catTotal += got;
  record(`category ${cat} has ${expected}`, got === expected, `got=${got}`);
}
record("category buckets sum to 43", catTotal === 43, `sum=${catTotal}`);

// ── 4. resolveArxMarket: every canonical + alias + mt5Alias resolves to self ─
console.log("\nPART 4 — every canonical/alias/mt5Alias resolves to its own market");
let aliasFailures = 0;
for (const market of ARX_FOCUS_MARKETS) {
  const inputs = [market.canonicalSymbol, ...market.aliases, ...market.mt5Aliases];
  for (const input of inputs) {
    const resolved = resolveArxMarket(input);
    if (!resolved || resolved.canonicalSymbol !== market.canonicalSymbol) {
      aliasFailures++;
      record(`resolve "${input}" → ${market.canonicalSymbol}`, false, `got=${resolved?.canonicalSymbol ?? "null"}`);
    }
  }
}
record("all canonical/alias/mt5Alias inputs resolve to their own market", aliasFailures === 0, `failures=${aliasFailures}`);

// case-insensitivity spot checks
record('case-insensitive: "eurusd" === "EURUSD"', resolveArxMarket("eurusd")?.canonicalSymbol === "EURUSD");
record('case-insensitive: "GoLd" → XAUUSD', resolveArxMarket("GoLd")?.canonicalSymbol === "XAUUSD");
record('exchange-prefix strip: "FX:EURUSD" → EURUSD', resolveArxMarket("FX:EURUSD")?.canonicalSymbol === "EURUSD");

// ── 5. (1s) variants resolve DISTINCTLY from their standard counterparts ─────
console.log("\nPART 5 — 1s variants are distinct symbols");
const distinctPairs: Array<[string, string, string, string]> = [
  ["Volatility 75 Index", "V75", "Volatility 75 (1s) Index", "V75_1S"],
  ["Volatility 50 Index", "V50", "Volatility 50 (1s) Index", "V50_1S"],
];
for (const [stdIn, stdSym, oneSecIn, oneSecSym] of distinctPairs) {
  record(`"${stdIn}" → ${stdSym}`, resolveArxMarket(stdIn)?.canonicalSymbol === stdSym, resolveArxMarket(stdIn)?.canonicalSymbol);
  record(`"${oneSecIn}" → ${oneSecSym}`, resolveArxMarket(oneSecIn)?.canonicalSymbol === oneSecSym, resolveArxMarket(oneSecIn)?.canonicalSymbol);
}
// V25 standard is NOT in the focus list (only the 1s variant is) → unapproved
record('"Volatility 25 Index" (standard) is NOT approved', !isApprovedArxMarket("Volatility 25 Index"));
record('"Volatility 25 (1s) Index" IS approved', resolveArxMarket("Volatility 25 (1s) Index")?.canonicalSymbol === "V25_1S");
// distinct deriv ids carried in mt5Aliases
record("V75 carries R_75; V75_1S carries 1HZ75V (no overlap)", resolveArxMarket("R_75")?.canonicalSymbol === "V75" && resolveArxMarket("1HZ75V")?.canonicalSymbol === "V75_1S");

// ── 6. isApprovedArxMarket false for representative unapproved symbols ───────
console.log("\nPART 6 — unapproved symbols are rejected");
const UNAPPROVED = [
  "USDTRY", "USDZAR", "EURTRY", // forex exotics
  "NAS100", "US100", "UK100", "Netherlands 25", // unlisted indices
  "AAPL.OQ", "TSLA", "AMZN.OQ", // single-name stocks
  "Step Index", "Volatility 30 (1s) Index", "Range Break 100 Index", // unlisted synthetics
  "ADAUSD", "SOLUSD", "BNBUSD", // unlisted crypto
  "", "   ", "???", "NOTAREALSYMBOL",
];
let falsePositives = 0;
for (const u of UNAPPROVED) {
  if (isApprovedArxMarket(u)) {
    falsePositives++;
    record(`unapproved "${u}" correctly rejected`, false, "WRONGLY APPROVED");
  }
}
record("all representative unapproved symbols rejected", falsePositives === 0, `falsePositives=${falsePositives}`);
record("all 43 approved markets pass isApprovedArxMarket", ARX_FOCUS_MARKETS.every((m) => isApprovedArxMarket(m.canonicalSymbol)));

// ── 7. normalizeArxSymbol + assertApprovedArxMarket ─────────────────────────
console.log("\nPART 7 — normalize + assert helpers");
record('normalizeArxSymbol("gold") === "XAUUSD"', normalizeArxSymbol("gold") === "XAUUSD");
record('normalizeArxSymbol("USDTRY") === null', normalizeArxSymbol("USDTRY") === null);
record("assertApprovedArxMarket returns market for approved", assertApprovedArxMarket("EURUSD").canonicalSymbol === "EURUSD");
let threw = false;
let typedError = false;
try {
  assertApprovedArxMarket("USDTRY");
} catch (e) {
  threw = true;
  typedError = e instanceof UnapprovedArxMarketError && (e as UnapprovedArxMarketError).code === "SYMBOL_NOT_IN_ARX_FOCUS";
}
record("assertApprovedArxMarket throws UnapprovedArxMarketError for unapproved", threw && typedError);

// ── Summary ──────────────────────────────────────────────────────────────────
const passCount = results.filter((r) => r.ok).length;
const failCount = results.length - passCount;
// eslint-disable-next-line no-console
console.log(`\n${passCount}/${results.length} pass · ${failCount} fail`);
if (failCount > 0) process.exit(1);
