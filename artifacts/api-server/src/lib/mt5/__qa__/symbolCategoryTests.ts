// ═══════════════════════════════════════════════════════════════════════════
// Focused QA for the read-time symbol categorizer + spread derivation used by
// GET /api/me/mt5/symbols (SymbolPicker grouping). Pure functions, no DB.
//
// Run: pnpm --filter @workspace/api-server run qa:symbol-category
//
// Covers the architect-flagged edges:
//   - a real cash index literally named "... Index" must stay Indices, not
//     get swallowed by the Deriv-synthetic "Index" heuristic
//   - named energies (oil/gas/brent) are Commodities, not Indices
//   - Deriv synthetics (Volatility/Boom/Crash/Step/Range Break/…) are Synthetics
//   - forex majors vs minors boundary; crypto crosses; baskets; metals
//   - spread = round((ask-bid)/point), null-guarded
// ═══════════════════════════════════════════════════════════════════════════
import {
  deriveSymbolCategory,
  deriveSpreadPoints,
  type SymbolCategory,
} from "../symbolDirectory.js";

let passed = 0;
let failed = 0;

function expectCategory(
  symbol: string,
  expected: SymbolCategory,
  opts?: { display?: string; mc?: string; pc?: string },
) {
  const got = deriveSymbolCategory(symbol, opts?.display ?? null, opts?.mc ?? null, opts?.pc ?? null);
  if (got === expected) {
    passed++;
  } else {
    failed++;
    process.stdout.write(`  [FAIL] "${symbol}" expected ${expected}, got ${got}\n`);
  }
}

function expectSpread(
  bid: number | null,
  ask: number | null,
  point: number | null,
  expected: number | null,
) {
  const got = deriveSpreadPoints(bid, ask, point);
  if (got === expected) {
    passed++;
  } else {
    failed++;
    process.stdout.write(`  [FAIL] spread(${bid},${ask},${point}) expected ${expected}, got ${got}\n`);
  }
}

// ── Forex ──────────────────────────────────────────────────────────────────
expectCategory("EURUSD", "Forex Majors");
expectCategory("GBPUSD", "Forex Majors");
expectCategory("USDJPY", "Forex Majors");
expectCategory("EURGBP", "Forex Minors"); // major legs but no USD
expectCategory("AUDCHF", "Forex Minors");
expectCategory("EURTRY", "Forex Minors"); // exotic fiat

// ── Metals ───────────────────────────────────────────────────────────────--
expectCategory("XAUUSD", "Metals");
expectCategory("XAGUSD", "Metals");
expectCategory("XPDUSD", "Metals");

// ── Crypto (incl. non-USD crosses) ──────────────────────────────────────────
expectCategory("BTCUSD", "Crypto");
expectCategory("ETHUSD", "Crypto");
expectCategory("BTCETH", "Crypto"); // cross — neither leg is USD
expectCategory("LNKUSD", "Crypto");

// ── Commodities / energies (must NOT become Indices) ─────────────────────────
expectCategory("UK Brent Oil", "Commodities");
expectCategory("US Crude Oil", "Commodities");
expectCategory("NGAS", "Commodities");
expectCategory("XCUUSD", "Commodities");
expectCategory("COFFEE", "Commodities");

// ── Deriv synthetics ────────────────────────────────────────────────────────
expectCategory("Volatility 75 Index", "Synthetics");
expectCategory("Boom 1000 Index", "Synthetics");
expectCategory("Crash 500 Index", "Synthetics");
expectCategory("Step Index", "Synthetics");
expectCategory("Range Break 100 Index", "Synthetics");
expectCategory("Jump 25 Index", "Synthetics");

// ── Baskets ──────────────────────────────────────────────────────────────---
expectCategory("AUD Basket", "Baskets");
expectCategory("Gold Basket", "Baskets");

// ── Stock indices — country+number, incl. the architect's "... Index" edge ───
expectCategory("US 30", "Indices");
expectCategory("Germany 40", "Indices");
expectCategory("US 500 Index", "Indices"); // EDGE: real cash index named "Index"
expectCategory("Wall Street 30", "Indices");

// ── Equities ─────────────────────────────────────────────────────────────---
expectCategory("AAPL.OQ", "Stocks");
expectCategory("ADS", "Stocks", { mc: "EUR", pc: "EUR" });

// ── Spread derivation ────────────────────────────────────────────────────---
expectSpread(1.1, 1.10011, 0.00001, 11);
expectSpread(2000, 2000.16, 0.01, 16);
expectSpread(null, 1.1, 0.0001, null);
expectSpread(1.1, 1.2, 0, null); // point<=0 guarded
expectSpread(1.2, 1.1, 0.0001, null); // negative spread guarded

process.stdout.write(`\nsymbol-category QA: ${passed} passed, ${failed} failed\n`);
if (failed > 0) process.exit(1);
