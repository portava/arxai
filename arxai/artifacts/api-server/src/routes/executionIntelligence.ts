// ═══════════════════════════════════════════════════════════════════════════
// /api/execution-intel — Phase 4B Execution Intelligence + TCA endpoints.
//
// Advisory only. Cannot place trades. Vault-logs every decision.
// ═══════════════════════════════════════════════════════════════════════════

import { Router, type IRouter, type Request, type Response } from "express";
import { z } from "zod/v4";
import {
  PreTradeInputSchema,
  PostTradeInputSchema,
  BrokerIdSchema,
  estimatePreTradeCost,
  buildPostTradeExecutionReport,
  buildBrokerScorecard,
  buildExecutionLearningReport,
  selectOrderTactic,
  deriveExecutionRiskScoreFromPreTrade,
  deriveExecutionRiskScoreFromPostTrade,
  deriveExecutionHealth,
  type PostTradeExecutionReport,
} from "@workspace/domain/execution-intelligence";
import { shadowCapture } from "../lib/auditVault";

const router: IRouter = Router();

// In-memory rolling history (per-process). Source of truth is the Black Box
// Vault; this is a convenience cache for scorecard / learning endpoints.
const HISTORY_MAX = 500;
const reportHistory: PostTradeExecutionReport[] = [];
function pushHistory(r: PostTradeExecutionReport): void {
  reportHistory.push(r);
  if (reportHistory.length > HISTORY_MAX) reportHistory.shift();
}

// ─── POST /api/execution-intel/pre-trade-estimate ────────────────────────
router.post("/execution-intel/pre-trade-estimate", async (req: Request, res: Response) => {
  let body: z.infer<typeof PreTradeInputSchema>;
  try { body = PreTradeInputSchema.parse(req.body); }
  catch (err) { res.status(400).json({ error: "invalid body", detail: String(err) }); return; }

  const estimate = estimatePreTradeCost(body);
  const sev: "INFO" | "WARN" | "DANGER" =
      estimate.verdict === "EXECUTION_BLOCKED" ? "DANGER"
    : estimate.verdict === "EXECUTION_COSTLY"  ? "WARN"
    : "INFO";
  await shadowCapture({
    source: "EXECUTION_INTELLIGENCE", systemMode: null, globalState: null,
    eventType: "PRE_TRADE_COST_ESTIMATED", severity: sev,
    payload: {
      decisionId: body.decisionId, symbolId: body.symbolId, brokerId: body.brokerId,
      strategyId: body.strategyId, session: body.session,
      verdict: estimate.verdict, recommendation: estimate.recommendation,
      totalCostPips: estimate.expectedCost.totalCostPips,
      totalCostUsd: estimate.expectedCost.totalCostUsd,
      edgeAfterCostPips: estimate.edgeAfterCostPips,
      edgeDestroyed: estimate.edgeDestroyed,
    },
  });
  if (estimate.edgeDestroyed) {
    await shadowCapture({
      source: "EXECUTION_INTELLIGENCE", systemMode: null, globalState: null,
      eventType: "EXECUTION_EDGE_DESTROYED", severity: "DANGER",
      payload: {
        decisionId: body.decisionId, brokerId: body.brokerId,
        edgePips: body.expectedEdgePips,
        costPips: estimate.expectedCost.totalCostPips,
        blockers: estimate.blockers,
      },
    });
  }
  // Derive the named Phase 4 output that Risk Governor consumes via the
  // tradeGate's `executionRisk01` field. Pure derivation — no side-effects
  // here; the caller decides whether to forward it.
  const executionRiskScore = deriveExecutionRiskScoreFromPreTrade(estimate, body.expectedEdgePips);
  res.json({ ok: true, canPlaceTrades: false, estimate, executionRiskScore });
});

// ─── POST /api/execution-intel/post-trade-report ─────────────────────────
router.post("/execution-intel/post-trade-report", async (req: Request, res: Response) => {
  let body: z.infer<typeof PostTradeInputSchema>;
  try { body = PostTradeInputSchema.parse(req.body); }
  catch (err) { res.status(400).json({ error: "invalid body", detail: String(err) }); return; }

  const report = buildPostTradeExecutionReport(body);
  pushHistory(report);

  const sev: "INFO" | "WARN" | "DANGER" =
      report.verdict === "EXECUTION_BLOCKED" || report.verdict === "EXECUTION_UNSTABLE" ? "DANGER"
    : report.verdict === "EXECUTION_COSTLY" ? "WARN"
    : "INFO";
  await shadowCapture({
    source: "EXECUTION_INTELLIGENCE", systemMode: null, globalState: null,
    eventType: "POST_TRADE_REPORT", severity: sev,
    payload: {
      decisionId: report.decisionId,
      symbolId: report.symbolId, brokerId: report.brokerId,
      strategyId: report.strategyId, session: report.session,
      grade: report.grade, verdict: report.verdict, helpedOrHurt: report.helpedOrHurt,
      implementationShortfallPips: report.implementationShortfallPips,
      implementationShortfallUsd:  report.implementationShortfallUsd,
      effectiveSpreadPips: report.effectiveSpreadPips,
      realizedSpreadPips:  report.realizedSpreadPips,
      marketImpactPips:    report.marketImpactPips,
      arrivalPriceSlippagePips: report.arrivalPriceSlippagePips,
    },
  });

  await shadowCapture({
    source: "EXECUTION_INTELLIGENCE", systemMode: null, globalState: null,
    eventType: "EXECUTION_LEARNING_RECORDED", severity: "INFO",
    payload: {
      decisionId: report.decisionId,
      symbolId: report.symbolId, session: report.session, strategyId: report.strategyId,
      grade: report.grade, isPips: report.implementationShortfallPips,
    },
  });

  const executionRiskScore = deriveExecutionRiskScoreFromPostTrade(report);
  res.json({ ok: true, canPlaceTrades: false, report, executionRiskScore });
});

// ─── POST /api/execution-intel/broker-scorecard ──────────────────────────
const ScorecardBodySchema = z.object({ brokerId: BrokerIdSchema }).strict();
router.post("/execution-intel/broker-scorecard", async (req: Request, res: Response) => {
  let body: z.infer<typeof ScorecardBodySchema>;
  try { body = ScorecardBodySchema.parse(req.body); }
  catch (err) { res.status(400).json({ error: "invalid body", detail: String(err) }); return; }
  const scorecard = buildBrokerScorecard(body.brokerId, reportHistory);
  await shadowCapture({
    source: "EXECUTION_INTELLIGENCE", systemMode: null, globalState: null,
    eventType: "BROKER_SCORECARD_UPDATE",
    severity: scorecard.status === "LOCKDOWN" ? "DANGER"
            : scorecard.status === "UNSTABLE" ? "WARN" : "INFO",
    payload: {
      brokerId: body.brokerId, status: scorecard.status,
      reliability01: scorecard.reliability01,
      windowSize: scorecard.windowSize,
      rejectsRate01: scorecard.rejectsRate01,
      costlyRate01: scorecard.costlyRate01,
      recommendation: scorecard.recommendation,
    },
  });
  // Derive the named Phase 4 output that Control Tower consumes via
  // driveGlobalState's `executionRiskHigh` input.
  const executionHealth = deriveExecutionHealth(scorecard);
  res.json({ ok: true, canPlaceTrades: false, scorecard, executionHealth });
});

// ─── POST /api/execution-intel/learning-report ───────────────────────────
const EmptyBodySchema = z.object({}).strict();
router.post("/execution-intel/learning-report", async (req: Request, res: Response) => {
  try { EmptyBodySchema.parse(req.body ?? {}); }
  catch (err) { res.status(400).json({ error: "invalid body", detail: String(err) }); return; }
  const report = buildExecutionLearningReport(reportHistory);
  res.json({ ok: true, canPlaceTrades: false, report });
});

// ─── POST /api/execution-intel/select-tactic ─────────────────────────────
const SelectTacticBodySchema = z.object({
  preTrade: PreTradeInputSchema,
  brokerId: BrokerIdSchema,
}).strict();
router.post("/execution-intel/select-tactic", async (req: Request, res: Response) => {
  let body: z.infer<typeof SelectTacticBodySchema>;
  try { body = SelectTacticBodySchema.parse(req.body); }
  catch (err) { res.status(400).json({ error: "invalid body", detail: String(err) }); return; }
  const estimate = estimatePreTradeCost(body.preTrade);
  const scorecard = buildBrokerScorecard(body.brokerId, reportHistory);
  const decision = selectOrderTactic({
    estimate, scorecard,
    spreadAtSignalPips: body.preTrade.spreadAtSignalPips,
    avgSpreadPips: body.preTrade.avgSpreadPips,
    newsActiveWindow: body.preTrade.newsActiveWindow,
    intendedSizeLots: body.preTrade.intendedSizeLots,
    topBookDepthLots: body.preTrade.topBookDepthLots,
  });
  await shadowCapture({
    source: "EXECUTION_INTELLIGENCE", systemMode: null, globalState: null,
    eventType: "ORDER_TACTIC_SELECTED",
    severity: decision.tactic === "CANCEL" ? "DANGER" : "INFO",
    payload: {
      decisionId: body.preTrade.decisionId, brokerId: body.brokerId,
      tactic: decision.tactic, limitOffsetPips: decision.limitOffsetPips,
      scheduleDelayMs: decision.scheduleDelayMs,
      preTradeVerdict: estimate.verdict, brokerStatus: scorecard.status,
    },
  });
  const executionRiskScore = deriveExecutionRiskScoreFromPreTrade(estimate, body.preTrade.expectedEdgePips);
  const executionHealth = deriveExecutionHealth(scorecard);
  res.json({ ok: true, canPlaceTrades: false, estimate, scorecard, decision, executionRiskScore, executionHealth });
});

// ─── Test-only reset ─────────────────────────────────────────────────────
// Gated to non-production envs; always returns canPlaceTrades:false; strict body.
router.post("/execution-intel/_test/reset-history", (req: Request, res: Response) => {
  if (process.env.NODE_ENV === "production") {
    res.status(404).json({ error: "not found", canPlaceTrades: false });
    return;
  }
  try { EmptyBodySchema.parse(req.body ?? {}); }
  catch (err) { res.status(400).json({ error: "invalid body", detail: String(err), canPlaceTrades: false }); return; }
  reportHistory.splice(0, reportHistory.length);
  res.json({ ok: true, canPlaceTrades: false });
});

export default router;
