// ═══════════════════════════════════════════════════════════════════════════
// /api/trader-dna — Phase 5 Trader DNA endpoints.
//
// Advisory only. canPlaceTrades:false on every response. Vault-logs every
// behavior detection / risk recomputation. Never emits TRADE_* and never
// touches safety_core.
// ═══════════════════════════════════════════════════════════════════════════

import { Router, type IRouter, type Request, type Response } from "express";
import { z } from "zod/v4";
import {
  TradeSchema,
} from "@workspace/domain/trade";
import {
  TradeWithContextSchema,
  buildTraderProfile, computeTraderRiskScore,
  buildPersonalEdgeMap,
  analyzeSymbolPerformance,
  analyzeStrategyPerformanceByTrader,
  analyzeSessionPerformance,
  analyzeBehaviorPatterns,
  detectRevengeTrading,
  evaluateOvertrade,
  adjustRiskForBehavior,
  type TraderProfile,
} from "@workspace/domain/trader-dna";
import { shadowCapture } from "../lib/auditVault";

const router: IRouter = Router();

const RiskLimitsSchema = z.object({
  riskPerTradePct: z.number().min(0.01).max(10),
  maxDailyLossPct: z.number().min(0.1).max(50),
  maxWeeklyLossPct: z.number().min(0.1).max(50),
  maxTradesPerDay: z.number().int().min(1).max(100),
  maxOpenTrades: z.number().int().min(1).max(50),
  stopAfterLosingStreak: z.number().int().min(1).max(20),
  minConfidenceScore: z.number().min(0).max(100),
}).strict();

const ProfileBodySchema = z.object({
  id: z.string().min(1),
  name: z.string().min(1),
  trades: z.array(TradeSchema),
  windowDays: z.number().int().positive().optional(),
  contextTrades: z.array(TradeWithContextSchema).optional(), // optional richer history for edge map / strategy perf
  baselineLimits: RiskLimitsSchema.optional(),
}).strict();

router.post("/trader-dna/profile", async (req: Request, res: Response) => {
  let body: z.infer<typeof ProfileBodySchema>;
  try { body = ProfileBodySchema.parse(req.body); }
  catch (err) { res.status(400).json({ error: "invalid body", detail: String(err) }); return; }

  const profile: TraderProfile = buildTraderProfile({
    id: body.id, name: body.name, trades: body.trades, windowDays: body.windowDays,
  });
  const ctx = body.contextTrades ?? body.trades.map((t) => ({ ...t, strategyId: "UNKNOWN" }));

  const edgeMap = buildPersonalEdgeMap(ctx);
  const symbolPerf = analyzeSymbolPerformance(body.trades);
  const strategyPerf = analyzeStrategyPerformanceByTrader(ctx);
  const sessionPerf = analyzeSessionPerformance(body.trades);
  const behaviorReport = analyzeBehaviorPatterns(profile, {
    trades: body.trades, windowStart: new Date(0), windowEnd: new Date(),
  });
  const revenge = detectRevengeTrading(profile, body.trades);
  const overtrade = evaluateOvertrade(profile, body.trades);

  const traderRisk = computeTraderRiskScore({
    patterns: behaviorReport.hits, revenge, overtrade,
    personalEdgeScore01: edgeMap.personalEdgeScore01,
  });

  const adjustment = body.baselineLimits ? adjustRiskForBehavior({
    baseline: body.baselineLimits, patterns: behaviorReport.hits, revenge, overtrade,
  }) : null;

  await shadowCapture({
    source: "TRADER_DNA", systemMode: null, globalState: null,
    eventType: "TRADER_PROFILE_BUILT",
    severity: traderRisk.level === "CRITICAL" ? "CRITICAL" : traderRisk.level === "HIGH" ? "WARN" : "INFO",
    payload: {
      traderId: profile.id, sample: body.trades.length,
      traderRiskScore: traderRisk.score01,
      personalEdgeScore: edgeMap.personalEdgeScore01,
      permission: traderRisk.permission,
      recommendedAction: traderRisk.recommendedAction,
      revenge: revenge.detected, overtrade: overtrade.detected,
    },
  });
  if (revenge.detected) {
    await shadowCapture({
      source: "TRADER_DNA", systemMode: null, globalState: null,
      eventType: "REVENGE_DETECTED", severity: "WARN",
      payload: { traderId: profile.id, severity: revenge.severity, evidence: revenge.evidence },
    });
  }
  if (overtrade.detected) {
    await shadowCapture({
      source: "TRADER_DNA", systemMode: null, globalState: null,
      eventType: "OVERTRADE_DETECTED", severity: "WARN",
      payload: { traderId: profile.id, severity: overtrade.severity, ratio: overtrade.ratio },
    });
  }
  if (adjustment && adjustment.changes.length > 0) {
    await shadowCapture({
      source: "TRADER_DNA", systemMode: null, globalState: null,
      eventType: "PERSONAL_RISK_ADJUSTED", severity: "INFO",
      payload: { traderId: profile.id, changes: adjustment.changes, reasons: adjustment.appliedReasons },
    });
  }

  res.json({
    ok: true, canPlaceTrades: false,
    profile,
    edgeMap, symbolPerf, strategyPerf, sessionPerf,
    behaviorReport, revenge, overtrade,
    traderRiskScore: traderRisk,
    personalEdgeScore: edgeMap.personalEdgeScore01,
    recommendedPermissionLevel: traderRisk.permission,
    recommendedAction: traderRisk.recommendedAction,
    riskAdjustment: adjustment,
  });
});

const BehaviorScanBodySchema = z.object({
  id: z.string().min(1),
  trades: z.array(TradeSchema),
  baseline: z.object({
    baselineTradesPerDay: z.number().nonnegative(),
    baselineLotSize: z.number().nonnegative(),
    baselineWinRate: z.number().min(0).max(1),
    baselineAvgRMultiple: z.number(),
  }).strict(),
  // Manual override / filter-ignoring signal (Trader DNA spec: "manual override behavior")
  manualOverridesLastDay: z.number().int().nonnegative().optional(),
  manualOverridesBaselinePerDay: z.number().nonnegative().optional(),
}).strict();

// Derives a FILTER_IGNORING BehaviorPatternHit from manual-override frequency.
// Severity ladder relative to baseline:
//   ≥3× baseline (and ≥3 today) → CRITICAL
//   ≥2× baseline                → HIGH
//   ≥1.5×                       → MEDIUM
//   else                        → LOW (suppressed)
function detectFilterIgnoring(today: number, baseline: number): {
  pattern: "FILTER_IGNORING"; confidence: number; severity: "NONE"|"LOW"|"MEDIUM"|"HIGH"|"CRITICAL"; evidence: string[];
} | null {
  if (today < 3) return null;
  const base = Math.max(0.1, baseline);
  const ratio = today / base;
  let severity: "NONE"|"LOW"|"MEDIUM"|"HIGH"|"CRITICAL";
  if (ratio >= 3)        severity = "CRITICAL";
  else if (ratio >= 2)   severity = "HIGH";
  else if (ratio >= 1.5) severity = "MEDIUM";
  else                   return null;
  return {
    pattern: "FILTER_IGNORING",
    confidence: Math.min(100, Math.round(50 + 20 * Math.log2(ratio))),
    severity,
    evidence: [`${today} manual overrides today vs baseline ${base.toFixed(2)} (ratio ${ratio.toFixed(2)})`],
  };
}
router.post("/trader-dna/behavior-scan", async (req: Request, res: Response) => {
  let body: z.infer<typeof BehaviorScanBodySchema>;
  try { body = BehaviorScanBodySchema.parse(req.body); }
  catch (err) { res.status(400).json({ error: "invalid body", detail: String(err) }); return; }

  const profile: TraderProfile = {
    id: body.id, name: body.id, traits: [],
    ...body.baseline,
    observedPatterns: [], preferredSessions: [], avoidedSessions: [],
    lastUpdatedAt: new Date().toISOString(),
  };
  const behaviorReport = analyzeBehaviorPatterns(profile, {
    trades: body.trades, windowStart: new Date(0), windowEnd: new Date(),
  });
  const revenge = detectRevengeTrading(profile, body.trades);
  const overtrade = evaluateOvertrade(profile, body.trades);

  // Manual override detection (FILTER_IGNORING) — Trader DNA spec factor.
  if (body.manualOverridesLastDay !== undefined) {
    const hit = detectFilterIgnoring(
      body.manualOverridesLastDay,
      body.manualOverridesBaselinePerDay ?? 1,
    );
    if (hit) behaviorReport.hits.push(hit);
  }

  for (const hit of behaviorReport.hits) {
    if (hit.severity === "NONE" || hit.severity === "LOW") continue;
    await shadowCapture({
      source: "TRADER_DNA", systemMode: null, globalState: null,
      eventType: "BEHAVIOR_PATTERN_HIT",
      severity: hit.severity === "CRITICAL" ? "CRITICAL" : "WARN",
      payload: { traderId: profile.id, pattern: hit.pattern, severity: hit.severity, confidence: hit.confidence },
    });
  }
  res.json({ ok: true, canPlaceTrades: false, behaviorReport, revenge, overtrade });
});

const RiskAdjustBodySchema = z.object({
  baseline: RiskLimitsSchema,
  patterns: z.array(z.object({
    pattern: z.string(), confidence: z.number().min(0).max(100),
    severity: z.enum(["NONE","LOW","MEDIUM","HIGH","CRITICAL"]),
    evidence: z.array(z.string()),
  }).strict()).optional(),
  revenge: z.object({
    detected: z.boolean(),
    severity: z.enum(["NONE","LOW","MEDIUM","HIGH","CRITICAL"]),
    confidence: z.number(), evidence: z.array(z.string()),
    recommendation: z.string().nullable(),
    cooldownUntil: z.string().nullable(),
    triggeringLossId: z.union([z.string(), z.number()]).nullable(),
    followUpTrades: z.array(z.union([z.string(), z.number()])),
  }).strict().nullable().optional(),
  overtrade: z.object({
    detected: z.boolean(),
    severity: z.enum(["NONE","LOW","MEDIUM","HIGH","CRITICAL"]),
    confidence: z.number(), evidence: z.array(z.string()),
    recommendation: z.string().nullable(),
    tradesToday: z.number(), baseline: z.number(), ratio: z.number(),
    recommendBlock: z.boolean(),
  }).strict().nullable().optional(),
}).strict();
router.post("/trader-dna/risk-adjustment", async (req: Request, res: Response) => {
  let body: z.infer<typeof RiskAdjustBodySchema>;
  try { body = RiskAdjustBodySchema.parse(req.body); }
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  catch (err) { res.status(400).json({ error: "invalid body", detail: String(err) }); return; }

  const adjustment = adjustRiskForBehavior({
    baseline: body.baseline,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    patterns: (body.patterns ?? []) as any,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    revenge: (body.revenge ?? null) as any,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    overtrade: (body.overtrade ?? null) as any,
  });
  if (adjustment.changes.length > 0) {
    await shadowCapture({
      source: "TRADER_DNA", systemMode: null, globalState: null,
      eventType: "PERSONAL_RISK_ADJUSTED", severity: "INFO",
      payload: { changes: adjustment.changes, reasons: adjustment.appliedReasons },
    });
  }
  res.json({ ok: true, canPlaceTrades: false, adjustment });
});

export default router;
