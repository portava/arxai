// Eleanor grounding x calibration engine seam (pure, offline).
//
// The calibration engine stamps payloads with a CalibrationStamp
// ({ probability, status, n, model, baseRate, edgeDetected, label, ... }); it
// never writes `calibrated: true`. The verifier must therefore recognise the
// stamp itself:
//   - a MEASURED probability with its N survives ("Win prob 62% (N=143)");
//   - an UNMEASURED stamp never makes a number quotable as a probability;
//   - a raw confidence/score shown as a % is still removed, even next to a
//     measured stamp;
//   - a measured BASE RATE (edgeDetected false) may be quoted as a base rate,
//     never as this setup's chance or edge;
//   - the stamp's n / fitVersion are counts, never probabilities.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { checkClaims } from "../grounding/claimsChecker.js";
import { buildEvidenceIndex, calibrationStampInfo } from "../grounding/evidence.js";
import { verifyAnswer, VERIFIER_NOTICES } from "../grounding/runtimeVerifier.js";
import {
  calibrate,
  clearCalibrationCache,
  toCalibrationStamp,
  SCANNER_CALIBRATION_KEY,
  type CalibrationStamp,
} from "../../calibration/cache.js";

const measuredEdge: CalibrationStamp = toCalibrationStamp({
  probability: 0.62, status: "measured", n: 143, scope: "exact", model: "isotonic",
  fitKey: "scanner|GBPUSD|H1", fitVersion: 3, baseRate: 0.5, edgeDetected: true, reason: null,
} as Parameters<typeof toCalibrationStamp>[0]);

const measuredBaseRate: CalibrationStamp = toCalibrationStamp({
  probability: 0.55, status: "measured", n: 143, scope: "pooled_all", model: "base_rate",
  fitKey: "scanner|*|*", fitVersion: 2, baseRate: 0.55, edgeDetected: false, reason: "No out-of-sample edge over the base rate.",
} as Parameters<typeof toCalibrationStamp>[0]);

const row = (over: Record<string, unknown>) => ({
  name: "getMarketScannerOpportunities",
  result: { opportunities: [{ symbol: "GBPUSD", timeframe: "H1", recommendedAction: "BUY", score: 72, riskScore: 35, ...over }], count: 1 },
});
const kinds = (text: string, outputs: Array<{ name: string; result: unknown }>) => checkClaims(text, outputs).findings.map((f) => f.kind);

test("the stamp label is what the engine formats", () => {
  assert.equal(measuredEdge.label, "62% (N=143)");
  assert.equal(measuredBaseRate.label, "55% (N=143)");
});

test("a measured calibrated probability with its N survives the verifier", () => {
  const out = [row({ calibratedProbability: 0.62, calibration: measuredEdge })];
  assert.deepEqual(kinds("GBPUSD H1: Win prob 62% (N=143).", out), []);
  assert.deepEqual(kinds("GBPUSD has a 62% chance of hitting TP, measured on 143 graded calls.", out), []);
  assert.deepEqual(kinds("The calibrated probability is 0.62 (N=143).", out), []);
  assert.deepEqual(kinds("This setup has a 62% probability of working, an edge over the 50% base rate.", out), []);
  const v = verifyAnswer("GBPUSD H1: Win prob 62% (N=143).", out);
  assert.equal(v.text, "GBPUSD H1: Win prob 62% (N=143).", "shown unchanged, nothing removed");
  assert.equal(v.findings.length, 0);
});

test("the stamp alone (no calibratedProbability sibling) is enough", () => {
  const out = [{ name: "getFinalTradeRead", result: { symbol: "GBPUSD", finalRead: { technicalScore: 72 }, calibration: measuredEdge } }];
  assert.deepEqual(kinds("Win prob 62% (N=143).", out), []);
});

test("a raw confidence/score shown as a % is still removed, even next to a measured stamp", () => {
  const out = [row({ calibratedProbability: 0.62, calibration: measuredEdge })];
  assert.deepEqual(kinds("GBPUSD has a 72% chance of hitting TP.", out), ["UNCALIBRATED_PROBABILITY"]);
  assert.deepEqual(kinds("GBPUSD rates 72% on the scanner.", out), ["UNCALIBRATED_PROBABILITY"]);
  assert.deepEqual(kinds("GBPUSD has a confidence score of 72/100.", out), []);
  const v = verifyAnswer("GBPUSD has a 72% chance of hitting TP.", out);
  assert.ok(v.text.includes(VERIFIER_NOTICES.UNCALIBRATED_PROBABILITY));
  assert.ok(!v.text.includes("72%"));
  // A renamed raw field (scanner lane: confidence -> score) is still a raw score.
  const renamed = [{ name: "getMarketScannerOpportunities", result: { opportunities: [{ symbol: "GBPUSD", score: 72, calibration: measuredEdge }] } }];
  assert.deepEqual(kinds("GBPUSD has a 72% chance.", renamed), ["UNCALIBRATED_PROBABILITY"]);
});

test("an unmeasured stamp never makes a number quotable as a probability", () => {
  clearCalibrationCache();
  const unmeasured = calibrate(SCANNER_CALIBRATION_KEY, "GBPUSD", "H1", 62);
  assert.equal(unmeasured.status, "unmeasured");
  assert.equal(unmeasured.probability, null);
  const out = [row({ score: 62, calibratedProbability: null, calibration: unmeasured })];
  assert.deepEqual(kinds("GBPUSD has a 62% chance of working.", out), ["UNCALIBRATED_PROBABILITY"]);
  assert.deepEqual(kinds("Win prob 62%.", out), ["UNCALIBRATED_PROBABILITY"]);
  // Saying it is unmeasured, with N, is fine.
  const withN = [row({ calibration: { ...unmeasured, n: 12, label: "unmeasured (N=12)" } })];
  assert.deepEqual(kinds("The win probability is unmeasured (N=12), so treat the score as a score.", withN), []);
});

test("a measured base rate is quotable as a base rate, never as an edge", () => {
  const out = [row({ calibratedProbability: 0.55, calibration: measuredBaseRate })];
  assert.deepEqual(kinds("Historically 55% of these calls worked (N=143).", out), []);
  assert.deepEqual(kinds("The base rate is 55% (N=143), with no measured edge on top of it.", out), []);
  assert.deepEqual(kinds("The base-rate chance across all scanner calls is 55% (N=143).", out), []);
  assert.deepEqual(kinds("This setup has a 55% chance of working.", out), ["UNCALIBRATED_PROBABILITY"]);
  assert.deepEqual(kinds("That gives you a 55% edge here.", out), ["UNCALIBRATED_PROBABILITY"]);
  assert.deepEqual(kinds("Historically 55% chance, and this setup beats it.", out), ["UNCALIBRATED_PROBABILITY"]);
  // The baseRate leaf inside an EDGE stamp is still only a base rate.
  const edge = [row({ calibratedProbability: 0.62, calibration: measuredEdge })];
  assert.deepEqual(kinds("This setup has a 50% chance.", edge), ["UNCALIBRATED_PROBABILITY"]);
  assert.deepEqual(kinds("The base rate is 50%.", edge), []);
});

test("stamp counts are never probabilities, and a stamp is not an order", () => {
  const stamp = { ...measuredEdge, n: 50 };
  const out = [row({ score: 10, calibration: stamp, calibratedProbability: 0.62 })];
  assert.deepEqual(kinds("GBPUSD has a 50% chance.", out), ["UNCALIBRATED_PROBABILITY"], "n=50 is a count");
  const idx = buildEvidenceIndex(out);
  assert.equal(idx.executions.length, 0, "status \"measured\" is not an order status");
  const prob = idx.numbers.find((n) => n.path.endsWith("calibration.probability"));
  assert.equal(prob?.calibrated, true);
  assert.equal(prob?.calibrationKind, "measured");
  assert.equal(prob?.calibrationN, 50);
  assert.equal(idx.numbers.find((n) => n.path.endsWith("calibration.n"))?.calibrated, false);
  assert.equal(idx.numbers.find((n) => n.path.endsWith(".score"))?.calibrated, null);
});

test("stamp detection keys off the stamp shape, not a payload field name", () => {
  assert.ok(calibrationStampInfo(measuredEdge as unknown as Record<string, unknown>)?.measured);
  assert.equal(calibrationStampInfo(measuredBaseRate as unknown as Record<string, unknown>)?.kind, "base_rate");
  assert.equal(calibrationStampInfo({ status: "measured", probability: 0.6 }), null, "no n / edgeDetected: not a stamp");
  // A review payload marked calibrated:false with a nested unmeasured stamp.
  clearCalibrationCache();
  const review = [{ name: "getAiReview", result: { calibrated: false, score: 64, calibration: calibrate("ai_review", "EURUSD", "M15", 64) } }];
  assert.deepEqual(kinds("The review gives a 64% chance.", review), ["UNCALIBRATED_PROBABILITY"]);
});

test("Eleanor's scanner, final-read and ranking tools carry the calibration stamp", () => {
  const src = readFileSync(fileURLToPath(new URL("../tools.ts", import.meta.url)), "utf8");
  const scanner = src.slice(src.indexOf("export async function getMarketScannerOpportunities"), src.indexOf("// ── Tool registry & dispatcher"));
  assert.match(scanner, /calibration: o\.calibration \?\? null/);
  assert.match(scanner, /calibratedProbability: o\.calibratedProbability \?\? null/);
  const finalRead = src.slice(src.indexOf('case "getFinalTradeRead"'), src.indexOf('case "getMarketNewsIntelligence"'));
  assert.match(finalRead, /calibration: opp\.calibration \?\? null/);
  const explain = src.slice(src.indexOf("export async function explainOpportunityRankingTool"), src.indexOf("// ── Phase TT"));
  assert.match(explain, /calibration: o\.calibration \?\? null/);
});
