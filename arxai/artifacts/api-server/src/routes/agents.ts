// Phase 3 — AI Trading Council route.
//
// POST /api/agents/council/evaluate
//   Body: { setup, market?, account?, execution?, behavior?, news?, policy? }
//
// Runs the council pipeline (12 agents → Red/Blue debate → judge → 7-verdict
// mapper → explanation). The council CANNOT place trades. Risk Governor
// keeps final veto. Control Tower keeps mode control.
//
// Every agent vote, blocker, debate report, disagreement score, judge
// verdict, and explanation is persisted to the Black Box Vault via the
// existing shadowCapture() entry point.

import { Router, type IRouter, type Request, type Response } from "express";
import { z } from "zod/v4";
import { randomBytes } from "node:crypto";
import {
  runCouncil,
  gradeAgent,
  staleDecisionGuard,
  checkVoteExpiration,
  runAgentShadow,
  detectAgentDrift,
  CONTRACT_SCHEMA_VERSION,
  AgentOutputContractSchema,
  type AgentSystemSnapshot,
  type AgentCouncilVote,
} from "@workspace/domain/agent-system";
import { shadowCapture } from "../lib/auditVault";

const router: IRouter = Router();

// ── Body schema (everything but `setup` is optional / has defaults) ──────
const SetupSchema = z.object({
  symbol: z.string(),
  direction: z.enum(["BUY", "SELL"]),
  intendedEntryPrice: z.number(),
  stopLoss: z.number(),
  takeProfit: z.number().nullable().optional(),
  lotSize: z.number().positive(),
  proposedRiskPct: z.number().nonnegative(),
  pipSize: z.number().positive(),
});

// Strict schemas for every override field. Anything optional defaults to a
// safe value; anything supplied must be the right TYPE — otherwise we 400
// rather than crashing the council with a force-cast.
const Dir = z.enum(["BUY", "SELL"]);
const Session = z.enum(["ASIA", "LONDON", "NY", "OFF_HOURS"]);
const Severity = z.enum(["LOW", "MEDIUM", "HIGH"]);
const Emotion = z.enum(["CALM", "FOCUSED", "CAUTIOUS", "FRUSTRATED", "TILT"]);

const MarketOverride = z.object({
  symbol: z.string(),
  currentPrice: z.number(), bid: z.number(), ask: z.number(),
  spreadPips: z.number(), volatilityNow: z.number(),
  sessionStress01: z.number(), marketOpen: z.boolean(),
  liquidityScore01: z.number(),
  trendBiasSigned: z.number(), momentumSigned: z.number(),
  recentStructureBreak: Dir.nullable(),
  unsweptLiquiditySide: Dir.nullable(),
  pipsToNearestSwing: z.number(), emaConfluence01: z.number(),
}).partial();

const AccountOverride = z.object({
  balance: z.number(), equity: z.number(),
  openTradesCount: z.number().int(),
  drawdownPct: z.number(), dailyPnLPct: z.number(),
}).partial();

const ExecutionOverride = z.object({
  brokerConnected: z.boolean(),
  lastFillSlippagePips: z.number().nullable(),
  recentRejectionRate01: z.number(),
}).partial();

const BehaviorOverride = z.object({
  emotionalState: Emotion,
  consecutiveLosses: z.number().int(),
  consecutiveWins: z.number().int(),
  minutesSinceLastTrade: z.number().nullable(),
}).partial();

const NewsOverride = z.object({
  upcomingEvents: z.array(z.object({
    title: z.string(), severity: Severity,
    minutesUntil: z.number(), affectsSymbol: z.boolean(),
  })),
  blackoutMinutesBeforeHigh: z.number(),
  blackoutMinutesAfterHigh: z.number(),
}).partial();

const PolicyOverride = z.object({
  maxConcurrentTrades: z.number().int(),
  maxDrawdownPct: z.number(),
  dailyLossLimitPct: z.number(),
  maxSingleTradeRiskPct: z.number(),
  cooldownMinutesAfterLoss: z.number(),
  maxConsecutiveLossesBeforeBlock: z.number().int(),
  maxSpreadPipsPolicy: z.number(),
  minLiquidity01: z.number(),
  slippagePipsBudget: z.number(),
  symbolPreferredSessions: z.array(Session),
  currentSession: Session,
  volHistorical: z.object({ median: z.number(), p10: z.number(), p90: z.number() }).nullable(),
  historicalMatches: z.object({
    matchCount: z.number().int(), winRate01: z.number(),
    averagePnlR: z.number(), averageSimilarity01: z.number(),
  }),
  regime: z.object({
    currentRegimeId: z.string(), currentRegimeHealth01: z.number(),
    regimeChangedRecently: z.boolean(), regimeDriftSigma: z.number(),
  }),
  systemHealth: z.object({
    recentDisagreementRate01: z.number(), recentFalseVetoRate01: z.number(),
    shadowSampleSize: z.number().int(),
    recentManualOverrideCount: z.number().int(),
    recentIgnoredExitWarningCount: z.number().int(),
    recentEmergencyKillCount: z.number().int(),
  }),
}).partial();

const EvaluateBodySchema = z.object({
  setup: SetupSchema,
  market: MarketOverride.optional(),
  account: AccountOverride.optional(),
  execution: ExecutionOverride.optional(),
  behavior: BehaviorOverride.optional(),
  news: NewsOverride.optional(),
  policy: PolicyOverride.optional(),
});

// ── Snapshot defaults — safe, neutral values for any missing field ───────
function buildSnapshot(
  body: z.infer<typeof EvaluateBodySchema>,
  now: Date,
): AgentSystemSnapshot {
  const observedAt = now.toISOString();
  const defaults = {
    market: {
      symbol: body.setup.symbol,
      currentPrice: body.setup.intendedEntryPrice,
      bid: body.setup.intendedEntryPrice - body.setup.pipSize,
      ask: body.setup.intendedEntryPrice + body.setup.pipSize,
      spreadPips: 2,
      volatilityNow: 1,
      sessionStress01: 0.2,
      marketOpen: true,
      liquidityScore01: 0.8,
      trendBiasSigned: 0,
      momentumSigned: 0,
      recentStructureBreak: null,
      unsweptLiquiditySide: null,
      pipsToNearestSwing: 5,
      emaConfluence01: 0.5,
      observedAt,
    },
    account: {
      balance: 10000, equity: 10000, openTradesCount: 0,
      drawdownPct: 0, dailyPnLPct: 0, observedAt,
    },
    execution: {
      brokerConnected: true, lastFillSlippagePips: 0.5,
      recentRejectionRate01: 0, observedAt,
    },
    behavior: {
      emotionalState: "CALM" as const,
      consecutiveLosses: 0, consecutiveWins: 0,
      minutesSinceLastTrade: 60, observedAt,
    },
    news: {
      upcomingEvents: [],
      blackoutMinutesBeforeHigh: 15,
      blackoutMinutesAfterHigh: 15,
      observedAt,
    },
    policy: {
      maxConcurrentTrades: 5, maxDrawdownPct: 5,
      dailyLossLimitPct: -3, maxSingleTradeRiskPct: 1.5,
      cooldownMinutesAfterLoss: 5, maxConsecutiveLossesBeforeBlock: 5,
      maxSpreadPipsPolicy: 25, minLiquidity01: 0.3, slippagePipsBudget: 3,
      symbolPreferredSessions: ["LONDON" as const, "NY" as const],
      currentSession: "LONDON" as const,
      volHistorical: { median: 1, p10: 0.5, p90: 1.5 },
      historicalMatches: { matchCount: 20, winRate01: 0.6, averagePnlR: 0.8, averageSimilarity01: 0.7 },
      regime: { currentRegimeId: "neutral", currentRegimeHealth01: 0.7, regimeChangedRecently: false, regimeDriftSigma: 0.5 },
      systemHealth: { recentDisagreementRate01: 0.2, recentFalseVetoRate01: 0.05, shadowSampleSize: 100, recentManualOverrideCount: 0, recentIgnoredExitWarningCount: 0, recentEmergencyKillCount: 0 },
    },
  };
  return {
    setup: { ...body.setup, takeProfit: body.setup.takeProfit ?? null },
    market: { ...defaults.market, ...(body.market ?? {}) } as AgentSystemSnapshot["market"],
    account: { ...defaults.account, ...(body.account ?? {}) } as AgentSystemSnapshot["account"],
    execution: { ...defaults.execution, ...(body.execution ?? {}) } as AgentSystemSnapshot["execution"],
    behavior: { ...defaults.behavior, ...(body.behavior ?? {}) } as AgentSystemSnapshot["behavior"],
    news: { ...defaults.news, ...(body.news ?? {}) } as AgentSystemSnapshot["news"],
    policy: { ...defaults.policy, ...(body.policy ?? {}) } as AgentSystemSnapshot["policy"],
    now,
  };
}

router.post("/agents/council/evaluate", async (req: Request, res: Response) => {
  let body: z.infer<typeof EvaluateBodySchema>;
  try { body = EvaluateBodySchema.parse(req.body); }
  catch (err) {
    res.status(400).json({ error: "invalid body", detail: String(err) });
    return;
  }

  const now = new Date();
  const decisionId = `cd_${now.getTime()}_${randomBytes(4).toString("hex")}`;
  const snap = buildSnapshot(body, now);

  let artifact;
  try { artifact = runCouncil(snap, decisionId); }
  catch (err) {
    req.log.error({ err: String(err) }, "council pipeline threw");
    res.status(500).json({ error: "council pipeline failed", detail: String(err) });
    return;
  }

  // ── Vault logging — every vote / blocker / debate / verdict / explanation ─
  // Best-effort; shadowCapture is fail-closed for privacy and never throws.
  const baseEnvelope = {
    source: "AGENT_COUNCIL" as const,
    systemMode: null, globalState: null,
  };

  // 1. AGENT_VOTE — one row per agent (12 total)
  for (const v of artifact.agentVotes) {
    await shadowCapture({
      ...baseEnvelope,
      eventType: "AGENT_VOTE",
      severity: v.blockers.length > 0 ? "WARN" : "INFO",
      payload: {
        decisionId, symbol: snap.setup.symbol,
        agentId: v.agentId, agentName: v.agentName, domain: v.domain,
        vote: v.vote, confidence01: v.confidence01,
        evidence: v.evidence, blockers: v.blockers, warnings: v.warnings,
        isCritical: v.isCritical, expiresAtIso: v.expiresAtIso,
      },
    });
  }

  // 2. AGENT_BLOCKER — one row per blocker (separate so they're queryable)
  for (const v of artifact.agentVotes) {
    for (const b of v.blockers) {
      await shadowCapture({
        ...baseEnvelope,
        eventType: "AGENT_BLOCKER",
        severity: v.isCritical ? "DANGER" : "WARN",
        payload: {
          decisionId, symbol: snap.setup.symbol,
          agentId: v.agentId, agentName: v.agentName,
          isCritical: v.isCritical, reason: b,
        },
      });
    }
  }

  // 2a-pre. AGENT_OUTPUT_INVALID — only when an agent's contract failed
  //         schema validation. Always DANGER because we then neutralize.
  for (const cv of artifact.contractValidations) {
    if (cv.valid) continue;
    await shadowCapture({
      ...baseEnvelope,
      eventType: "AGENT_OUTPUT_INVALID",
      severity: "DANGER",
      payload: {
        decisionId, symbol: snap.setup.symbol,
        agentId: cv.agentId, agentName: cv.agentName,
        agentVersion: cv.agentVersion, errors: cv.errors,
        schemaVersion: artifact.schemaVersion,
      },
    });
  }
  // 2a-cap. CONFIDENCE_CAPPED — only when a cap was actually applied.
  for (const cap of artifact.confidenceCaps) {
    if (!cap.applied) continue;
    await shadowCapture({
      ...baseEnvelope,
      eventType: "CONFIDENCE_CAPPED",
      severity: "WARN",
      payload: {
        decisionId, symbol: snap.setup.symbol,
        agentId: cap.agentId, agentName: cap.agentName,
        beforeConfidence01: cap.beforeConfidence01,
        afterConfidence01: cap.afterConfidence01,
        cap: cap.cap, reasons: cap.reasons,
      },
    });
  }
  // 2a-hal. HALLUCINATION_REJECTED — only when guard fired.
  for (const h of artifact.hallucinationChecks) {
    if (!h.rejected) continue;
    await shadowCapture({
      ...baseEnvelope,
      eventType: "HALLUCINATION_REJECTED",
      severity: "DANGER",
      payload: {
        decisionId, symbol: snap.setup.symbol,
        agentId: h.agentId, agentName: h.agentName,
        beforeVote: h.beforeVote, beforeConfidence01: h.beforeConfidence01,
        evidenceCount: h.evidenceCount, reason: h.reason,
      },
    });
  }
  // 2a-ev. EVIDENCE_MISSING — only when evidence-req downgrade fired.
  for (const e of artifact.evidenceChecks) {
    if (!e.enforced) continue;
    await shadowCapture({
      ...baseEnvelope,
      eventType: "EVIDENCE_MISSING",
      severity: "WARN",
      payload: {
        decisionId, symbol: snap.setup.symbol,
        agentId: e.agentId, agentName: e.agentName,
        beforeVote: e.beforeVote, afterVote: e.afterVote,
        reason: e.reason,
      },
    });
  }

  // 2b. AUTHORITY_DECISION — one row per agent (deterministic record of
  //     who has hard-block power and whose veto was effective).
  for (const a of artifact.authorityDecisions) {
    await shadowCapture({
      ...baseEnvelope,
      eventType: "AUTHORITY_DECISION",
      severity: a.vetoEffective ? "DANGER" : a.downgradedTo ? "WARN" : "INFO",
      payload: {
        decisionId, symbol: snap.setup.symbol,
        agentId: a.agentId, agentName: a.agentName,
        authorityLevel: a.authorityLevel, canHardBlock: a.canHardBlock,
        hadVeto: a.hadVeto, vetoEffective: a.vetoEffective,
        downgradedTo: a.downgradedTo, reason: a.reason,
      },
    });
  }

  // 2c. VOTE_EXPIRED — only emitted when a vote is actually stale.
  for (const e of artifact.voteExpirationChecks) {
    if (!e.expired) continue;
    await shadowCapture({
      ...baseEnvelope,
      eventType: "VOTE_EXPIRED",
      severity: e.isCritical ? "DANGER" : "WARN",
      payload: {
        decisionId, symbol: snap.setup.symbol,
        agentId: e.agentId, agentName: e.agentName,
        isCritical: e.isCritical,
        expiresAtIso: e.expiresAtIso, ageMs: e.ageMs,
        reason: e.reason,
      },
    });
  }

  // 3. AGENT_DEBATE — Red Team + Blue Team + disagreement
  await shadowCapture({
    ...baseEnvelope,
    eventType: "AGENT_DEBATE",
    severity: artifact.disagreementScore01 >= 0.6 ? "WARN" : "INFO",
    payload: {
      decisionId, symbol: snap.setup.symbol,
      disagreementScore01: artifact.disagreementScore01,
      redTeam: artifact.redTeam, blueTeam: artifact.blueTeam,
    },
  });

  // 3b. CONFLICT_RESOLUTION — severity classification + any forced verdict
  await shadowCapture({
    ...baseEnvelope,
    eventType: "CONFLICT_RESOLUTION",
    severity: artifact.conflictSeverity.level === "EXTREME" ? "DANGER"
      : artifact.conflictSeverity.level === "HIGH" || artifact.conflictSeverity.level === "MEDIUM" ? "WARN"
      : "INFO",
    payload: {
      decisionId, symbol: snap.setup.symbol,
      level: artifact.conflictSeverity.level,
      disagreement01: artifact.conflictSeverity.disagreement01,
      forcedVerdict: artifact.conflictSeverity.forcedVerdict,
      reason: artifact.conflictSeverity.reason,
    },
  });

  // 3c. BLOCKER_HIERARCHY — ranked list (one event with the full ranking)
  if (artifact.blockerHierarchy.length > 0) {
    await shadowCapture({
      ...baseEnvelope,
      eventType: "BLOCKER_HIERARCHY",
      severity: artifact.blockerHierarchy.some(b => b.severity === "DANGER") ? "DANGER" : "WARN",
      payload: {
        decisionId, symbol: snap.setup.symbol,
        blockers: artifact.blockerHierarchy,
      },
    });
  }

  // 3d. HARD_BLOCK_RESOLUTION — only when triggered
  if (artifact.hardBlockResolution.triggered) {
    await shadowCapture({
      ...baseEnvelope,
      eventType: "HARD_BLOCK_RESOLUTION",
      severity: "DANGER",
      payload: {
        decisionId, symbol: snap.setup.symbol,
        ...artifact.hardBlockResolution,
      },
    });
  }

  // 4. JUDGE_VERDICT — the council decision
  const decision = artifact.decision;
  await shadowCapture({
    ...baseEnvelope,
    eventType: "JUDGE_VERDICT",
    severity: decision.verdict === "HARD_BLOCK" ? "DANGER"
      : decision.verdict === "SOFT_BLOCK" || decision.verdict === "WAIT" ? "WARN"
      : "INFO",
    payload: {
      decisionId, symbol: snap.setup.symbol,
      verdict: decision.verdict,
      proposedDirection: decision.proposedDirection,
      confidence01: decision.confidence01,
      sizeMultiplier: decision.sizeMultiplier,
      reasoning: decision.reasoning,
      blockers: decision.blockers,
      warnings: decision.warnings,
      conditions: decision.conditions,
    },
  });

  // 5. JUDGE_EXPLANATION — human-readable rationale
  await shadowCapture({
    ...baseEnvelope,
    eventType: "JUDGE_EXPLANATION",
    severity: "INFO",
    payload: {
      decisionId, symbol: snap.setup.symbol,
      headline: artifact.explanation.headline,
      bullets: artifact.explanation.bullets,
      cautionFlags: artifact.explanation.cautionFlags,
    },
  });

  res.json({
    ok: true,
    canPlaceTrades: false,
    riskGovernorHasFinalVeto: true,
    artifact,
  });
});

// ── POST /api/agents/council/grade ───────────────────────────────────────
// Records the realised outcome of a prior council decision. For each agent
// vote supplied, computes a grade (A..F) + score delta and writes a
// CALIBRATION_RECORD event to the vault. Drives the accountability layer:
// agent scoring, confidence calibration, false-approval / false-block
// tracking. NEVER places trades.
const VoteEnum = z.enum(["STRONG_FOR", "FOR", "NEUTRAL", "AGAINST", "STRONG_AGAINST"]);
const OutcomeEnum = z.enum([
  "WIN", "LOSS", "BREAKEVEN", "SKIPPED", "BLOCKED_CORRECTLY", "BLOCKED_WRONGLY",
]);
const GradeBodySchema = z.object({
  decisionId: z.string().min(1),
  outcome: OutcomeEnum,
  pnlR: z.number().nullable().optional(),
  agentVotes: z.array(z.object({
    agentId: z.string(),
    agentName: z.string(),
    vote: VoteEnum,
    confidence01: z.number().min(0).max(1),
  })).min(1),
});

router.post("/agents/council/grade", async (req: Request, res: Response) => {
  let body: z.infer<typeof GradeBodySchema>;
  try { body = GradeBodySchema.parse(req.body); }
  catch (err) {
    res.status(400).json({ error: "invalid body", detail: String(err) });
    return;
  }

  const now = new Date();
  // Zod enums infer to exact literal unions matching AgentVote / TradeOutcome,
  // so no `as` casts are needed — types flow from validation directly.
  const records = body.agentVotes.map(av => gradeAgent({
    agentId: av.agentId, agentName: av.agentName,
    decisionId: body.decisionId,
    vote: av.vote,
    confidence01: av.confidence01,
    outcome: body.outcome,
    pnlR: body.pnlR ?? null,
    now,
  }));

  for (const r of records) {
    await shadowCapture({
      source: "AGENT_COUNCIL", systemMode: null, globalState: null,
      eventType: "CALIBRATION_RECORD",
      severity: r.grade === "F" ? "DANGER" : r.grade === "D" ? "WARN" : "INFO",
      payload: {
        decisionId: body.decisionId,
        agentId: r.agentId, agentName: r.agentName,
        vote: r.vote, confidence01: r.confidence01,
        outcome: r.outcome, pnlR: r.pnlR,
        scoreDelta: r.scoreDelta, grade: r.grade,
        rationale: r.rationale, recordedAtIso: r.recordedAtIso,
      },
    });
  }

  res.json({
    ok: true, canPlaceTrades: false,
    decisionId: body.decisionId,
    records,
  });
});

// ── POST /api/agents/council/shadow-compare ──────────────────────────────
// Runs the V2 council in the shadow of a supplied V1 decision. Returns the
// V2 artifact + a V1↔V2 comparison and writes a SHADOW_COMPARISON event
// (severity by disagreement). NEVER places trades.
const VerdictEnum = z.enum([
  "EXECUTE", "REDUCE_SIZE", "EXECUTE_IF",
  "WAIT", "MONITOR_ONLY", "SOFT_BLOCK", "HARD_BLOCK",
]);
const ShadowBodySchema = EvaluateBodySchema.extend({
  v1: z.object({
    verdict: VerdictEnum,
    confidence01: z.number().min(0).max(1),
  }),
});
router.post("/agents/council/shadow-compare", async (req: Request, res: Response) => {
  let body: z.infer<typeof ShadowBodySchema>;
  try { body = ShadowBodySchema.parse(req.body); }
  catch (err) {
    res.status(400).json({ error: "invalid body", detail: String(err) });
    return;
  }
  const decisionId = `shadow_${randomBytes(8).toString("hex")}`;
  const snap = buildSnapshot(body, new Date());
  const result = runAgentShadow(snap, decisionId, body.v1);

  await shadowCapture({
    source: "AGENT_COUNCIL", systemMode: null, globalState: null,
    eventType: "SHADOW_COMPARISON",
    severity: result.comparison.severity === "HIGH" ? "DANGER"
            : result.comparison.severity === "MEDIUM" ? "WARN"
            : result.comparison.severity === "LOW" ? "INFO" : "INFO",
    payload: {
      decisionId, symbol: snap.setup.symbol,
      v1: result.v1, v2: result.v2,
      comparison: result.comparison,
      schemaVersion: CONTRACT_SCHEMA_VERSION,
    },
  });

  const { canPlaceTrades: _omit, ...rest } = result;
  res.json({ ok: true, canPlaceTrades: false, ...rest });
});

// ── POST /api/agents/council/drift ───────────────────────────────────────
// Compares two AgentOutputContracts (baseline vs current) for the SAME
// agent. Logs DRIFT_DETECTED on any non-NONE drift. NEVER places trades.
// Uses the canonical strict AgentOutputContractSchema so the parsed body
// is structurally a real AgentOutputContract — no force-casts needed.
const DriftBodySchema = z.object({
  decisionId: z.string().min(1),
  baseline: AgentOutputContractSchema,
  current: AgentOutputContractSchema,
});
router.post("/agents/council/drift", async (req: Request, res: Response) => {
  let body: z.infer<typeof DriftBodySchema>;
  try { body = DriftBodySchema.parse(req.body); }
  catch (err) {
    res.status(400).json({ error: "invalid body", detail: String(err) });
    return;
  }
  if (body.baseline.agentId !== body.current.agentId) {
    res.status(400).json({ error: "baseline and current must be for the same agentId" });
    return;
  }
  const report = detectAgentDrift(body.baseline, body.current);
  if (report.drifted) {
    await shadowCapture({
      source: "AGENT_COUNCIL", systemMode: null, globalState: null,
      eventType: "DRIFT_DETECTED",
      severity: report.severity === "HIGH" ? "DANGER"
              : report.severity === "MEDIUM" ? "WARN" : "INFO",
      payload: {
        decisionId: body.decisionId,
        baselineVersion: body.baseline.agentVersion,
        currentVersion: body.current.agentVersion,
        ...report,
      },
    });
  }
  res.json({ ok: true, canPlaceTrades: false, decisionId: body.decisionId, report });
});

// ── POST /api/agents/council/check-staleness ─────────────────────────────
// Re-evaluates a previously-issued council artifact's vote expirations
// against the CURRENT clock. Lets downstream consumers verify, at the
// moment of acting, that no critical vote has gone stale since the council
// run. Logs one VOTE_EXPIRED event per stale vote and one STALE_GUARD event
// summarising the outcome. NEVER places trades.
const StalenessBodySchema = z.object({
  decisionId: z.string().min(1),
  votes: z.array(z.object({
    agentId: z.string(),
    agentName: z.string(),
    isCritical: z.boolean(),
    expiresAtIso: z.string(),
  })).min(1),
});

router.post("/agents/council/check-staleness", async (req: Request, res: Response) => {
  let body: z.infer<typeof StalenessBodySchema>;
  try { body = StalenessBodySchema.parse(req.body); }
  catch (err) {
    res.status(400).json({ error: "invalid body", detail: String(err) });
    return;
  }

  const now = new Date();
  // Re-shape into the AgentCouncilVote subset needed by checkVoteExpiration.
  const minimalVotes = body.votes.map(v => ({
    agentId: v.agentId, agentName: v.agentName,
    domain: "unknown", vote: "NEUTRAL" as const, confidence01: 0,
    evidence: [], blockers: [], warnings: [],
    isCritical: v.isCritical, expiresAtIso: v.expiresAtIso,
  })) satisfies AgentCouncilVote[];

  const checks = checkVoteExpiration(minimalVotes, now);
  const guard = staleDecisionGuard(checks);

  for (const c of checks) {
    if (!c.expired) continue;
    await shadowCapture({
      source: "AGENT_COUNCIL", systemMode: null, globalState: null,
      eventType: "VOTE_EXPIRED",
      severity: c.isCritical ? "DANGER" : "WARN",
      payload: {
        decisionId: body.decisionId,
        agentId: c.agentId, agentName: c.agentName,
        isCritical: c.isCritical, expiresAtIso: c.expiresAtIso,
        ageMs: c.ageMs, reason: c.reason,
      },
    });
  }
  await shadowCapture({
    source: "AGENT_COUNCIL", systemMode: null, globalState: null,
    eventType: "STALE_GUARD",
    severity: guard.blockExecution ? "DANGER" : guard.hasStaleVotes ? "WARN" : "INFO",
    payload: { decisionId: body.decisionId, ...guard },
  });

  res.json({
    ok: true, canPlaceTrades: false,
    decisionId: body.decisionId,
    checks, guard,
  });
});

export default router;
