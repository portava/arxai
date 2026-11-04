// Task #380/#381 — Setup-preview signal assembly (pure wiring helpers).
//
// The "draw a trade setup" endpoint (POST /me/assistant/draw-setup) enriches the
// deterministic setup-preview producer with the SAME real signals the rest of the
// app already computes: the live scanner score + per-symbol risk score, the
// flame/run-on momentum stage, and the agent-governance outcome. The producer
// itself (buildSetupPreview) is pure and already tested; this module isolates the
// *assembly/wiring* logic that previously lived inline in the route handler so it
// is unit-testable on its own:
//
//   - timeframe-preferred scanner-candidate selection
//   - run-on quality banding (0..1 qualityScore -> strong/moderate/weak)
//   - governance-outcome mapping (Court outcome -> user-safe GovernanceVerdict)
//   - fail-open orchestration (a thrown scanner/scalp/governance call leaves the
//     corresponding fields null — never a fabricated value, never a throw)
//
// SAFETY: pure functions + an orchestrator over INJECTED dependencies. No DB, no
// broker, no provider calls of its own. Governance here is advisory/shadow only —
// it never gates a trade and never changes the safety envelope (the caller wires
// the real advisory -> Traffic -> Court flow through `runGovernance`).

import type { GovernanceOutcome, AdvisoryDirection } from "@workspace/domain/agent-system";
import type { GovernanceVerdict } from "./setupPreview.js";
import type { LiveScannerResult, LiveCandidate } from "./liveScanner.js";
import type { ScalpResult } from "../scalp/scalpTypes.js";
import type { StructureBias, StructureConfidence } from "./chartStructure.js";

export type RunOnQualityBand = "strong" | "moderate" | "weak";

export interface SetupSignals {
  scannerScore: number | null;
  /**
   * The timeframe the scanner score was actually computed on. Only ever equal
   * to the chart timeframe (a different-timeframe candidate is never used), or
   * null when the scanner has no score for the chart's timeframe.
   */
  scannerTimeframe?: string | null;
  riskScore: number | null;
  flameStage: string | null;
  runOnQuality: RunOnQualityBand | null;
  governanceOutcome: GovernanceVerdict | null;
  governanceCautions: string[];
}

// ── Governance-outcome mapping ──────────────────────────────────────────────
// Map the Agent Court's internal governance outcome onto the user-safe
// GovernanceVerdict the setup-preview producer understands. The two operational
// outcomes (delayed_speed / learning_camp_review) have no user-facing trade
// meaning, so they collapse to "neutral" — never asserting a team verdict the
// Court did not actually reach. All trade-meaningful outcomes pass through 1:1.
export function mapGovernanceVerdict(outcome: GovernanceOutcome): GovernanceVerdict {
  switch (outcome) {
    case "approved":
    case "approved_with_caution":
    case "downgraded":
    case "rejected":
    case "escalated":
    case "needs_more_data":
    case "muted_low_confidence":
      return outcome;
    case "delayed_speed":
    case "learning_camp_review":
    default:
      return "neutral";
  }
}

// ── Scanner-candidate selection ─────────────────────────────────────────────
// Only the candidate scored on the chart's OWN timeframe counts. The live
// scanner scores just M15/H1 (liveScanner LIVE_TIMEFRAMES); on any other chart timeframe
// there is no scanner score, and a different-timeframe candidate is never
// substituted (it would show an M15/H1 score as if it described the chart, and
// feed it to the agent-team verdict as such). Returns null when the scanner is
// absent / disconnected or has no candidate for this symbol + timeframe.
export function selectScannerCandidate(
  scannerRes: LiveScannerResult | null,
  symbol: string,
  timeframe: string,
): LiveCandidate | null {
  if (!scannerRes || !scannerRes.connected) return null;
  return (
    scannerRes.candidates.find((c) => c.symbol === symbol && c.timeframe === timeframe) ??
    null
  );
}

export function deriveScannerSignals(
  scannerRes: LiveScannerResult | null,
  symbol: string,
  timeframe: string,
): { scannerScore: number | null; riskScore: number | null; scannerTimeframe: string | null } {
  const match = selectScannerCandidate(scannerRes, symbol, timeframe);
  if (!match) return { scannerScore: null, riskScore: null, scannerTimeframe: null };
  return { scannerScore: match.score, riskScore: match.riskScore, scannerTimeframe: match.timeframe };
}

// ── Run-on quality banding ──────────────────────────────────────────────────
// Band the real 0..1 run-on quality score into plain English. Null in -> null
// out (run-on quality is only meaningful while the flame is RUN_ON).
export function bandRunOnQuality(
  qualityScore: number | null | undefined,
): RunOnQualityBand | null {
  if (qualityScore == null) return null;
  return qualityScore >= 0.66 ? "strong" : qualityScore >= 0.33 ? "moderate" : "weak";
}

export function deriveFlameSignals(scalpRes: ScalpResult | null): {
  flameStage: string | null;
  runOnQuality: RunOnQualityBand | null;
} {
  if (!scalpRes) return { flameStage: null, runOnQuality: null };
  return {
    flameStage: scalpRes.flame.flameStage,
    runOnQuality: bandRunOnQuality(scalpRes.flame.runOnTrace?.qualityScore ?? null),
  };
}

// ── Governance input derivation ─────────────────────────────────────────────
// Direction to govern: explicit requested side wins, else derive from structure.
export function deriveGovernanceSide(
  requestedSide: "BUY" | "SELL" | null | undefined,
  bias: StructureBias,
): AdvisoryDirection {
  if (requestedSide === "BUY" || requestedSide === "SELL") return requestedSide;
  if (bias === "Bullish") return "BUY";
  if (bias === "Bearish") return "SELL";
  return "NEUTRAL";
}

// Confidence/risk numbers fed to governance: prefer the real scanner numbers,
// else fall back to a structure-derived estimate (never fabricated as "real").
export function deriveGovernanceScores(
  scannerScore: number | null,
  riskScore: number | null,
  confidence: StructureConfidence,
): { confNum: number; riskNum: number } {
  const confNum =
    scannerScore ?? (confidence === "High" ? 80 : confidence === "Medium" ? 60 : 40);
  const riskNum = riskScore ?? Math.max(0, 100 - confNum);
  return { confNum, riskNum };
}

// ── Orchestrator ────────────────────────────────────────────────────────────
// A single dependency callback per real signal. The caller wires the production
// implementations (live scanner, scalp engine, advisory -> Traffic -> Court). The
// orchestrator owns ONLY the fail-open + selection/banding/mapping wiring, so the
// route stays thin and this logic is fully unit-testable with injected deps.
export interface SetupSignalsDeps {
  scoreLiveCandidates: (symbols: string[], limit: number) => Promise<LiveScannerResult>;
  evaluateScalpForSymbol: () => Promise<ScalpResult>;
  /**
   * Runs the real advisory -> Traffic -> Court flow and returns the Court outcome
   * + user-safe cautions, or null when no governance applied (shadow / no
   * influencing agents). The raw outcome is mapped here via mapGovernanceVerdict.
   */
  runGovernance: (args: {
    side: AdvisoryDirection;
    confNum: number;
    riskNum: number;
  }) => Promise<{ outcome: GovernanceOutcome; cautions: string[] } | null>;
}

export interface AssembleSetupSignalsInput {
  symbol: string;
  timeframe: string;
  requestedSide: "BUY" | "SELL" | null | undefined;
  bias: StructureBias;
  confidence: StructureConfidence;
}

export async function assembleSetupSignals(
  input: AssembleSetupSignalsInput,
  deps: SetupSignalsDeps,
): Promise<SetupSignals> {
  const { symbol, timeframe } = input;

  // Scanner + scalp run in parallel; either failing degrades that signal to null.
  const [scannerRes, scalpRes] = await Promise.all([
    deps.scoreLiveCandidates([symbol], 10).catch(() => null),
    deps.evaluateScalpForSymbol().catch(() => null),
  ]);

  const { scannerScore, riskScore, scannerTimeframe } = deriveScannerSignals(
    scannerRes,
    symbol,
    timeframe,
  );
  const { flameStage, runOnQuality } = deriveFlameSignals(scalpRes);

  let governanceOutcome: GovernanceVerdict | null = null;
  let governanceCautions: string[] = [];
  try {
    const side = deriveGovernanceSide(input.requestedSide, input.bias);
    const { confNum, riskNum } = deriveGovernanceScores(
      scannerScore,
      riskScore,
      input.confidence,
    );
    const gov = await deps.runGovernance({ side, confNum, riskNum });
    if (gov) {
      governanceOutcome = mapGovernanceVerdict(gov.outcome);
      governanceCautions = gov.cautions;
    }
  } catch {
    // advisory + governance are best-effort; never fail the drawing.
  }

  return {
    scannerScore,
    scannerTimeframe,
    riskScore,
    flameStage,
    runOnQuality,
    governanceOutcome,
    governanceCautions,
  };
}
