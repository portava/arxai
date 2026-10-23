// Test: realized P/L is contract-size aware (P0-2).
//
// Realized P/L was `(close − entry) × direction × lots` with NO contract size,
// so a 1.00-lot 100-pip EURUSD winner booked $0.01 instead of $1,000 — wrong by
// 100,000×. That number feeds `virtual_trading_accounts.virtualPnl`, which
// feeds investor USD equity AND the allocation-blown risk cap
// (`virtualPnl <= -virtualBalance`). Understated 100,000×, the cap could never
// trip for FX: a trader could blow the entire allocation with the CLOSE-ONLY
// brake never engaging.
//
// This test locks:
//   1. the strict ISO-4217 classifier (a loose /^[A-Z]{6}$/ mis-sizes gold,
//      silver, crypto and JPY crosses);
//   2. contract-size resolution order (broker truth > FX standard lot > refuse);
//   3. the sizing math for EURUSD, XAUUSD and a FX-converted USDJPY;
//   4. the allocation-blown cap tripping on a realized loss >= allocation —
//      including the explicit regression case showing the OLD unsized math
//      would NOT have tripped it;
//   5. that a missing contract size withholds the figure instead of inventing
//      a plausible dollar amount.
//
// Pure unit test — no DB, no network, safe to wire into CI.

import {
  decideContractSize,
  isForexPair,
  splitForexPair,
  resolveQuoteToAccountFx,
  computeRealizedAmount,
  FX_STANDARD_LOT_UNITS,
} from "../../artifacts/api-server/src/lib/mt5/contractSize.js";
import { isAllocationBlown } from "../../artifacts/api-server/src/lib/live/allocationBlown.js";
import { computeRealizedPnlUsd } from "../../artifacts/api-server/src/lib/live/realizedPnl.js";
import { isEntrypoint, type CiTestResultLike } from "./ci/inProcessAppHarness.js";

export async function run(): Promise<CiTestResultLike> {
let failures = 0;
let passes = 0;

function assert(cond: boolean, label: string) {
  if (cond) { passes++; console.log(`  ✓ ${label}`); }
  else { failures++; console.error(`  ✗ ${label}`); }
}
function near(a: number | null, b: number, tol = 0.01): boolean {
  return a != null && Math.abs(a - b) <= tol;
}

console.log("realizedPnlContractSizeTest");
console.log("===========================\n");

// ── 1. Strict ISO-4217 classifier ──────────────────────────────────────────
console.log("Strict ISO-4217 classifier (a loose /^[A-Z]{6}$/ mis-sizes these)");
assert(isForexPair("EURUSD") === true, "EURUSD is forex");
assert(isForexPair("USDJPY") === true, "USDJPY is forex");
assert(isForexPair("EURUSD.raw") === true, "EURUSD.raw (broker suffix) is forex");
assert(isForexPair("XAUUSD") === false, "XAUUSD (gold) is NOT forex — 6 letters, but XAU is not fiat");
assert(isForexPair("XAGUSD") === false, "XAGUSD (silver) is NOT forex");
assert(isForexPair("BTCUSD") === false, "BTCUSD (crypto) is NOT forex");
assert(isForexPair("US30") === false, "US30 (index) is NOT forex");
assert(splitForexPair("USDJPY")?.base === "USD", "USDJPY base is USD");
assert(splitForexPair("USDJPY")?.quote === "JPY", "USDJPY quote is JPY");

// ── 2. Contract-size resolution order ──────────────────────────────────────
console.log("\nContract-size resolution: broker truth > FX standard lot > refuse");
{
  const r = decideContractSize({ symbol: "EURUSD", brokerContractSize: null, brokerProfitCurrency: null });
  assert(r.contractSize === FX_STANDARD_LOT_UNITS, "EURUSD with no broker row → 100,000 FX standard lot");
  assert(r.source === "FX_STANDARD_LOT", "…flagged as FX_STANDARD_LOT, not broker truth");
}
{
  const r = decideContractSize({ symbol: "EURUSD", brokerContractSize: 100_000, brokerProfitCurrency: "USD" });
  assert(r.source === "BROKER_SPEC", "broker truth wins over the FX default when present");
}
{
  const r = decideContractSize({ symbol: "XAUUSD", brokerContractSize: 100, brokerProfitCurrency: "USD" });
  assert(r.contractSize === 100, "XAUUSD takes contractSize=100 from arx_symbol_specs");
  assert(r.source === "BROKER_SPEC", "…as broker truth");
}
{
  const r = decideContractSize({ symbol: "XAUUSD", brokerContractSize: null, brokerProfitCurrency: null });
  assert(r.contractSize === null, "XAUUSD with NO broker row refuses to size (never 100,000)");
  assert(r.reason === "NO_BROKER_SPEC_AND_NOT_FOREX", "…with an explicit reason");
}
{
  const r = decideContractSize({ symbol: "BTCUSD", brokerContractSize: null, brokerProfitCurrency: null });
  assert(r.contractSize === null, "BTCUSD with no broker row refuses to size");
}
{
  const r = decideContractSize({ symbol: "EURUSD", brokerContractSize: 0, brokerProfitCurrency: "USD" });
  assert(r.contractSize === null && r.reason === "BROKER_SPEC_INVALID", "a zero broker contractSize is rejected, not used");
}

// ── 3. Sizing math ─────────────────────────────────────────────────────────
console.log("\nSizing math");
{
  // EURUSD, 1.00 lot, +100 pips (1.10000 → 1.10000+0.01000). Account USD.
  const fx = resolveQuoteToAccountFx({
    symbol: "EURUSD", profitCurrency: "USD", accountCurrency: "USD", closePrice: 1.11,
  });
  assert(fx.factor === 1 && fx.source === "SAME_CURRENCY", "EURUSD/USD account → fx factor 1");
  const pnl = computeRealizedAmount({
    entryPrice: 1.10, closePrice: 1.11, direction: 1, lots: 1.0,
    contractSize: FX_STANDARD_LOT_UNITS, quoteToAccountFx: fx.factor!,
  });
  assert(near(pnl, 1000), `EURUSD 1.00 lot +100 pips → +$1000 (got ${pnl})`);
  // The pre-fix math for the exact same trade:
  const preFix = (1.11 - 1.10) * 1 * 1.0;
  assert(near(preFix, 0.01, 1e-9), `…the pre-fix unsized math booked $${preFix.toFixed(2)} for the same trade`);
}
{
  // XAUUSD (gold), 1.00 lot, +$10.00 move, contractSize 100. Account USD.
  const fx = resolveQuoteToAccountFx({
    symbol: "XAUUSD", profitCurrency: "USD", accountCurrency: "USD", closePrice: 2410,
  });
  assert(fx.factor === 1, "XAUUSD profit currency USD on a USD account → factor 1");
  const pnl = computeRealizedAmount({
    entryPrice: 2400, closePrice: 2410, direction: 1, lots: 1.0,
    contractSize: 100, quoteToAccountFx: fx.factor!,
  });
  assert(near(pnl, 1000), `XAUUSD 1.00 lot +$10 with contractSize 100 → +$1000 (got ${pnl})`);
  // Proof the strict classifier matters: the FX lot would be 1000x too big.
  const wrong = computeRealizedAmount({
    entryPrice: 2400, closePrice: 2410, direction: 1, lots: 1.0,
    contractSize: FX_STANDARD_LOT_UNITS, quoteToAccountFx: 1,
  });
  assert(near(wrong, 1_000_000), `…a loose /^[A-Z]{6}$/ would have booked $${wrong} for that gold trade`);
}
{
  // USDJPY, 1.00 lot, 150.00 → 151.50 (+150 pips). P/L is in JPY; account USD.
  const fx = resolveQuoteToAccountFx({
    symbol: "USDJPY", profitCurrency: "JPY", accountCurrency: "USD", closePrice: 151.50,
  });
  assert(fx.source === "INVERSE_QUOTE", "USDJPY on a USD account converts via 1/price");
  assert(near(fx.factor, 1 / 151.5, 1e-9), "…factor is 1/151.50");
  const pnl = computeRealizedAmount({
    entryPrice: 150.00, closePrice: 151.50, direction: 1, lots: 1.0,
    contractSize: FX_STANDARD_LOT_UNITS, quoteToAccountFx: fx.factor!,
  });
  // 1.50 JPY x 100,000 = 150,000 JPY; / 151.50 = $990.10
  assert(near(pnl, 990.10, 0.05), `USDJPY 1.00 lot +150 pips → ~$990.10 (got ${pnl})`);
  assert(pnl < 150_000, "…the JPY figure is converted, never booked as USD");
}
{
  const fx = resolveQuoteToAccountFx({
    symbol: "EURGBP", profitCurrency: "GBP", accountCurrency: "USD", closePrice: 0.85,
  });
  assert(fx.factor === null && fx.reason === "NO_CROSS_RATE_AVAILABLE",
    "EURGBP on a USD account has no derivable cross rate → refuses, never guesses");
}

// ── 4. The allocation-blown cap actually trips ─────────────────────────────
console.log("\nAllocation-blown cap");
{
  // A $1,000 allocation and a EURUSD trade that lost 100 pips on 1.00 lot.
  const correctlySized = computeRealizedAmount({
    entryPrice: 1.11, closePrice: 1.10, direction: 1, lots: 1.0,
    contractSize: FX_STANDARD_LOT_UNITS, quoteToAccountFx: 1,
  });
  assert(near(correctlySized, -1000), `the losing trade books -$1000 (got ${correctlySized})`);
  assert(isAllocationBlown({ virtualBalance: 1000, virtualPnl: correctlySized }) === true,
    "cap TRIPS: realized loss >= allocation → CLOSE-ONLY");

  const preFixSized = (1.10 - 1.11) * 1 * 1.0; // -0.01
  assert(isAllocationBlown({ virtualBalance: 1000, virtualPnl: preFixSized }) === false,
    `REGRESSION PROOF: the pre-fix unsized loss ($${preFixSized.toFixed(2)}) does NOT trip the cap`);

  assert(isAllocationBlown({ virtualBalance: 1000, virtualPnl: -999.99 }) === false,
    "cap does not trip just below the allocation");
  assert(isAllocationBlown({ virtualBalance: 1000, virtualPnl: -1000 }) === true,
    "cap trips exactly at the allocation");
  assert(isAllocationBlown({ virtualBalance: 0, virtualPnl: -5 }) === false,
    "an unset (zero) allocation does not trip the cap");
}

// ── 5. Missing sizing withholds the figure ─────────────────────────────────
console.log("\nMissing contract size withholds the figure (never a plausible wrong number)");
{
  const r = computeRealizedPnlUsd({
    side: "BUY", requestedVolume: 1.0,
    openFillPrice: 2400, closeFillPrice: 2410,
    contractSize: null, quoteToAccountFx: 1,
  });
  assert(r.realizedPlUsd === null, "no contract size → realizedPlUsd is null");
  assert(r.pnlStatus === "UNKNOWN", "…pnlStatus UNKNOWN");
  assert(r.dataQualityFlag === "MISSING_CONTRACT_SIZE", "…with MISSING_CONTRACT_SIZE");
}
{
  const r = computeRealizedPnlUsd({
    side: "BUY", requestedVolume: 1.0,
    openFillPrice: 150.0, closeFillPrice: 151.5,
    contractSize: FX_STANDARD_LOT_UNITS, quoteToAccountFx: null,
  });
  assert(r.pnlStatus === "UNKNOWN" && r.realizedPlUsd === null
    && r.dataQualityFlag === "MISSING_FX_CONVERSION",
    "no FX conversion → UNKNOWN, withheld with MISSING_FX_CONVERSION");
}
{
  const r = computeRealizedPnlUsd({
    side: "BUY", requestedVolume: 1.0,
    openFillPrice: 1.10, closeFillPrice: 1.11,
    contractSize: FX_STANDARD_LOT_UNITS, quoteToAccountFx: 1,
  });
  assert(r.pnlStatus === "COMPUTED" && near(r.realizedPlUsd, 1000),
    `fully-sized EURUSD close → COMPUTED +$1000 (got ${r.realizedPlUsd})`);
}

console.log(`\nResult: ${passes} passed, ${failures} failed`);
  return { name: "realizedPnlContractSizeTest", passes, failures };
}

if (isEntrypoint(import.meta.url)) {
  run().then(
    (r) => process.exit(r.failures > 0 ? 1 : 0),
    (err) => {
      console.error("[realizedPnlContractSizeTest] FAILED:", err);
      process.exit(1);
    },
  );
}
