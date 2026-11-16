// ═══════════════════════════════════════════════════════════════════════════
// /api/execution — Phase 4 Execution Realism endpoints.
//
// All endpoints are ADVISORY ONLY. They return execution risk assessments
// and replay comparisons. They cannot place trades and never mutate
// safety_core. Every assessment writes to the Black Box Vault.
// ═══════════════════════════════════════════════════════════════════════════

import { Router, type IRouter, type Request, type Response } from "express";
import { z } from "zod/v4";
import {
  OrderContextSchema,
  ExecutionConditionSnapshotSchema,
  ActualFillSchema,
  predictSlippage,
  checkSpread,
  predictFillProbability,
  checkLiquidityDepth,
  computeExecutionStress,
  assessBrokerReliability,
  reportOrderQuality,
  computeExecutionRiskScore,
  applyExecutionRiskToVerdict,
  compareExpectedVsActualFill,
  classifyBrokerHealth,
  CouncilVerdictLiteSchema,
} from "@workspace/domain/execution-microstructure";
import { shadowCapture } from "../lib/auditVault";

const router: IRouter = Router();

// ─── POST /api/execution/assess ─────────────────────────────────────────
// Runs the full microstructure pipeline and returns an ExecutionRiskScore.
// Optionally takes a council verdict to compute the post-execution-risk
// verdict + size multiplier (advisory — caller decides whether to use it).
//
// Vault events:
//   • EXECUTION_RISK_ASSESSED  — every call (severity by level)
//   • SPREAD_SPIKE             — when spread ratio > 2× avg
//   • LATENCY_ANOMALY          — when decisionLatencyMs ≥ 800
//   • BROKER_INSTABILITY       — when broker reliability < 0.55
//   • EXECUTION_FILL_ANOMALY   — when recommendedAction is HARD_BLOCK/SOFT_BLOCK
const AssessBodySchema = z.object({
  decisionId: z.string().min(1),
  order: OrderContextSchema,
  decisionLatencyMs: z.number().nonnegative(),
  broker: z.object({
    recentRejects: z.number().int().nonnegative(),
    recentRequotes: z.number().int().nonnegative(),
    recentTotalOrders: z.number().int().nonnegative(),
    recentLatencyMs: z.number().nonnegative(),
  }).strict(),
  councilVerdict: CouncilVerdictLiteSchema.optional(),
  baseSizeMultiplier: z.number().min(0).max(1).optional(),
}).strict();

router.post("/execution/assess", async (req: Request, res: Response) => {
  let body: z.infer<typeof AssessBodySchema>;
  try { body = AssessBodySchema.parse(req.body); }
  catch (err) {
    res.status(400).json({ error: "invalid body", detail: String(err) });
    return;
  }

  const order = body.order;
  const slippage  = predictSlippage(order);
  const spread    = checkSpread({ order });
  const fill      = predictFillProbability(order);
  const liquidity = checkLiquidityDepth({ order });
  const stress    = computeExecutionStress(order);
  const broker    = assessBrokerReliability({ brokerId: order.brokerId, ...body.broker });
  const quality   = reportOrderQuality({ order, slippage, spread, fill, liquidity, stress, broker });
  const riskScore = computeExecutionRiskScore({
    order, spread, fill, liquidity, slippage, stress, broker,
    latencyMs: body.decisionLatencyMs,
  });

  let postExecutionVerdict: ReturnType<typeof applyExecutionRiskToVerdict> | null = null;
  if (body.councilVerdict) {
    postExecutionVerdict = applyExecutionRiskToVerdict(
      body.councilVerdict,
      riskScore,
      body.baseSizeMultiplier ?? 1,
    );
  }

  const brokerHealth = classifyBrokerHealth(broker.reliability01, broker.recentRejectsRate01);

  // ── Vault events ──────────────────────────────────────────────────────
  const sev: "INFO" | "WARN" | "DANGER" =
      riskScore.level === "CRITICAL" ? "DANGER"
    : riskScore.level === "HIGH"     ? "DANGER"
    : riskScore.level === "ELEVATED" ? "WARN"
    : "INFO";

  await shadowCapture({
    source: "EXECUTION_REALISM", systemMode: null, globalState: null,
    eventType: "EXECUTION_RISK_ASSESSED", severity: sev,
    payload: {
      decisionId: body.decisionId, symbolId: order.symbolId, brokerId: order.brokerId,
      score01: riskScore.score01, level: riskScore.level,
      recommendedAction: riskScore.recommendedAction,
      recommendedSizeMultiplier: riskScore.recommendedSizeMultiplier,
      decisionLatencyMs: body.decisionLatencyMs,
      spreadAtEntryPips: order.spreadPips,
      brokerHealthStatus: brokerHealth.status,
      components: riskScore.components,
      postExecutionVerdict: postExecutionVerdict?.verdict ?? null,
      postExecutionDowngraded: postExecutionVerdict?.downgraded ?? false,
    },
  });

  if (spread.spreadRatio > 2) {
    await shadowCapture({
      source: "EXECUTION_REALISM", systemMode: null, globalState: null,
      eventType: "SPREAD_SPIKE", severity: spread.spreadRatio > 4 ? "DANGER" : "WARN",
      payload: { decisionId: body.decisionId, symbolId: order.symbolId, ratio: spread.spreadRatio,
                 currentPips: order.spreadPips, avgPips: order.avgSpreadPips },
    });
  }
  if (body.decisionLatencyMs >= 800) {
    await shadowCapture({
      source: "EXECUTION_REALISM", systemMode: null, globalState: null,
      eventType: "LATENCY_ANOMALY", severity: body.decisionLatencyMs >= 1500 ? "DANGER" : "WARN",
      payload: { decisionId: body.decisionId, latencyMs: body.decisionLatencyMs },
    });
  }
  if (broker.reliability01 < 0.55) {
    await shadowCapture({
      source: "EXECUTION_REALISM", systemMode: null, globalState: null,
      eventType: "BROKER_INSTABILITY", severity: broker.reliability01 < 0.40 ? "DANGER" : "WARN",
      payload: { decisionId: body.decisionId, brokerId: order.brokerId,
                 reliability01: broker.reliability01, status: brokerHealth.status,
                 rejectsRate01: broker.recentRejectsRate01 },
    });
  }
  if (riskScore.recommendedAction === "HARD_BLOCK" || riskScore.recommendedAction === "SOFT_BLOCK") {
    await shadowCapture({
      source: "EXECUTION_REALISM", systemMode: null, globalState: null,
      eventType: "EXECUTION_FILL_ANOMALY",
      severity: riskScore.recommendedAction === "HARD_BLOCK" ? "DANGER" : "WARN",
      payload: { decisionId: body.decisionId, action: riskScore.recommendedAction,
                 blockers: riskScore.blockers, level: riskScore.level },
    });
  }

  res.json({
    ok: true,
    canPlaceTrades: false,
    decisionId: body.decisionId,
    riskScore,
    quality,
    brokerHealth,
    components: {
      slippage, spread, fill, liquidity, stress, broker,
    },
    postExecutionVerdict,
  });
});

// ─── POST /api/execution/replay-compare ──────────────────────────────────
// Compare an ExecutionConditionSnapshot (captured at decision time) with an
// ActualFill (captured after the broker reports back). Logs
// EXECUTION_FILL_ANOMALY at MAJOR/SEVERE deviation. Never places trades.
const ReplayBodySchema = z.object({
  snapshot: ExecutionConditionSnapshotSchema,
  actual: ActualFillSchema,
  actualQualityScore01: z.number().min(0).max(1).optional(),
}).strict();
router.post("/execution/replay-compare", async (req: Request, res: Response) => {
  let body: z.infer<typeof ReplayBodySchema>;
  try { body = ReplayBodySchema.parse(req.body); }
  catch (err) {
    res.status(400).json({ error: "invalid body", detail: String(err) });
    return;
  }
  const comparison = compareExpectedVsActualFill(body);

  if (comparison.deviation === "MAJOR" || comparison.deviation === "SEVERE") {
    await shadowCapture({
      source: "EXECUTION_REALISM", systemMode: null, globalState: null,
      eventType: "EXECUTION_FILL_ANOMALY",
      severity: comparison.deviation === "SEVERE" ? "DANGER" : "WARN",
      payload: {
        decisionId: comparison.decisionId,
        deviation: comparison.deviation,
        slippageDeltaPips: comparison.slippageDeltaPips,
        latencyDeltaMs: comparison.latencyDeltaMs,
        fillRatio01: comparison.fillRatio01,
        qualityDelta01: comparison.qualityDelta01,
        anomalies: comparison.anomalies,
      },
    });
  } else {
    // Always log the comparison itself (INFO) for replay/audit trail.
    await shadowCapture({
      source: "EXECUTION_REALISM", systemMode: null, globalState: null,
      eventType: "EXECUTION_REPLAY_COMPARED", severity: "INFO",
      payload: {
        decisionId: comparison.decisionId,
        deviation: comparison.deviation,
        slippageDeltaPips: comparison.slippageDeltaPips,
        latencyDeltaMs: comparison.latencyDeltaMs,
      },
    });
  }

  res.json({ ok: true, canPlaceTrades: false, comparison });
});

export default router;
