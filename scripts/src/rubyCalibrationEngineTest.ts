// Ruby Calibration roll-up — PURE engine test.
//
// Honesty contracts verified here:
//  1. The accuracy denominator is EXACTLY graded directional outcomes (WIN+LOSS).
//     PENDING / UNRESOLVED rows are counted for transparency but NEVER enter the
//     denominator and never inflate accuracy.
//  2. A cell below `minSample` is flagged insufficientSample with null accuracy
//     and null calibrationGap (no fabricated rate off a tiny sample).
//  3. Each row lands in EXACTLY ONE confidence tier — boundary values (60, 75,
//     90, 100) are not double-counted.
//  4. accuracy / avgConfidence / calibrationGap math is correct.
//  5. Totals separate resolved vs pending vs graded vs directionalGraded.
//
// No DB, no IO. Run: pnpm --filter @workspace/scripts run test:ruby-calibration

import {
  computeRubyCalibration,
  DEFAULT_CALIBRATION_MIN_SAMPLE,
  type CalibrationSampleRow,
} from "@workspace/domain/ruby-quality";

let failures = 0;
function check(name: string, cond: boolean) {
  if (cond) { console.log(`  PASS  ${name}`); }
  else { console.error(`  FAIL  ${name}`); failures++; }
}

console.log("Ruby Calibration engine test");

function row(o: Partial<CalibrationSampleRow>): CalibrationSampleRow {
  return { timeframe: "M5", confidenceScore: 80, outcomeStatus: "WIN", ...o };
}

const rows: CalibrationSampleRow[] = [
  // M5 / tier 75-90 (conf 80): 3 WIN + 1 LOSS graded, plus 1 PENDING + 1 UNRESOLVED
  row({}), row({}), row({}),
  row({ outcomeStatus: "LOSS" }),
  row({ outcomeStatus: "PENDING" }),
  row({ outcomeStatus: "UNRESOLVED" }),
  // M5 / tier 90-100 (conf 95): a single WIN → below threshold
  row({ confidenceScore: 95 }),
  // M15 boundary rows — each must land in exactly one tier
  row({ timeframe: "M15", confidenceScore: 60, outcomeStatus: "WIN" }),  // 60 → "60-75"
  row({ timeframe: "M15", confidenceScore: 75, outcomeStatus: "WIN" }),  // 75 → "75-90"
  row({ timeframe: "M15", confidenceScore: 100, outcomeStatus: "WIN" }), // 100 → "90-100"
];

const r = computeRubyCalibration(rows, { minSample: 2 });

// ----- denominator honesty --------------------------------------------------
const m5mid = r.cells.find((c) => c.timeframe === "M5" && c.confidenceTier === "75-90");
check("M5/75-90 cell exists", !!m5mid);
check("denominator = WIN+LOSS only (pending/unresolved excluded)", m5mid!.sample === 4);
check("total still counts pending+unresolved rows", m5mid!.total === 6);
check("pending counted separately (PENDING+UNRESOLVED)", m5mid!.pending === 2);
check("resolved excludes pending", m5mid!.resolved === 4);
check("accuracy = 3/4 = 0.75", m5mid!.accuracy === 0.75);
check("avgConfidence over the sampled rows = 80", m5mid!.avgConfidence === 80);
check("calibrationGap = 0.80 - 0.75 = 0.05", m5mid!.calibrationGap === 0.05);
check("not flagged insufficient when sample >= minSample", m5mid!.insufficientSample === false);

// ----- insufficient sample --------------------------------------------------
const m5hi = r.cells.find((c) => c.timeframe === "M5" && c.confidenceTier === "90-100");
check("M5/90-100 cell exists", !!m5hi);
check("single-sample cell flagged insufficientSample", m5hi!.insufficientSample === true);
check("insufficient cell hides accuracy (null)", m5hi!.accuracy === null);
check("insufficient cell hides calibrationGap (null)", m5hi!.calibrationGap === null);
check("insufficient cell still reports the raw sample count", m5hi!.sample === 1);

// ----- exactly-one-tier (no boundary double-count) --------------------------
check("conf 60 → tier 60-75", !!r.cells.find((c) => c.timeframe === "M15" && c.confidenceTier === "60-75" && c.wins === 1));
check("conf 75 → tier 75-90", !!r.cells.find((c) => c.timeframe === "M15" && c.confidenceTier === "75-90" && c.wins === 1));
check("conf 100 → top tier 90-100", !!r.cells.find((c) => c.timeframe === "M15" && c.confidenceTier === "90-100" && c.wins === 1));
const m15total = r.cells.filter((c) => c.timeframe === "M15").reduce((a, c) => a + c.total, 0);
check("each M15 row assigned to exactly one tier (3 rows, no double-count)", m15total === 3);

// ----- totals ---------------------------------------------------------------
check("totals.tracked counts all rows", r.totals.tracked === 10);
check("totals.directionalGraded = WIN+LOSS only", r.totals.directionalGraded === 8);
check("totals.graded = WIN+LOSS+BREAKEVEN", r.totals.graded === 8);
check("totals.pending = PENDING+UNRESOLVED", r.totals.pending === 2);
check("totals.resolved excludes pending", r.totals.resolved === 8);
check("minSample echoed back", r.minSample === 2);

// ----- honesty invariant: non-directional RESOLVED statuses never inflate ----
// EXPIRED / NO_TRADE_CORRECT / NO_TRADE_MISSED are "resolved" but NOT graded and
// NOT directional. BREAKEVEN is graded but still excluded from the accuracy
// denominator. Only WIN+LOSS may ever divide. None of these may fabricate a rate.
const hrows: CalibrationSampleRow[] = [
  row({ timeframe: "H1", outcomeStatus: "WIN" }),
  row({ timeframe: "H1", outcomeStatus: "WIN" }),
  row({ timeframe: "H1", outcomeStatus: "LOSS" }),
  row({ timeframe: "H1", outcomeStatus: "BREAKEVEN" }),
  row({ timeframe: "H1", outcomeStatus: "EXPIRED" }),
  row({ timeframe: "H1", outcomeStatus: "NO_TRADE_CORRECT" }),
  row({ timeframe: "H1", outcomeStatus: "NO_TRADE_MISSED" }),
  row({ timeframe: "H1", outcomeStatus: "PENDING" }),
  row({ timeframe: "H1", outcomeStatus: "UNRESOLVED" }),
];
const hr = computeRubyCalibration(hrows, { minSample: 2 });
const h1 = hr.cells.find((c) => c.timeframe === "H1" && c.confidenceTier === "75-90");
const acc23 = Math.round((2 / 3) * 1000) / 1000; // engine rounds to 3 dp
check("H1 cell exists", !!h1);
check("sample = WIN+LOSS only (BREAKEVEN/EXPIRED/no-trade excluded)", h1!.sample === 2 + 1);
check("accuracy = 2/3 — only directional outcomes divide", h1!.accuracy === acc23);
check("BREAKEVEN tracked but kept out of the denominator", h1!.breakeven === 1);
check("EXPIRED/no-trade counted as resolved, never pending", h1!.resolved === 7);
check("only PENDING+UNRESOLVED count as pending", h1!.pending === 2);
check("total counts every row", h1!.total === 9);
check("avgConfidence averaged over directional rows only", h1!.avgConfidence === 80);
check("totals.directionalGraded = WIN+LOSS only", hr.totals.directionalGraded === 3);
check("totals.graded = WIN+LOSS+BREAKEVEN (no-trade/expired excluded)", hr.totals.graded === 4);
check("totals.resolved excludes only pending/unresolved", hr.totals.resolved === 7);
check("totals.pending = PENDING+UNRESOLVED", hr.totals.pending === 2);

// ----- honesty invariant: a cell with ZERO directional outcomes stays null ---
// A cell that resolved but produced no WIN/LOSS must never report 0/0 as a rate.
const zrows: CalibrationSampleRow[] = [
  row({ timeframe: "H4", confidenceScore: 85, outcomeStatus: "EXPIRED" }),
  row({ timeframe: "H4", confidenceScore: 85, outcomeStatus: "NO_TRADE_CORRECT" }),
  row({ timeframe: "H4", confidenceScore: 85, outcomeStatus: "PENDING" }),
  row({ timeframe: "H4", confidenceScore: 85, outcomeStatus: "UNRESOLVED" }),
];
const zr = computeRubyCalibration(zrows, { minSample: 1 });
const z = zr.cells.find((c) => c.timeframe === "H4");
check("zero-directional cell exists", !!z);
check("zero-directional cell: sample 0", z!.sample === 0);
check("zero-directional cell: accuracy null (never 0/0)", z!.accuracy === null);
check("zero-directional cell: avgConfidence null (no sampled rows)", z!.avgConfidence === null);
check("zero-directional cell: calibrationGap null", z!.calibrationGap === null);
check("zero-directional cell: insufficientSample true even at minSample 1", z!.insufficientSample === true);
check("zero-directional cell: resolved counts EXPIRED+NO_TRADE_CORRECT", z!.resolved === 2);
check("zero-directional cell: pending counts PENDING+UNRESOLVED", z!.pending === 2);
check("zero-directional cell: tracked nothing as directionalGraded", zr.totals.directionalGraded === 0);

// ----- empty input ----------------------------------------------------------
const empty = computeRubyCalibration([]);
check("empty input → no cells", empty.cells.length === 0);
check("empty input → zero totals", empty.totals.tracked === 0 && empty.totals.directionalGraded === 0);
check("empty input → default minSample", empty.minSample === DEFAULT_CALIBRATION_MIN_SAMPLE);

if (failures > 0) {
  console.error(`\nRuby Calibration engine test: ${failures} FAILED`);
  process.exit(1);
}
console.log("\nRuby Calibration engine test: all checks passed");

export {};
