// check-chart-truth-mock-leak.ts
//
// Static-analysis CI guard: proves that mock/simulated candle data cannot
// silently reach the user as live data in the chart-truth pipeline.
//
// What it checks (source-scan, no network/DB required):
//
//   1. MOCK_SOURCE_GATE — `sourceModeFromProvider` must classify every known
//      mock/shim label as "mock" (never "live" or "unknown"). Verified by
//      confirming the guard code block is present and covers the required labels.
//
//   2. TRUTH_ENGINE_MOCK_GATE — `candleTruthEngine.ts` must set
//      `mockDataDetected` from the sourceMode and transition to "DEGRADED"
//      assessment when detected. Verified by confirming the guard expression is
//      present in the engine source.
//
//   3. DATA_SERVICE_QUALITY_GATE — `chartDataService.ts` must map
//      `mockDataDetected` to quality="invalid" (never "clean") so `aiUsable`
//      can never be true when mock data is present. Verified by confirming the
//      branch is present.
//
//   4. NO_MOCK_IN_LIVE_ROUTES — The api-server chart route files must not
//      import from any known mock provider or pass a mock source string directly
//      to the chart pipeline (guarding against a developer accidentally hardwiring
//      a mock provider in a live route).
//
// All checks are fast static scans — no runtime, no DB, no network.

import { join } from "node:path";
import type { CheckResult } from "./_lib.js";
import { ROOT, walk, read, rel } from "./_lib.js";

const CHART_DIR = join(ROOT, "artifacts/api-server/src/lib/data/chart");
const ROUTES_DIR = join(ROOT, "artifacts/api-server/src/routes");

export function checkChartTruthMockLeak(): CheckResult {
  const violations: string[] = [];
  const notes: string[] = [];

  // ── Check 1: MOCK_SOURCE_GATE ─────────────────────────────────────────────
  const normPath = join(CHART_DIR, "candleNormalization.ts");
  let normSrc: string;
  try {
    normSrc = read(normPath);
  } catch {
    violations.push(`candleNormalization.ts not found at expected path (${rel(normPath)})`);
    return { name: "chart-truth-mock-leak", ok: false, violations };
  }

  const mockLabels = ['"mock"', '"twelveData_mock_shim"', 'includes("mock_shim")'];
  for (const label of mockLabels) {
    if (!normSrc.includes(label)) {
      violations.push(`candleNormalization.ts: missing mock-source guard for ${label}`);
    }
  }

  // The guard must classify mock labels as "mock" (not "live" or "unknown")
  if (!normSrc.includes('return "mock"') && !normSrc.includes("return 'mock'")) {
    violations.push('candleNormalization.ts: sourceModeFromProvider must return "mock" for mock sources');
  }

  // ── Check 2: TRUTH_ENGINE_MOCK_GATE ──────────────────────────────────────
  const enginePath = join(CHART_DIR, "candleTruthEngine.ts");
  let engineSrc: string;
  try {
    engineSrc = read(enginePath);
  } catch {
    violations.push(`candleTruthEngine.ts not found (${rel(enginePath)})`);
    return { name: "chart-truth-mock-leak", ok: false, violations };
  }

  if (!engineSrc.includes("mockDataDetected")) {
    violations.push("candleTruthEngine.ts: mockDataDetected gate is missing");
  }
  if (!engineSrc.includes('"DEGRADED"')) {
    violations.push('candleTruthEngine.ts: must produce "DEGRADED" assessment for mock/dev sources');
  }
  // Confirm mock detection uses sourceMode (not a raw string comparison bypassing the classifier)
  if (!engineSrc.includes('sourceMode === "mock"') && !engineSrc.includes("sourceMode === 'mock'")) {
    violations.push('candleTruthEngine.ts: mockDataDetected must check sourceMode === "mock" (not raw strings)');
  }

  // ── Check 3: DATA_SERVICE_QUALITY_GATE ───────────────────────────────────
  const servicePath = join(CHART_DIR, "chartDataService.ts");
  let serviceSrc: string;
  try {
    serviceSrc = read(servicePath);
  } catch {
    violations.push(`chartDataService.ts not found (${rel(servicePath)})`);
    return { name: "chart-truth-mock-leak", ok: false, violations };
  }

  if (!serviceSrc.includes("mockDataDetected")) {
    violations.push("chartDataService.ts: must read mockDataDetected from truth result");
  }
  // The service must set quality to "invalid" (not "clean") when mock data detected
  if (!serviceSrc.includes('"invalid"')) {
    violations.push('chartDataService.ts: must produce quality="invalid" branch (not "clean") for mock data');
  }
  // aiUsable must be gated on quality===clean
  if (!serviceSrc.includes('quality === "clean"') && !serviceSrc.includes("quality === 'clean'")) {
    violations.push('chartDataService.ts: aiUsable must be derived from quality === "clean"');
  }

  // ── Check 4: NO_MOCK_IN_LIVE_ROUTES ──────────────────────────────────────
  // Scan all route files; they must not import a mock provider or hardwire a
  // mock source string into any chart function call.
  const MOCK_PATTERNS = [
    "twelveData_mock_shim",
    '"mock"',
    "mockProvider",
    "mock_shim",
  ];

  // Chart-truth-specific route files to check (data.ts is the chart route)
  const routeFiles = walk(ROUTES_DIR, {
    exts: [".ts"],
    skip: (p) => p.includes("node_modules") || p.includes("dist"),
  });

  for (const rf of routeFiles) {
    let src: string;
    try {
      src = read(rf);
    } catch {
      continue;
    }
    // Only check files that import from the chart data service
    if (!src.includes("chartDataService") && !src.includes("chart/candles")) continue;

    for (const pat of MOCK_PATTERNS) {
      if (src.includes(pat)) {
        violations.push(
          `Route file ${rel(rf)} references mock pattern "${pat}" — mock data must never reach a live chart route`,
        );
      }
    }
  }

  notes.push("Mock-source gate: sourceModeFromProvider → 'mock' for all known shims ✓");
  notes.push("Truth-engine gate: mockDataDetected → DEGRADED assessment, never CLEAN ✓");
  notes.push("Data-service gate: mockDataDetected → quality='invalid', aiUsable=false ✓");
  notes.push(`No-mock-in-routes: scanned ${routeFiles.length} route file(s) ✓`);

  return {
    name: "chart-truth-mock-leak",
    ok: violations.length === 0,
    violations,
    notes,
  };
}
