// Ruby/AI Setup-Preview SIGNAL-ASSEMBLY regression suite (Task #381).
//
// Task #380 wired the live scanner score + per-symbol risk score, the flame/run-on
// momentum stage, and the agent-governance outcome into the "draw a trade setup"
// endpoint (POST /me/assistant/draw-setup). The pure PRODUCER (buildSetupPreview)
// is covered by rubySetupPreviewTest; this suite covers the *assembly/wiring*
// logic that lives between the route's real data sources and the producer —
// extracted into the pure `setupSignals` helper so it is unit-testable:
//
//   - timeframe-preferred scanner-candidate selection
//   - run-on quality banding (0..1 qualityScore -> strong/moderate/weak)
//   - governance-outcome mapping (all 9 Court outcomes -> GovernanceVerdict,
//     incl. the delayed_speed / learning_camp_review -> "neutral" collapse)
//   - fail-open: a thrown scanner / scalp / governance call still yields a valid
//     signal bundle with those fields null (never a throw, never fabricated)
//
// SAFETY: pure-function test. No DB, no broker, no env mutation, no app boot.

import {
  mapGovernanceVerdict,
  selectScannerCandidate,
  deriveScannerSignals,
  bandRunOnQuality,
  deriveFlameSignals,
  deriveGovernanceSide,
  deriveGovernanceScores,
  assembleSetupSignals,
  type SetupSignalsDeps,
} from "../../artifacts/api-server/src/lib/assistant/setupSignals.js";
import type {
  LiveScannerResult,
  LiveCandidate,
} from "../../artifacts/api-server/src/lib/assistant/liveScanner.js";
import type { ScalpResult } from "../../artifacts/api-server/src/lib/scalp/scalpTypes.js";
import type { GovernanceOutcome } from "@workspace/domain/agent-system";

type CaseResult = { name: string; ok: boolean; detail?: string };
const results: CaseResult[] = [];
function record(name: string, ok: boolean, detail?: string) {
  results.push({ name, ok, detail });
  const label = ok ? "PASS" : "FAIL";
  // eslint-disable-next-line no-console
  console.log(`  ${label}  ${name}${detail ? ` — ${detail}` : ""}`);
}

// ── Fixtures ────────────────────────────────────────────────────────────────
// Minimal candidate: the selection logic only reads symbol/timeframe/score and
// the derived signals read score/riskScore. Cast the rest.
function candidate(over: Partial<LiveCandidate>): LiveCandidate {
  return {
    symbol: "EURUSD",
    timeframe: "M15",
    score: 50,
    riskScore: 50,
    ...over,
  } as LiveCandidate;
}
function scannerResult(
  candidates: LiveCandidate[],
  connected = true,
): LiveScannerResult {
  return { connected, candidates } as unknown as LiveScannerResult;
}
// Minimal scalp result: the flame-signal derivation reads only
// flame.flameStage + flame.runOnTrace?.qualityScore.
function scalpResult(flameStage: string, qualityScore: number | null): ScalpResult {
  return {
    flame: {
      flameStage,
      runOnTrace: qualityScore == null ? undefined : { qualityScore },
    },
  } as unknown as ScalpResult;
}

// ── 1) Governance-outcome mapping: all 9 Court outcomes ─────────────────────
{
  const expected: Record<GovernanceOutcome, string> = {
    approved: "approved",
    approved_with_caution: "approved_with_caution",
    downgraded: "downgraded",
    rejected: "rejected",
    escalated: "escalated",
    needs_more_data: "needs_more_data",
    muted_low_confidence: "muted_low_confidence",
    // the two operational outcomes collapse — never assert a team verdict
    delayed_speed: "neutral",
    learning_camp_review: "neutral",
  };
  const mism: string[] = [];
  for (const [outcome, want] of Object.entries(expected)) {
    const got = mapGovernanceVerdict(outcome as GovernanceOutcome);
    if (got !== want) mism.push(`${outcome}->${got} (want ${want})`);
  }
  record(
    "mapGovernanceVerdict: all 9 Court outcomes map correctly",
    mism.length === 0,
    mism.length ? mism.join("; ") : "9/9 (incl. delayed_speed+learning_camp_review -> neutral)",
  );
}

// ── 2) Scanner selection: prefers the requested-timeframe candidate ─────────
{
  const res = scannerResult([
    candidate({ timeframe: "M5", score: 99 }), // higher score but wrong TF
    candidate({ timeframe: "M15", score: 70 }), // matches requested TF
    candidate({ timeframe: "H1", score: 80 }),
  ]);
  const match = selectScannerCandidate(res, "EURUSD", "M15");
  record(
    "scanner selection prefers requested timeframe over higher score",
    match != null && match.timeframe === "M15" && match.score === 70,
    `picked tf=${match?.timeframe} score=${match?.score}`,
  );
}

// ── 3) Scanner selection: falls back to top score when no TF match ──────────
{
  const res = scannerResult([
    candidate({ timeframe: "M5", score: 60 }),
    candidate({ timeframe: "H1", score: 88 }),
    candidate({ timeframe: "H4", score: 75 }),
  ]);
  const match = selectScannerCandidate(res, "EURUSD", "M15"); // no M15
  record(
    "scanner selection falls back to top-ranked candidate (no TF match)",
    match != null && match.score === 88 && match.timeframe === "H1",
    `picked tf=${match?.timeframe} score=${match?.score}`,
  );
}

// ── 4) Scanner selection: only this symbol's candidates considered ──────────
{
  const res = scannerResult([
    candidate({ symbol: "GBPUSD", timeframe: "M15", score: 99 }),
    candidate({ symbol: "EURUSD", timeframe: "M5", score: 41 }),
  ]);
  const sig = deriveScannerSignals(res, "EURUSD", "M15");
  record(
    "scanner signals are symbol-scoped (never cross-symbol leakage)",
    sig.scannerScore === 41 && sig.riskScore != null,
    `scannerScore=${sig.scannerScore}`,
  );
}

// ── 5) Scanner selection: null / disconnected / empty -> no signals ─────────
{
  const disconnected = deriveScannerSignals(
    scannerResult([candidate({})], false),
    "EURUSD",
    "M15",
  );
  const nullRes = deriveScannerSignals(null, "EURUSD", "M15");
  const noMatch = deriveScannerSignals(
    scannerResult([candidate({ symbol: "XAUUSD" })]),
    "EURUSD",
    "M15",
  );
  const ok =
    disconnected.scannerScore === null &&
    disconnected.riskScore === null &&
    nullRes.scannerScore === null &&
    noMatch.scannerScore === null;
  record(
    "scanner signals null when disconnected / null / no symbol match",
    ok,
    `disc=${disconnected.scannerScore} null=${nullRes.scannerScore} noMatch=${noMatch.scannerScore}`,
  );
}

// ── 6) Run-on quality banding thresholds (>=0.66 strong, >=0.33 moderate) ───
{
  const cases: Array<[number | null, string | null]> = [
    [1.0, "strong"],
    [0.66, "strong"],
    [0.65, "moderate"],
    [0.33, "moderate"],
    [0.32, "weak"],
    [0.0, "weak"],
    [null, null],
  ];
  const mism = cases.filter(([q, want]) => bandRunOnQuality(q) !== want);
  record(
    "run-on quality banding thresholds",
    mism.length === 0,
    mism.length ? mism.map(([q]) => `q=${q}->${bandRunOnQuality(q)}`).join("; ") : "boundaries 0.66/0.33 + null",
  );
}

// ── 7) Flame signals: stage passthrough + banding; null scalp -> nulls ──────
{
  const runOn = deriveFlameSignals(scalpResult("RUN_ON", 0.8));
  const igniting = deriveFlameSignals(scalpResult("IGNITING", null)); // no trace
  const none = deriveFlameSignals(null);
  const ok =
    runOn.flameStage === "RUN_ON" &&
    runOn.runOnQuality === "strong" &&
    igniting.flameStage === "IGNITING" &&
    igniting.runOnQuality === null &&
    none.flameStage === null &&
    none.runOnQuality === null;
  record(
    "flame signals: stage passthrough + run-on band; null scalp -> nulls",
    ok,
    `runOn=${runOn.flameStage}/${runOn.runOnQuality} igniting=${igniting.flameStage}/${igniting.runOnQuality}`,
  );
}

// ── 8) Governance side + score derivation ───────────────────────────────────
{
  const sideExplicit = deriveGovernanceSide("SELL", "Bullish"); // explicit wins
  const sideFromBias = deriveGovernanceSide(null, "Bullish");
  const sideNeutral = deriveGovernanceSide(undefined, "Range-bound");
  // prefer real scanner numbers; fall back to structure-derived estimate
  const withScanner = deriveGovernanceScores(82, 35, "Low");
  const fallback = deriveGovernanceScores(null, null, "High");
  const ok =
    sideExplicit === "SELL" &&
    sideFromBias === "BUY" &&
    sideNeutral === "NEUTRAL" &&
    withScanner.confNum === 82 &&
    withScanner.riskNum === 35 &&
    fallback.confNum === 80 && // High -> 80
    fallback.riskNum === 20; // 100 - 80
  record(
    "governance side + score derivation (real numbers preferred, honest fallback)",
    ok,
    `explicit=${sideExplicit} bias=${sideFromBias} fb=${fallback.confNum}/${fallback.riskNum}`,
  );
}

// ── 9) assembleSetupSignals: full happy path passes real signals through ────
{
  let govArgs: { side: string; confNum: number; riskNum: number } | null = null;
  const deps: SetupSignalsDeps = {
    scoreLiveCandidates: async () =>
      scannerResult([
        candidate({ timeframe: "M5", score: 99, riskScore: 10 }),
        candidate({ timeframe: "M15", score: 82, riskScore: 35 }),
      ]),
    evaluateScalpForSymbol: async () => scalpResult("RUN_ON", 0.9),
    runGovernance: async (args) => {
      govArgs = args;
      // delayed_speed must collapse to "neutral" via the mapping inside assemble
      return { outcome: "delayed_speed", cautions: ["keep it light"] };
    },
  };
  const sig = await assembleSetupSignals(
    { symbol: "EURUSD", timeframe: "M15", requestedSide: "BUY", bias: "Bullish", confidence: "Low" },
    deps,
  );
  const ok =
    sig.scannerScore === 82 && // timeframe-preferred candidate
    sig.riskScore === 35 &&
    sig.flameStage === "RUN_ON" &&
    sig.runOnQuality === "strong" &&
    sig.governanceOutcome === "neutral" && // mapped from delayed_speed
    sig.governanceCautions.length === 1 &&
    // governance fed the REAL scanner score, not the Low-confidence fallback (40)
    govArgs != null &&
    (govArgs as { confNum: number }).confNum === 82 &&
    (govArgs as { riskNum: number }).riskNum === 35 &&
    (govArgs as { side: string }).side === "BUY";
  record(
    "assembleSetupSignals: real signals passed through + governance mapped",
    ok,
    `scanner=${sig.scannerScore} risk=${sig.riskScore} flame=${sig.flameStage}/${sig.runOnQuality} gov=${sig.governanceOutcome} fedConf=${govArgs ? (govArgs as { confNum: number }).confNum : "?"}`,
  );
}

// ── 10) assembleSetupSignals: governance returns null (shadow / no influence) ─
{
  const deps: SetupSignalsDeps = {
    scoreLiveCandidates: async () => scannerResult([candidate({ timeframe: "M15", score: 70, riskScore: 30 })]),
    evaluateScalpForSymbol: async () => scalpResult("NONE", null),
    runGovernance: async () => null, // no influencing agents
  };
  const sig = await assembleSetupSignals(
    { symbol: "EURUSD", timeframe: "M15", requestedSide: "BUY", bias: "Bullish", confidence: "Medium" },
    deps,
  );
  const ok =
    sig.scannerScore === 70 &&
    sig.governanceOutcome === null &&
    sig.governanceCautions.length === 0;
  record(
    "assembleSetupSignals: governance null -> outcome null (honest, not fabricated)",
    ok,
    `scanner=${sig.scannerScore} gov=${sig.governanceOutcome}`,
  );
}

// ── 11) assembleSetupSignals: FAIL-OPEN on thrown scanner/scalp/governance ──
{
  const deps: SetupSignalsDeps = {
    scoreLiveCandidates: async () => {
      throw new Error("scanner down");
    },
    evaluateScalpForSymbol: async () => {
      throw new Error("scalp down");
    },
    runGovernance: async () => {
      throw new Error("court down");
    },
  };
  let threw = false;
  let sig = null as Awaited<ReturnType<typeof assembleSetupSignals>> | null;
  try {
    sig = await assembleSetupSignals(
      { symbol: "EURUSD", timeframe: "M15", requestedSide: "BUY", bias: "Bullish", confidence: "High" },
      deps,
    );
  } catch {
    threw = true;
  }
  const ok =
    !threw &&
    sig != null &&
    sig.scannerScore === null &&
    sig.riskScore === null &&
    sig.flameStage === null &&
    sig.runOnQuality === null &&
    sig.governanceOutcome === null &&
    sig.governanceCautions.length === 0;
  record(
    "assembleSetupSignals: fail-open — thrown calls yield all-null, never a throw",
    ok,
    threw ? "THREW" : `all null=${sig?.scannerScore === null && sig?.governanceOutcome === null}`,
  );
}

// ── summary ─────────────────────────────────────────────────────────────────
const failed = results.filter((r) => !r.ok);
// eslint-disable-next-line no-console
console.log(
  `\nrubySetupSignalsTest: ${results.length - failed.length}/${results.length} passed`,
);
if (failed.length > 0) {
  // eslint-disable-next-line no-console
  console.error(`FAILED: ${failed.map((f) => f.name).join("; ")}`);
  process.exit(1);
}

export {};
