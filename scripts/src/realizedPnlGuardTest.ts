// Test: realised P/L guard for live test cycle close handler.
//
// Drives the close-fill-price validator + computeRealizedPnlUsd across
// the three meaningful fixtures (missing fillPrice, fillPrice=0, valid
// fillPrice) and asserts:
//   - missing / zero / NaN / negative / infinity → pnlStatus="UNKNOWN",
//     realizedPlUsd=null, dataQualityFlag="MISSING_CLOSE_FILL_PRICE"
//   - valid finite > 0 fillPrice → pnlStatus="COMPUTED" with the
//     unchanged EURUSD math
//   - isRealizedPnlIngestible() returns true ONLY for COMPUTED rows
//
// Pure unit test — no DB, no network, so it is safe to wire into CI.

import {
  computeRealizedPnlUsd,
  isRealizedPnlIngestible,
  isValidFillPrice,
  PNL_DATA_QUALITY_MISSING_CLOSE_FILL,
} from "../../artifacts/api-server/src/lib/live/realizedPnl.js";
import { FX_STANDARD_LOT_UNITS } from "../../artifacts/api-server/src/lib/mt5/contractSize.js";
import { isEntrypoint, type CiTestResultLike } from "./ci/inProcessAppHarness.js";

export async function run(): Promise<CiTestResultLike> {
let failures = 0;
let passes = 0;

function assert(cond: boolean, label: string) {
  if (cond) { passes++; console.log(`  ✓ ${label}`); }
  else { failures++; console.error(`  ✗ ${label}`); }
}

console.log("realizedPnlGuardTest");
console.log("====================\n");

console.log("isValidFillPrice — accepts only finite > 0 numbers");
assert(isValidFillPrice(1.05123) === true, "1.05123 → valid");
assert(isValidFillPrice(0.00001) === true, "0.00001 → valid");
assert(isValidFillPrice(0) === false, "0 → invalid");
assert(isValidFillPrice(-1) === false, "-1 → invalid");
assert(isValidFillPrice(NaN) === false, "NaN → invalid");
assert(isValidFillPrice(Infinity) === false, "Infinity → invalid");
assert(isValidFillPrice(-Infinity) === false, "-Infinity → invalid");
assert(isValidFillPrice(null) === false, "null → invalid");
assert(isValidFillPrice(undefined) === false, "undefined → invalid");
assert(isValidFillPrice("1.05") === false, "string '1.05' → invalid");

console.log("\nFixture 1 — close fillPrice missing (undefined)");
{
  const r = computeRealizedPnlUsd({
    side: "BUY", requestedVolume: 0.01,
    openFillPrice: 1.05000, closeFillPrice: undefined,
    // EURUSD standard lot on a USD account: 100,000 units, quote ccy == account ccy.
    contractSize: FX_STANDARD_LOT_UNITS, quoteToAccountFx: 1,
  });
  assert(r.pnlStatus === "UNKNOWN", `pnlStatus is UNKNOWN (got ${r.pnlStatus})`);
  assert(r.realizedPlUsd === null, "realizedPlUsd is null");
  assert(r.dataQualityFlag === PNL_DATA_QUALITY_MISSING_CLOSE_FILL, "dataQualityFlag = MISSING_CLOSE_FILL_PRICE");
  assert(isRealizedPnlIngestible({ pnlStatus: r.pnlStatus, realizedPlUsd: r.realizedPlUsd }) === false,
    "row is NOT ingestible by downstream ledger");
}

console.log("\nFixture 2 — close fillPrice = 0");
{
  const r = computeRealizedPnlUsd({
    side: "SELL", requestedVolume: 0.01,
    openFillPrice: 1.05000, closeFillPrice: 0,
    // EURUSD standard lot on a USD account: 100,000 units, quote ccy == account ccy.
    contractSize: FX_STANDARD_LOT_UNITS, quoteToAccountFx: 1,
  });
  assert(r.pnlStatus === "UNKNOWN", `pnlStatus is UNKNOWN (got ${r.pnlStatus})`);
  assert(r.realizedPlUsd === null, "realizedPlUsd is null");
  assert(r.dataQualityFlag === PNL_DATA_QUALITY_MISSING_CLOSE_FILL, "dataQualityFlag = MISSING_CLOSE_FILL_PRICE");
  assert(isRealizedPnlIngestible({ pnlStatus: r.pnlStatus, realizedPlUsd: r.realizedPlUsd }) === false,
    "row is NOT ingestible by downstream ledger");
}

console.log("\nFixture 2b — close fillPrice = NaN");
{
  const r = computeRealizedPnlUsd({
    side: "BUY", requestedVolume: 0.01,
    openFillPrice: 1.05000, closeFillPrice: NaN,
    // EURUSD standard lot on a USD account: 100,000 units, quote ccy == account ccy.
    contractSize: FX_STANDARD_LOT_UNITS, quoteToAccountFx: 1,
  });
  assert(r.pnlStatus === "UNKNOWN", `pnlStatus is UNKNOWN (got ${r.pnlStatus})`);
  assert(r.realizedPlUsd === null, "realizedPlUsd is null");
  assert(r.dataQualityFlag === PNL_DATA_QUALITY_MISSING_CLOSE_FILL, "dataQualityFlag = MISSING_CLOSE_FILL_PRICE");
}

console.log("\nFixture 2c — close fillPrice = null");
{
  const r = computeRealizedPnlUsd({
    side: "BUY", requestedVolume: 0.01,
    openFillPrice: 1.05000, closeFillPrice: null,
    // EURUSD standard lot on a USD account: 100,000 units, quote ccy == account ccy.
    contractSize: FX_STANDARD_LOT_UNITS, quoteToAccountFx: 1,
  });
  assert(r.pnlStatus === "UNKNOWN", "pnlStatus is UNKNOWN");
  assert(r.realizedPlUsd === null, "realizedPlUsd is null");
  assert(r.dataQualityFlag === PNL_DATA_QUALITY_MISSING_CLOSE_FILL, "dataQualityFlag = MISSING_CLOSE_FILL_PRICE");
}

console.log("\nFixture 3 — valid fillPrice, BUY profit");
{
  // EURUSD: 0.01 lot * 100_000 * (1.05100 - 1.05000) = 1.00 USD
  const r = computeRealizedPnlUsd({
    side: "BUY", requestedVolume: 0.01,
    openFillPrice: 1.05000, closeFillPrice: 1.05100,
    // EURUSD standard lot on a USD account: 100,000 units, quote ccy == account ccy.
    contractSize: FX_STANDARD_LOT_UNITS, quoteToAccountFx: 1,
  });
  assert(r.pnlStatus === "COMPUTED", `pnlStatus is COMPUTED (got ${r.pnlStatus})`);
  assert(r.realizedPlUsd === 1.00, `realizedPlUsd = 1.00 (got ${r.realizedPlUsd})`);
  assert(r.dataQualityFlag === null, "dataQualityFlag = null");
  assert(isRealizedPnlIngestible({ pnlStatus: r.pnlStatus, realizedPlUsd: r.realizedPlUsd }) === true,
    "row IS ingestible by downstream ledger");
}

console.log("\nFixture 3b — valid fillPrice, SELL profit");
{
  // SELL profits when closeFill < openFill. 0.01 * 100_000 * (1.05000 - 1.05100) * -1 = 1.00
  const r = computeRealizedPnlUsd({
    side: "SELL", requestedVolume: 0.01,
    openFillPrice: 1.05100, closeFillPrice: 1.05000,
    // EURUSD standard lot on a USD account: 100,000 units, quote ccy == account ccy.
    contractSize: FX_STANDARD_LOT_UNITS, quoteToAccountFx: 1,
  });
  assert(r.pnlStatus === "COMPUTED", "pnlStatus is COMPUTED");
  assert(r.realizedPlUsd === 1.00, `realizedPlUsd = 1.00 (got ${r.realizedPlUsd})`);
}

console.log("\nFixture 3c — valid fillPrice, BUY loss");
{
  const r = computeRealizedPnlUsd({
    side: "BUY", requestedVolume: 0.01,
    openFillPrice: 1.05100, closeFillPrice: 1.05000,
    // EURUSD standard lot on a USD account: 100,000 units, quote ccy == account ccy.
    contractSize: FX_STANDARD_LOT_UNITS, quoteToAccountFx: 1,
  });
  assert(r.pnlStatus === "COMPUTED", "pnlStatus is COMPUTED");
  assert(r.realizedPlUsd === -1.00, `realizedPlUsd = -1.00 (got ${r.realizedPlUsd})`);
}

console.log("\nFixture 4 — open fillPrice missing");
{
  const r = computeRealizedPnlUsd({
    side: "BUY", requestedVolume: 0.01,
    openFillPrice: null, closeFillPrice: 1.05000,
    // EURUSD standard lot on a USD account: 100,000 units, quote ccy == account ccy.
    contractSize: FX_STANDARD_LOT_UNITS, quoteToAccountFx: 1,
  });
  assert(r.pnlStatus === "UNKNOWN", "pnlStatus is UNKNOWN");
  assert(r.realizedPlUsd === null, "realizedPlUsd is null");
  assert(r.dataQualityFlag === "MISSING_OPEN_FILL_PRICE", "dataQualityFlag = MISSING_OPEN_FILL_PRICE");
}

console.log("\nFixture 5 — proving the previously-buggy 1163.59 scenario stays null");
{
  // The real bad cycle hit a missing/zero close fill price and the old
  // code produced realizedPlUsd = -1163.59. With the guard in place the
  // result MUST be null + UNKNOWN regardless of open fill.
  const r = computeRealizedPnlUsd({
    side: "BUY", requestedVolume: 0.01,
    openFillPrice: 1.16359, closeFillPrice: 0,
    // EURUSD standard lot on a USD account: 100,000 units, quote ccy == account ccy.
    contractSize: FX_STANDARD_LOT_UNITS, quoteToAccountFx: 1,
  });
  assert(r.realizedPlUsd === null, "fake -1163.59-style P/L is suppressed");
  assert(r.pnlStatus === "UNKNOWN", "pnlStatus is UNKNOWN");
}

console.log(`\nResult: ${passes} passed, ${failures} failed`);
  return { name: "realizedPnlGuardTest", passes, failures };
}

if (isEntrypoint(import.meta.url)) {
  run().then(
    (r) => process.exit(r.failures > 0 ? 1 : 0),
    (err) => {
      console.error("[realizedPnlGuardTest] FAILED:", err);
      process.exit(1);
    },
  );
}
