// AACI Decision service.
//
// Composes a full AaciDecision from a Shared Truth Snapshot using the pure
// domain engine (hard gate, freshness, conflicts, edge decay, master score,
// action resolver), then persists it best-effort. ADVISORY / OBSERVATION ONLY —
// never an execution gate, never on a hot path. AACI can only ADD caution.

import {
  AACI_HANDSHAKE_SYSTEMS,
  AACI_DEFAULT_STRATEGY_KIND,
  buildScoreBreakdown,
  computeEdgeDecay,
  computeFreshness,
  computeMasterScore,
  computeSpeedValidity,
  computeUncertaintyChannels,
  computeWaitAdvisory,
  detectConflictsAndCohesion,
  estimateChannelResolutionRates,
  evaluateAaciHardGate,
  isSignalExpired,
  resolveRecommendedAction,
  type AaciActorType,
  type AaciDecision,
  type AaciHandshake,
  type AaciHardGateFactors,
  type AaciRecommendedAction,
  type AaciSharedTruthSnapshot,
  type AaciStrategyKind,
  type AaciUncertaintyEvidence,
} from "@workspace/domain/aaci";
import { randomUUID } from "node:crypto";
import { db, aaciDecisions } from "@workspace/db";
import type { AaciTrustEntityType } from "@workspace/db";
import { logger } from "../logger.js";
import { getQuote } from "../marketDataLayer.js";
import { getLatestAaciLatencyRecords } from "./latencyMonitor.js";
import {
  getLearnedTrustForDecision,
  getUncertaintySampleEvidence,
} from "./learning/trustStore.js";
import { recordSpreadSample, getSpreadRelHistory } from "./spreadHistoryRecorder.js";
import {
  recordUncertaintyObservation,
  getResolutionPairs,
} from "./uncertaintyResolutionRecorder.js";

export interface BuildAaciDecisionInput {
  snapshot: AaciSharedTruthSnapshot;
  userId: number;
  actorType: AaciActorType;
  actorId?: string;
  actionRequested: string;
  symbol?: string;
  timeframe?: string;
  strategy?: AaciStrategyKind;
  // Age (ms) of the signal being acted on, for edge-decay. Default 0 (fresh).
  signalAgeMs?: number;
  persist?: boolean;
  // Security handshake (AACI Security Phase 2). True only when the per-action
  // security handshake POSITIVELY verified for a SENSITIVE action. Omitted for
  // advisory reads — those default to `true` (the handshake only ADDS caution
  // for sensitive flows; it never gates plain advisory reads). The downstream
  // 16-gate pipeline + per-user approval remain authoritative either way.
  securityHandshakePass?: boolean;
}

// Decisions where "wait one more bar" is a meaningful alternative — the
// gate-blocked / reconcile / admin outcomes are not wait-vs-act questions.
const WAIT_CAPABLE_ACTIONS = new Set<AaciRecommendedAction>([
  "ALLOW",
  "ALLOW_REDUCED_SIZE",
  "PREPARE_ONLY",
  "WAIT_FOR_CONFIRMATION",
  "WATCH_ONLY",
]);

// One bar's length for the decision's timeframe. Unknown timeframes use the
// one-minute floor — a modeling constant (the shortest bar the advisory
// reasons about), not a fabricated market fact; the journal records which
// timeframe the wait was computed for.
const BAR_MS: Record<string, number> = {
  M1: 60_000,
  M5: 5 * 60_000,
  M15: 15 * 60_000,
  M30: 30 * 60_000,
  H1: 60 * 60_000,
  H4: 4 * 60 * 60_000,
  D1: 24 * 60 * 60_000,
};
function barLengthMs(timeframe: string | undefined): number {
  if (!timeframe) return 60_000;
  return BAR_MS[timeframe.toUpperCase()] ?? 60_000;
}

// Compose the binary HARD_GATE factors from the snapshot. Genuine safety factors
// fail-open to caution (false) when unknown; agent-only factors (funded/active/
// autonomy) are not blockers for human actors and resolve to true.
function composeHardGateFactors(
  snapshot: AaciSharedTruthSnapshot,
  actorType: AaciActorType,
  feedFresh: boolean,
  securityHandshakePass: boolean | undefined,
): AaciHardGateFactors {
  const isAgent = actorType === "self_trade_agent";
  const risk = snapshot.risk;
  const lossLimitPass = risk
    ? !risk.dailyLossHit && !risk.weeklyLossHit && !risk.drawdownLimitHit
    : false;
  const live = snapshot.account.mode === "live";
  const balance = snapshot.account.balance ?? 0;

  return {
    // Security handshake (AACI Security Phase 2). Advisory reads omit this and
    // default to `true` — the handshake only ADDS a block for SENSITIVE flows
    // that explicitly supply a computed verdict. It never relaxes any other
    // factor and never bypasses the downstream 16-gate pipeline.
    securityHandshakePass: securityHandshakePass ?? true,
    // AACI is ADVISORY and never executes — the authoritative trade-permission
    // gate is the downstream 16-gate pipeline + per-user approval, which AACI
    // never bypasses. So an authenticated caller is "permitted" to receive an
    // advisory read by default; only an explicit per-user `canTrade=false`
    // withholds it. (Previously defaulted to admin-only when unknown, which
    // hard-failed every regular user with PERMISSION_MISSING.)
    permission: snapshot.user.canTrade ?? true,
    funded: isAgent ? Boolean(snapshot.selfTradeAgent?.funded) : true,
    active: isAgent ? Boolean(snapshot.selfTradeAgent?.active) : true,
    autonomyAllowed: isAgent ? Boolean(snapshot.selfTradeAgent?.active) : true,
    riskPass: risk?.hardPass ?? false,
    lossLimitPass,
    bridgeReady: snapshot.bridge.status === "connected",
    feedFresh,
    // Symbol tradability: not a hard unknown — only block on explicit evidence.
    symbolTradable: snapshot.heat?.bestAction
      ? !/AVOID|NO_TRADE|DO_NOT/i.test(snapshot.heat.bestAction)
      : true,
    allocationAvailable: live ? balance > 0 : true,
    // Execution-route health escalates to ALERT_ADMIN, so only fail it on
    // POSITIVE evidence the route is down (bridge assessed "unavailable").
    // A merely unknown/not-yet-wired bridge ("unknown") is NOT a route fault —
    // it surfaces as the calmer BRIDGE_NOT_READY → WATCH_ONLY instead.
    executionRouteReady:
      snapshot.bridge.executionRouteReady ?? snapshot.bridge.status !== "unavailable",
    auditReady: snapshot.audit?.auditReady ?? true,
  };
}

// Build per-system handshakes for the decision (advisory health rollup).
function buildHandshakes(snapshot: AaciSharedTruthSnapshot): AaciHandshake[] {
  const unavailable = new Set(snapshot.unavailableSystems ?? []);
  return AACI_HANDSHAKE_SYSTEMS.map((system): AaciHandshake => {
    const missing = unavailable.has(system);
    return {
      system,
      status: missing ? "MISSING" : "PASS",
      score: missing ? 0 : 100,
      message: missing ? `${system} could not be read this cycle.` : `${system} reachable.`,
      required: false,
    };
  });
}

/**
 * Build a full AaciDecision from a snapshot. Pure given a fixed `now`. Persists
 * best-effort when `persist` is true (default true) — a persistence failure
 * never affects the returned decision.
 */
export async function buildAaciDecision(input: BuildAaciDecisionInput): Promise<AaciDecision> {
  const { snapshot, userId, actorType, actionRequested } = input;
  const now = Date.now();
  const strategy = input.strategy ?? AACI_DEFAULT_STRATEGY_KIND;

  const freshness = computeFreshness(snapshot, now);
  const cohesion = detectConflictsAndCohesion(snapshot);
  const edge = computeEdgeDecay(input.signalAgeMs ?? 0, strategy);
  const speedValidity = computeSpeedValidity(edge.edgeDecay);

  const hardGateFactors = composeHardGateFactors(
    snapshot,
    actorType,
    !freshness.criticalStale,
    input.securityHandshakePass,
  );
  const hardGate = evaluateAaciHardGate(hardGateFactors);

  // Learned trust (L) + drift (D) sub-scores from real reconciled outcomes.
  // ADVISORY ONLY and fail-open: a missing row or any error yields the scoring
  // engine's neutral defaults, so learning can only ADD caution, never block.
  //
  // We fold every entity dimension whose trust key shares the decision's own
  // vocabulary — symbol, timeframe, and (for agent actors) the agent key — and
  // take the MOST CAUTIOUS reading across them (lowest trust/drift, excluded if
  // any is quarantined). Strategy trust is intentionally NOT consumed here: its
  // ingested key is the decision's setupType classifier, a different vocabulary
  // from `input.strategy` (AaciStrategyKind), so reading it would be dead wiring.
  const learnedScopeKeys: { entityType: AaciTrustEntityType; entityKey: string }[] = [];
  if (input.symbol) learnedScopeKeys.push({ entityType: "symbol", entityKey: input.symbol });
  if (input.timeframe) learnedScopeKeys.push({ entityType: "timeframe", entityKey: input.timeframe });
  if (actorType === "self_trade_agent" && input.actorId) {
    learnedScopeKeys.push({ entityType: "agent", entityKey: input.actorId });
  }

  let learned = { learnedTrustScore: 50, driftScore: 70, excluded: false };
  if (learnedScopeKeys.length > 0) {
    const readings = await Promise.all(
      learnedScopeKeys.map((k) =>
        getLearnedTrustForDecision({ entityType: k.entityType, entityKey: k.entityKey, userId: 0 }),
      ),
    );
    learned = readings.reduce((acc, r) => ({
      learnedTrustScore: Math.min(acc.learnedTrustScore, r.learnedTrustScore),
      driftScore: Math.min(acc.driftScore, r.driftScore),
      excluded: acc.excluded || r.excluded,
    }));
  }

  // ── Uncertainty-channel evidence (FAIL-CLOSED). Sample counts + learning
  // age come from the trust store; spread history from the in-process quote
  // recorder. Any unreadable input stays null → that channel takes its FULL
  // penalty in UNCERTAINTY_CONFIDENCE (adds caution, never confidence).
  const sampleEvidence = await getUncertaintySampleEvidence(
    learnedScopeKeys.map((k) => ({ ...k, userId: 0 })),
  );
  if (input.symbol) {
    // Feed the recorder with this cycle's quote (refused when the quote is
    // degenerate — bad quotes never become evidence).
    try {
      const q = getQuote(input.symbol);
      if (!q.isStale) recordSpreadSample(input.symbol, q.spread, q.mid, now);
    } catch {
      // A failed quote read is simply no new sample.
    }
  }
  const uncertaintyEvidence: AaciUncertaintyEvidence = {
    outcomeSampleCount: sampleEvidence.minEvidenceCount,
    spreadRelHistory: input.symbol
      ? getSpreadRelHistory(input.symbol, { nowMs: now })
      : null,
    learningAgeMs:
      sampleEvidence.newestOutcomeAtMs == null
        ? null
        : Math.max(0, now - sampleEvidence.newestOutcomeAtMs),
  };

  const breakdown = buildScoreBreakdown({
    snapshot,
    freshness,
    cohesion,
    latencyRecords: getLatestAaciLatencyRecords(),
    speedValidity,
    learnedTrustScore: learned.learnedTrustScore,
    driftScore: learned.driftScore,
    uncertaintyEvidence,
  });

  const finalScore = computeMasterScore(breakdown, hardGate.value);

  const recommendedAction: AaciRecommendedAction = resolveRecommendedAction({
    hardGatePass: hardGate.pass,
    hardGateFailureCodes: hardGate.failures.map((f) => f.code),
    finalScore,
    cohesion,
    speedState: edge.speedState,
    signalExpired: isSignalExpired(edge.speedState),
  });

  // ── Value-of-information (JOURNAL-ONLY). Record this cycle's uncertainty
  // decomposition (the recorder is the evidence base for resolution rates),
  // then, for WAIT-capable decisions, compute the wait-vs-act numbers. The
  // advisory NEVER changes recommendedAction or any gate. Without enough
  // recorded history the advisory is an honest INSUFFICIENT_HISTORY.
  let voiAdvisory: Record<string, unknown> | undefined;
  if (input.symbol) {
    try {
      const channels = computeUncertaintyChannels(snapshot, cohesion, uncertaintyEvidence);
      recordUncertaintyObservation(userId, input.symbol, channels, now);
      if (WAIT_CAPABLE_ACTIONS.has(recommendedAction)) {
        const advisory = computeWaitAdvisory({
          channels,
          resolutionRates: estimateChannelResolutionRates(getResolutionPairs()),
          halfLifeMs: edge.halfLifeMs,
          waitMs: barLengthMs(input.timeframe),
        });
        voiAdvisory = { ...advisory, timeframe: input.timeframe ?? null };
      }
    } catch (err) {
      logger.warn({ err }, "aaci: VOI advisory computation failed (journal-only, non-fatal)");
    }
  }

  const handshakes = buildHandshakes(snapshot);
  const staleInputs = freshness.staleSources;
  const systemConflicts = cohesion.conflicts.map((c) => c.code);

  const userFacingExplanation = buildUserExplanation(recommendedAction, hardGate.failures.map((f) => f.userMessage));
  const explanation = buildAdminExplanation(finalScore, recommendedAction, hardGate.failures.map((f) => f.code), systemConflicts, staleInputs);

  const decision: AaciDecision = {
    decisionId: randomUUID(),
    timestamp: new Date(now).toISOString(),
    actorType,
    actorId: input.actorId,
    symbol: input.symbol,
    timeframe: input.timeframe,
    actionRequested,
    hardGatePass: hardGate.pass,
    hardGateFailures: hardGate.failures.map((f) => f.code),
    dataFreshnessScore: breakdown.dataFreshnessScore,
    graphCohesionScore: breakdown.graphCohesionScore,
    riskAlignmentScore: breakdown.riskAlignmentScore,
    marketTruthScore: breakdown.marketTruthScore,
    speedLatencyScore: breakdown.speedLatencyScore,
    executionReadinessScore: breakdown.executionReadinessScore,
    driftScore: breakdown.driftScore,
    auditAlertReadinessScore: breakdown.auditAlertReadinessScore,
    learnedTrustScore: breakdown.learnedTrustScore,
    dataQualityScore: breakdown.dataQualityScore,
    uiConsistencyScore: breakdown.uiConsistencyScore,
    explainabilityScore: breakdown.explainabilityScore,
    speedValidity: breakdown.speedValidity,
    uncertaintyConfidence: breakdown.uncertaintyConfidence,
    dataLineageTrust: breakdown.dataLineageTrust,
    selfLearningIntegrity: breakdown.selfLearningIntegrity,
    finalAaciScore: finalScore,
    recommendedAction,
    explanation,
    userFacingExplanation,
    systemConflicts,
    staleInputs,
    requiredFollowUps: buildFollowUps(recommendedAction, cohesion.positionMismatch),
    handshakes,
    createdAuditEvent: false,
    ...(voiAdvisory ? { voiAdvisory } : {}),
  };

  if (input.persist !== false) {
    try {
      await db.insert(aaciDecisions).values({
        decisionId: decision.decisionId,
        userId,
        actorType: decision.actorType,
        actorId: decision.actorId ?? null,
        symbol: decision.symbol ?? null,
        timeframe: decision.timeframe ?? null,
        actionRequested: decision.actionRequested,
        hardGatePass: decision.hardGatePass,
        finalAaciScore: Math.round(decision.finalAaciScore),
        recommendedAction: decision.recommendedAction,
        decisionPayload: decision,
      });
      decision.createdAuditEvent = true;
    } catch (err) {
      logger.warn({ err }, "aaci: decision persistence failed (advisory, non-fatal)");
    }
  }

  return decision;
}

function buildUserExplanation(action: AaciRecommendedAction, userMessages: string[]): string {
  switch (action) {
    case "ALLOW":
      return "All systems are aligned and ready.";
    case "ALLOW_REDUCED_SIZE":
      return "Conditions look good, but a smaller size is wiser right now.";
    case "PREPARE_ONLY":
      return "Get ready — conditions aren't fully confirmed yet.";
    case "WAIT_FOR_CONFIRMATION":
      return "Hold for clearer confirmation before acting.";
    case "WATCH_ONLY":
      return "Watch only for now — conditions aren't favourable.";
    case "PROTECT_OPEN_TRADE":
      return "Focus on protecting your open trade.";
    case "EXIT_OR_REDUCE":
      return "Consider exiting or reducing your position.";
    case "RECONCILE_SYSTEM":
      return "Your positions need to be re-synced before any new action.";
    case "ALERT_ADMIN":
      return "A system needs attention; trading is paused for safety.";
    case "BLOCK":
      return userMessages[0] ?? "This action isn't available right now.";
    default:
      return "This action isn't available right now.";
  }
}

function buildAdminExplanation(
  score: number,
  action: AaciRecommendedAction,
  failureCodes: string[],
  conflicts: string[],
  stale: string[],
): string {
  const parts = [`AACI=${score.toFixed(1)} → ${action}`];
  if (failureCodes.length) parts.push(`hardGate:[${failureCodes.join(",")}]`);
  if (conflicts.length) parts.push(`conflicts:[${conflicts.join(",")}]`);
  if (stale.length) parts.push(`stale:[${stale.join(",")}]`);
  return parts.join(" | ");
}

function buildFollowUps(action: AaciRecommendedAction, positionMismatch: boolean): string[] {
  const followUps: string[] = [];
  if (action === "RECONCILE_SYSTEM" || positionMismatch) {
    followUps.push("Reconcile MT5 and app open-position state.");
  }
  if (action === "ALERT_ADMIN") followUps.push("Notify an administrator.");
  if (action === "WAIT_FOR_CONFIRMATION") followUps.push("Re-evaluate after the next confirmed signal.");
  return followUps;
}
