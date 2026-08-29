import {
  REQUIRED_SCORE, SCORE_WEIGHTS,
  type Blocker, type ConfidenceGateContext, type ConfidenceGateResult,
  type ConformalAdvisoryEvidence,
  type OverrideRecord, type Recommendation, type ReplayRecord, type ScoreReport,
} from "./confidenceGate.types";
import type { HorizonFrameEvidence } from "../horizons";
import { scoreStrategyEdge      } from "./strategyEdgeScore.engine";
import { scoreMarketRegime      } from "./marketRegimeScore.engine";
import { scoreMultiTimeframe    } from "./multiTimeframeScore.engine";
import { scoreExecutionQuality  } from "./executionQualityScore.engine";
import { scoreRiskApproval      } from "./riskApprovalScore.engine";
import { scoreTraderBehavior    } from "./traderBehaviorScore.engine";
import { scoreLiveValidation    } from "./liveValidationScore.engine";

// Hierarchy ranks — used for sorting blockers in user-facing messages and
// for enforcing "AI cannot override risk; risk cannot override broker".
const SEVERITY_RANK: Record<Blocker["severity"], number> = {
  BROKER: 100, RISK: 80, BEHAVIOR: 60, DATA: 40, AI: 20,
};

export function runConfidenceGate(ctx: ConfidenceGateContext): ConfidenceGateResult {
  const startedAt = (ctx.now ?? new Date()).getTime();
  const t0 = Date.now();

  const reports: ScoreReport[] = [
    scoreStrategyEdge(ctx),
    scoreMarketRegime(ctx),
    scoreMultiTimeframe(ctx),
    scoreExecutionQuality(ctx),
    scoreRiskApproval(ctx),
    scoreTraderBehavior(ctx),
    scoreLiveValidation(ctx),
  ];

  // Validate weights sum to 100 (guards against accidental edits).
  const totalWeight = Object.values(SCORE_WEIGHTS).reduce((a, b) => a + b, 0);
  if (totalWeight !== 100) {
    throw new Error(`Confidence gate weights must sum to 100, got ${totalWeight}`);
  }

  const finalScore = Math.round(
    reports.reduce((acc, r) => acc + (r.score * r.weight) / 100, 0),
  );

  const allBlockers: Blocker[] = reports.flatMap((r) => r.blockers);
  const allWarnings: string[] = reports.flatMap((r) => r.warnings);

  // Sort blockers by severity (BROKER first) for the formatted output —
  // makes it obvious why a trade was blocked and which layer takes precedence.
  allBlockers.sort((a, b) => SEVERITY_RANK[b.severity] - SEVERITY_RANK[a.severity]);

  const hasHardBlocker = allBlockers.length > 0;
  const meetsScore = finalScore >= REQUIRED_SCORE;
  const approved = meetsScore && !hasHardBlocker;

  const recommendation: Recommendation = decideRecommendation(finalScore, hasHardBlocker);

  const formattedBlockers = allBlockers.map(
    (b) => `[${b.severity}][${b.dimension}] ${b.message}`,
  );

  const decidedAt = new Date(startedAt + (Date.now() - t0)).toISOString();

  return {
    approved,
    finalScore,
    requiredScore: REQUIRED_SCORE,
    blockers: formattedBlockers,
    warnings: allWarnings,
    scoreBreakdown: {
      strategyEdge:     reports.find((r) => r.dimension === "strategyEdge"    )!.score,
      marketRegime:     reports.find((r) => r.dimension === "marketRegime"    )!.score,
      multiTimeframe:   reports.find((r) => r.dimension === "multiTimeframe"  )!.score,
      executionQuality: reports.find((r) => r.dimension === "executionQuality")!.score,
      riskApproval:     reports.find((r) => r.dimension === "riskApproval"    )!.score,
      traderBehavior:   reports.find((r) => r.dimension === "traderBehavior"  )!.score,
      liveValidation:   reports.find((r) => r.dimension === "liveValidation"  )!.score,
    },
    recommendation,
    reports,
    signalId: String(ctx.signal.id),
    decidedAt,
    totalDurationMs: Date.now() - t0,
  };
}

function decideRecommendation(finalScore: number, hasHardBlocker: boolean): Recommendation {
  // Any blocker → BLOCK regardless of score.
  if (hasHardBlocker) return "BLOCK";
  if (finalScore >= REQUIRED_SCORE) return "ENTER";
  if (finalScore >= 85) return "WAIT";
  if (finalScore >= 70) return "REDUCE_RISK";
  return "BLOCK";
}

// ── Conformal advisory (capability #4) — evidence, never authority ─────────
// Attaches a lib/validation conformalGate verdict to a gate result as
// journal/display evidence. WIRING CONTRACT (the honest first integration —
// the venue-parity contract makes a new GATE KEY expensive, so this is an
// advisory field, not a gate):
//   - PURE COPY: returns a NEW result object; the input is not mutated.
//   - Every verdict-bearing field (approved, finalScore, blockers, warnings,
//     scoreBreakdown, recommendation, reports, requiredScore) is passed
//     through UNCHANGED, whatever the advisory says. An inadmissible
//     conformal verdict on an approved result stays approved — the advisory
//     is there for the journal and the operator's eyes, not for dispatch.
export function attachConformalAdvisory(
  result: ConfidenceGateResult,
  conformal: ConformalAdvisoryEvidence,
): ConfidenceGateResult {
  return {
    ...result,
    advisory: { ...result.advisory, conformal },
  };
}

// ── Horizon-frame advisory (capability #10) — evidence, never authority ────
// Rides the unified horizon frame (microstructure → capital, each with state
// age + reliability) on the gate result as journal/display evidence, exactly
// like the conformal advisory: PURE COPY, every verdict-bearing field passes
// through unchanged whatever the horizons say. Stale or unreliable horizons
// are for the operator's eyes and downstream caution — never for dispatch.
export function attachHorizonAdvisory(
  result: ConfidenceGateResult,
  horizons: HorizonFrameEvidence,
): ConfidenceGateResult {
  return {
    ...result,
    advisory: { ...result.advisory, horizons },
  };
}

// ── User override — produces an audit record. Does NOT mutate the result. ──
// "User override must be logged." The caller stores both the original
// ConfidenceGateResult and this OverrideRecord. Execution logic checks for
// the presence of a valid override; the gate itself never lies about its
// own verdict.
export function recordUserOverride(input: {
  result: ConfidenceGateResult;
  by: string;
  reason: string;
  confirmedBy?: string;
  now?: Date;
}): OverrideRecord {
  const now = input.now ?? new Date();
  const record: OverrideRecord = {
    resultDecidedAt: input.result.decidedAt,
    signalId: input.result.signalId,
    by: input.by,
    reason: input.reason,
    acknowledgedBlockers: input.result.blockers,
    acknowledgedScore: input.result.finalScore,
    overriddenAt: now.toISOString(),
    confirmedBy: input.confirmedBy ?? null,
  };
  return record;
}

// Caller asks: given the gate result + (optional) override, may execution
// proceed? Encodes the hierarchy: BROKER blockers can NEVER be overridden.
export function mayExecuteWithOverride(
  result: ConfidenceGateResult,
  override: OverrideRecord | null,
): { allowed: boolean; reasons: string[] } {
  if (result.approved) return { allowed: true, reasons: ["Gate APPROVED"] };
  if (!override) return { allowed: false, reasons: ["Gate BLOCKED and no override present"] };

  // Find any BROKER-severity blocker in the original report — never overridable
  const brokerBlocker = result.reports
    .flatMap((r) => r.blockers)
    .find((b) => b.severity === "BROKER");
  if (brokerBlocker) {
    return {
      allowed: false,
      reasons: [
        `Cannot override broker-level blocker: [${brokerBlocker.dimension}] ${brokerBlocker.message}`,
        "Broker execution failures are unoverridable per gate hierarchy",
      ],
    };
  }
  if (override.confirmedBy && override.confirmedBy === override.by) {
    return { allowed: false, reasons: ["confirmedBy must differ from by"] };
  }
  return {
    allowed: true,
    reasons: [
      `Override accepted by ${override.by}${override.confirmedBy ? ` (confirmed by ${override.confirmedBy})` : ""}`,
      `Reason: ${override.reason}`,
    ],
  };
}

// ── Replay record — every approved trade is captured for replay/review. ───
// Caller persists this verbatim. Includes a context fingerprint so replays
// can detect "input drift" between decision time and replay time.
export function buildReplayRecord(
  result: ConfidenceGateResult,
  ctx: ConfidenceGateContext,
): ReplayRecord {
  return {
    signalId: result.signalId,
    decidedAt: result.decidedAt,
    finalScore: result.finalScore,
    recommendation: result.recommendation,
    contextFingerprint: fingerprint(ctx),
    result,
  };
}

function fingerprint(ctx: ConfidenceGateContext): string {
  const parts = [
    `sig:${ctx.signal.id}`,
    `sym:${ctx.signal.symbol}`,
    `dir:${ctx.signal.direction ?? "-"}`,
    `conf:${ctx.signal.confidence}`,
    `bal:${ctx.account.account?.balance ?? 0}`,
    `open:${ctx.account.openTradeCount}`,
    `regime:${ctx.marketSnapshot.regime?.regime ?? "?"}`,
    `strat:${ctx.strategyStats.strategyName}`,
  ];
  // Tiny non-cryptographic hash so the fingerprint is stable & short.
  let h = 0;
  const s = parts.join("|");
  for (let i = 0; i < s.length; i++) h = ((h << 5) - h + s.charCodeAt(i)) | 0;
  return `${(h >>> 0).toString(36)}:${s}`;
}
