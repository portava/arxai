// Honesty test — Ruby chart trust line must reflect the REAL broker-price
// alignment granularity, never over-claim "Mirror synced".
//
// Contract (docs/scoping/ruby-trustline-broker-alignment.md):
//   tolerance tight/normal (aligned, broker data) → "Mirror synced"
//   tolerance wide                                 → "Mirror drifting"
//   tolerance unknown / no broker quote            → NO alignment claim
//   tolerance failed OR merge-seam failed          → "Mirror degraded"
//
// Hard invariant under test: NO trust line may claim sync when the tolerance is
// one of {wide, unknown, failed}. This locks the success-path builder
// (buildTrustLine) and the shared mirror-copy helper (mirrorTrustSegment) used
// by every read-chart trust line.

import { buildTrustLine } from "../../artifacts/api-server/src/lib/data/chart/rubyChartContext.js";
import type { ChartGateOutput } from "../../artifacts/api-server/src/lib/data/chart/chartGateOutput.js";
import {
  mirrorTrustSegment,
  type BrokerPriceAlignment,
  type AlignmentTolerance,
} from "../../artifacts/api-server/src/lib/data/chart/brokerPriceAlignment.js";

let failures = 0;
function check(name: string, cond: boolean, detail?: string): void {
  if (cond) {
    console.log(`  \u2713 ${name}`);
  } else {
    failures++;
    console.error(`  \u2717 ${name}${detail ? ` \u2014 ${detail}` : ""}`);
  }
}

// A fully-open gate: every chart-based confirmation flag PASSes. Overrides let a
// test drop tradeConfirmationAllowed to model a seam/alignment failure.
function makeGate(over: Partial<ChartGateOutput> = {}): ChartGateOutput {
  return {
    chartTruthScore: 88,
    chartReadScore: 80,
    truthLabel: "Trustworthy",
    readLabel: "Tradeable",
    confidentReadAllowed: true,
    scannerConfirmAllowed: true,
    selfTradeChartAllowed: true,
    candlestickModeAllowed: true,
    autonomousChartActionAllowed: true,
    tradeConfirmationAllowed: true,
    blockedReasons: [],
    primaryBlockReason: null,
    note: "All chart gates OPEN.",
    ...over,
  };
}

function makeAlignment(
  tolerance: AlignmentTolerance,
  over: Partial<BrokerPriceAlignment> = {},
): BrokerPriceAlignment {
  const brokerDataAvailable = tolerance !== "unknown";
  const aligned = tolerance === "tight" || tolerance === "normal";
  return {
    aligned,
    tolerance,
    chartPrice: 1.085,
    brokerBid: brokerDataAvailable ? 1.0849 : null,
    brokerAsk: brokerDataAvailable ? 1.0851 : null,
    brokerMid: brokerDataAvailable ? 1.085 : null,
    spreadPoints: brokerDataAvailable ? 2 : null,
    deviationPct: brokerDataAvailable ? 0.0001 : null,
    chartPriceBasis: "MID",
    userMessage: "",
    adminDetail: null,
    brokerDataAvailable,
    ...over,
  };
}

// ── 1. mirrorTrustSegment maps each tier to the correct honest copy ──────────
console.log("mirrorTrustSegment tier mapping:");
check("tight → Mirror synced", mirrorTrustSegment(true, makeAlignment("tight")) === "Mirror synced");
check("normal → Mirror synced", mirrorTrustSegment(true, makeAlignment("normal")) === "Mirror synced");
check("wide → Mirror drifting", mirrorTrustSegment(true, makeAlignment("wide")) === "Mirror drifting");
check(
  "unknown → no alignment claim (null)",
  mirrorTrustSegment(true, makeAlignment("unknown")) === null,
);
// "failed" tolerance always collapses tradeConfirmationAllowed to false upstream.
check(
  "failed → Mirror degraded",
  mirrorTrustSegment(false, makeAlignment("failed")) === "Mirror degraded",
);
// Merge-seam failure with otherwise tight alignment must STILL read degraded
// (the segment composes seam AND alignment state, not alignment alone).
check(
  "seam failed (tight alignment) → Mirror degraded",
  mirrorTrustSegment(false, makeAlignment("tight")) === "Mirror degraded",
);

// ── 2. The hard honesty invariant on the full trust line ─────────────────────
// No line may claim sync when tolerance ∈ {wide, unknown, failed}.
console.log("\ntrust-line sync-claim invariant:");
const NON_SYNC_TIERS: { tolerance: AlignmentTolerance; tradeConfirmationAllowed: boolean }[] = [
  { tolerance: "wide", tradeConfirmationAllowed: true },
  { tolerance: "unknown", tradeConfirmationAllowed: true },
  { tolerance: "failed", tradeConfirmationAllowed: false },
];
for (const tier of NON_SYNC_TIERS) {
  const line = buildTrustLine(
    makeGate({ tradeConfirmationAllowed: tier.tradeConfirmationAllowed }),
    makeAlignment(tier.tolerance),
    "M5",
    false,
    "PASS",
  );
  check(
    `tolerance="${tier.tolerance}" → line never claims mirror sync`,
    !/Mirror sync/i.test(line),
    line,
  );
}

// ── 3. The aligned path still earns "Mirror synced" ──────────────────────────
console.log("\naligned path keeps Mirror synced:");
for (const tolerance of ["tight", "normal"] as const) {
  const line = buildTrustLine(makeGate(), makeAlignment(tolerance), "M5", false, "PASS");
  check(`tolerance="${tolerance}" → line includes Mirror synced`, line.includes("Mirror synced"), line);
}

// ── 4. Wide/unknown produce their honest segments on the full line ───────────
console.log("\nwide/unknown line composition:");
{
  const wide = buildTrustLine(makeGate(), makeAlignment("wide"), "M5", false, "PASS");
  check("wide → line includes Mirror drifting", wide.includes("Mirror drifting"), wide);
}
{
  const unknown = buildTrustLine(makeGate(), makeAlignment("unknown"), "M5", false, "PASS");
  check("unknown → line carries NO Mirror segment at all", !unknown.includes("Mirror"), unknown);
}

if (failures > 0) {
  console.error(`\n${failures} trust-line alignment honesty check(s) FAILED.`);
  process.exit(1);
}
console.log("\nAll trust-line alignment honesty checks passed.");
