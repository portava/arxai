import {
  APPROVAL_FLOOR,
  type ExecutionPyramidContext, type ExecutionPyramidResult,
  type PyramidCategory, type PyramidRecommendation,
  type PyramidReplayRecord, type PyramidScoreReport,
} from "./executionPyramid.types";
import { scoreRegimeAlignment        } from "./regimeAlignment.engine";
import { scoreMultiTimeframe         } from "./multiTimeframe.engine";
import { scoreLiquidityStructure     } from "./liquidityStructure.engine";
import { scoreEntryPrecision         } from "./entryPrecision.engine";
import { scoreVolatilityConditions   } from "./volatilityConditions.engine";
import { scoreSessionQuality         } from "./sessionQuality.engine";
import { scoreExecutionQuality       } from "./executionQuality.engine";
import { scoreRiskApproval           } from "./riskApproval.engine";
import { scoreHistoricalPatternMatch } from "./historicalPatternMatch.engine";
import { scoreTraderDnaApproval      } from "./traderDNAApproval.engine";

// ── Orchestrator: runs all 10 scorers, aggregates, builds the final result ──
//   • Each category contributes 0..10 → executionConfidence is sum 0..100
//   • Any blocker from any category → recommendation = BLOCK regardless
//   • approved iff (confidence ≥ APPROVAL_FLOOR && no blockers)
//   • Always returns a multi-line explanation listing every category
export function runExecutionPyramid(ctx: ExecutionPyramidContext): ExecutionPyramidResult {
  const startedAt = (ctx.now ?? new Date()).getTime();
  const t0 = Date.now();

  const reports: PyramidScoreReport[] = [
    scoreRegimeAlignment(ctx),
    scoreMultiTimeframe(ctx),
    scoreLiquidityStructure(ctx),
    scoreEntryPrecision(ctx),
    scoreVolatilityConditions(ctx),
    scoreSessionQuality(ctx),
    scoreExecutionQuality(ctx),
    scoreRiskApproval(ctx),
    scoreHistoricalPatternMatch(ctx),
    scoreTraderDnaApproval(ctx),
  ];

  // Each category contributes 0..10 (its score, weight is equal at 10 each).
  // Sum across 10 categories → 0..100 execution confidence.
  const confidence = Math.round(
    reports.reduce((acc, r) => acc + r.confidenceContribution, 0),
  );

  const blockers: string[] = reports.flatMap((r) =>
    r.blockers.map((m) => `[${r.category}] ${m}`),
  );
  const warnings: string[] = reports.flatMap((r) =>
    r.warnings.map((m) => `[${r.category}] ${m}`),
  );

  const hasHardBlocker = blockers.length > 0;
  const meetsFloor = confidence >= APPROVAL_FLOOR;
  const approved = meetsFloor && !hasHardBlocker;

  const recommendation = decideRecommendation(confidence, hasHardBlocker);
  const breakdown = breakdownOf(reports);
  const explanation = buildNarrative(reports, confidence, approved, recommendation);

  return {
    approved,
    executionConfidence: confidence,
    scoreBreakdown: breakdown,
    blockers,
    warnings,
    recommendation,
    explanation,
    reports,
    signalId: String(ctx.signal.id),
    decidedAt: new Date(startedAt + (Date.now() - t0)).toISOString(),
    totalDurationMs: Date.now() - t0,
  };
}

function decideRecommendation(confidence: number, hasBlocker: boolean): PyramidRecommendation {
  if (hasBlocker) return "BLOCK";
  if (confidence >= APPROVAL_FLOOR) return "EXECUTE";
  if (confidence >= 80) return "WAIT";
  if (confidence >= 70) return "REDUCE_RISK";
  return "BLOCK";
}

function breakdownOf(reports: PyramidScoreReport[]): Record<PyramidCategory, number> {
  // Build a fully-typed record so consumers get type safety on the keys.
  const out = {} as Record<PyramidCategory, number>;
  for (const r of reports) out[r.category] = r.score;
  return out;
}

// ── AI-style explanation: every category accounted for, every blocker quoted ──
function buildNarrative(
  reports: PyramidScoreReport[],
  confidence: number,
  approved: boolean,
  recommendation: PyramidRecommendation,
): string {
  const lines: string[] = [];
  lines.push(`Execution Pyramid: ${confidence}/100 (floor ${APPROVAL_FLOOR})`);
  lines.push(`Decision: ${recommendation}${approved ? " — approved" : ""}`);
  lines.push("");
  for (const r of reports) {
    lines.push(`• ${r.category} ${r.score}/10 — ${r.explanation}`);
    for (const b of r.blockers) lines.push(`    BLOCK: ${b}`);
    for (const w of r.warnings) lines.push(`    warn:  ${w}`);
  }
  return lines.join("\n");
}

// ── Replay log — every decision (approval OR rejection) gets stored ───────
// "All decisions must be stored in replay logs for future AI learning."
// The caller persists this verbatim; later, when the trade outcome is
// known, fillReplayOutcome re-emits the record with outcome attached so
// supervised learning can pair (decision → realised R).
export function buildReplayRecord(
  result: ExecutionPyramidResult,
  ctx: ExecutionPyramidContext,
): PyramidReplayRecord {
  return {
    signalId: result.signalId,
    decidedAt: result.decidedAt,
    approved: result.approved,
    executionConfidence: result.executionConfidence,
    recommendation: result.recommendation,
    contextFingerprint: fingerprint(ctx),
    result,
    outcomeR: null,
    outcomeRecordedAt: null,
  };
}

export function fillReplayOutcome(
  record: PyramidReplayRecord,
  outcomeR: number,
  now: Date = new Date(),
): PyramidReplayRecord {
  return { ...record, outcomeR, outcomeRecordedAt: now.toISOString() };
}

function fingerprint(ctx: ExecutionPyramidContext): string {
  const parts = [
    `sig:${ctx.signal.id}`,
    `sym:${ctx.signal.symbol}`,
    `dir:${ctx.signal.direction ?? "-"}`,
    `conf:${ctx.signal.confidence}`,
    `regime:${ctx.marketSnapshot.regime?.regime ?? "?"}`,
    `strat:${ctx.strategyStats.strategyName}`,
    `vol:${ctx.volatility.current.toFixed(0)}`,
    `sess:${ctx.session.current}`,
    `entry:${ctx.entry.actualEntry}`,
  ];
  let h = 0;
  const s = parts.join("|");
  for (let i = 0; i < s.length; i++) h = ((h << 5) - h + s.charCodeAt(i)) | 0;
  return `${(h >>> 0).toString(36)}:${s}`;
}
