// ── Profit Mission Phase 3 — Multi-Agent Proposal service ───────────────────
//
// Phase 3 fallback reconstruction from Task #662 spec.
//
// SAFETY / SCOPE:
//   - ADVISORY ARTIFACTS ONLY. This service seeds a mission's specialist agent
//     team and runs a scan that COMPOSES the EXISTING engines (marketScanner ->
//     aiBrain / strategyEngine, ARX Focus registry) into structured, read-only
//     proposal records. There is NO draft, NO approval-to-execute, NO order
//     placement, and nothing here touches the instant-trade router, live
//     pipeline, or MT5 bridge. The Risk reviewer + Execution Judge here only
//     ANNOTATE/SELECT proposals (pure domain logic); selection is never
//     execution. Agents fail-open to "no proposal".
//   - FEED HONESTY (Scanner Truth): a proposal is only minted as an actionable
//     setup from a real, selectable live feed. Simulator / awaiting / stale /
//     non-selectable rows yield an honest context-only record — never a
//     fabricated or simulator-derived setup.
//   - STRICTLY per-user / per-mission: every read/write is scoped by BOTH
//     mission_id AND user_id. The CALLER must have already verified the mission
//     belongs to the requesting user (ownMission gate); this service additionally
//     filters by user_id. No row from one user/mission is ever returned to
//     another.
//   - No parallel strategy logic: direction / confidence / entry / SL / TP all
//     originate from the existing scanner engine; this service never re-derives
//     them.
import { and, desc, eq } from "drizzle-orm";
import {
  db,
  profitMissionsTable,
  missionAgentsTable,
  missionProposalsTable,
  type MissionAgentRow,
  type MissionProposalRow,
} from "@workspace/db";
import {
  MISSION_AGENT_TEAM,
  agentProposesOn,
  assessRiskObjection,
  computeEdgeScore,
  rewardToRiskScore,
  routeOpportunities,
  computeMissionImpact,
  computeMissionMath,
  type AgentProposal,
  type EdgeScore,
  type EdgeInput,
  type EdgeFeedStatus,
  type MissionAgentKey,
  type OpportunityQueue,
  type RouterCandidate,
  type MissionImpact,
  type ProposalDirection,
  type ProposalUrgency,
  type RiskProfile,
  DEFAULT_MISSION_RISK_BUDGET,
} from "@workspace/domain/profit-mission";
import { isApprovedArxMarket } from "@workspace/domain/market";
import { annotateScanProposals, exposureBudgetFrom } from "./missionExecutionQuality.js";
import { reviewScannerOpportunities } from "./scannerReview.js";
import { scanSymbolTimeframe, type ScannerOpportunity } from "./marketScanner.js";
import { calculatePositionSize } from "./riskGovernor/positionSizer.js";

// Default discovery universe when a mission carries no explicit symbol list.
// Small, mixed-asset tier-1 set so each proposer has something in its focus.
const DEFAULT_SCAN_SYMBOLS = ["EURUSD", "GBPUSD", "XAUUSD", "V75"] as const;
const DEFAULT_SCAN_TIMEFRAME = "M15";
const MAX_SCAN_SYMBOLS = 12;

// A live feed the scanner deems selectable is the only source of an actionable
// proposal. Everything else (simulator / awaiting / stale) is context-only.
const ACTIONABLE_DATA_SOURCES: ReadonlySet<ScannerOpportunity["dataSource"]> = new Set([
  "LIVE_FEED",
]);

export interface MissionScanSettings {
  symbols: string[];
  timeframe: string;
}

/**
 * Read a mission's allowed scan symbols + timeframe from its free-form settings,
 * filtered through the ARX Focus registry (the single source of truth for the
 * approved universe). Falls back to a default tier-1 set. Pure, no IO.
 */
export function resolveMissionScanSettings(
  settings: Record<string, unknown> | null | undefined,
): MissionScanSettings {
  const raw = Array.isArray(settings?.symbols) ? (settings!.symbols as unknown[]) : [];
  const requested = raw
    .filter((s): s is string => typeof s === "string" && s.trim().length > 0)
    .map((s) => s.trim());
  const approved = (requested.length > 0 ? requested : [...DEFAULT_SCAN_SYMBOLS])
    .filter((s) => isApprovedArxMarket(s))
    .slice(0, MAX_SCAN_SYMBOLS);
  const symbols = approved.length > 0 ? approved : [...DEFAULT_SCAN_SYMBOLS];
  const tfRaw = typeof settings?.timeframe === "string" ? (settings!.timeframe as string) : "";
  const timeframe = tfRaw.trim().length > 0 ? tfRaw.trim().toUpperCase() : DEFAULT_SCAN_TIMEFRAME;
  return { symbols, timeframe };
}

/**
 * Idempotently seed (or refresh) the mission's specialist agent team. One row
 * per (mission, agentKey) — re-running is a no-op on conflict. Returns the team.
 */
export async function seedMissionTeam(
  missionId: number,
  userId: number,
): Promise<MissionAgentRow[]> {
  await db
    .insert(missionAgentsTable)
    .values(
      MISSION_AGENT_TEAM.map((a) => ({
        missionId,
        userId,
        agentKey: a.agentKey,
        registryAgentKey: a.registryAgentKey,
        name: a.name,
        role: a.role,
        status: "active",
      })),
    )
    .onConflictDoNothing({
      target: [missionAgentsTable.missionId, missionAgentsTable.agentKey],
    });
  return listMissionAgents(missionId, userId);
}

/** List a mission's agent team (caller must have passed the ownMission gate). */
export async function listMissionAgents(
  missionId: number,
  userId: number,
): Promise<MissionAgentRow[]> {
  return db
    .select()
    .from(missionAgentsTable)
    .where(and(eq(missionAgentsTable.missionId, missionId), eq(missionAgentsTable.userId, userId)));
}

/** List a mission's proposals, newest first (caller must own the mission). */
export async function listMissionProposals(
  missionId: number,
  userId: number,
  opts: { limit: number; offset: number },
): Promise<MissionProposalRow[]> {
  return db
    .select()
    .from(missionProposalsTable)
    .where(
      and(
        eq(missionProposalsTable.missionId, missionId),
        eq(missionProposalsTable.userId, userId),
      ),
    )
    .orderBy(desc(missionProposalsTable.createdAt), desc(missionProposalsTable.id))
    .limit(opts.limit)
    .offset(opts.offset);
}

function mapDirection(action: ScannerOpportunity["recommendedAction"]): ProposalDirection {
  if (action === "BUY") return "BUY";
  if (action === "SELL") return "SELL";
  return "NONE";
}

function mapUrgency(confidence: number): ProposalUrgency {
  if (confidence >= 75) return "high";
  if (confidence >= 55) return "medium";
  return "low";
}

/**
 * Map a scanner opportunity onto a draft AgentProposal (pre risk/judge review).
 * Honest by construction: a setup is only actionable on a selectable LIVE feed;
 * anything else becomes a context-only record explaining the honest state.
 */
export function opportunityToProposal(
  agentKey: MissionAgentKey,
  proposalId: string,
  opp: ScannerOpportunity,
): AgentProposal {
  const liveAndSelectable =
    ACTIONABLE_DATA_SOURCES.has(opp.dataSource) && opp.selectable && opp.tradeable;
  const actionable = liveAndSelectable && opp.finalRead?.label === "TRADE_WATCH" && !opp.finalRead.analysisOnly;
  const direction = actionable ? mapDirection(opp.recommendedAction) : "NONE";
  const waitReason = opp.finalRead?.headline ?? "Waiting for a final Scanner read.";
  const confidence = liveAndSelectable ? Math.max(0, Math.min(100, opp.confidenceScore)) : 0;
  const entry = direction === "BUY" ? opp.bidAsk?.ask ?? opp.entry : opp.bidAsk?.bid ?? opp.entry;
  const sign = direction === "BUY" ? 1 : -1;
  const risk = sign * (entry - opp.stopLoss);
  const target = opp.entryRoom?.target ?? opp.takeProfit;
  const reward = sign * (target - entry);
  const expectedR = direction !== "NONE" && risk > 0 && reward > 0 && Number.isFinite(reward / risk)
    ? reward / risk : null;
  const warnings: string[] = [];
  if (!liveAndSelectable) {
    warnings.push(
      opp.disabledReason ??
        `No confirmed live feed for ${opp.symbol} (${opp.dataSource}) — context only, no setup.`,
    );
  } else if (!actionable) {
    warnings.push(waitReason);
  } else if (opp.reasonToAvoid) {
    warnings.push(opp.reasonToAvoid);
  }
  return {
    proposalId,
    agentKey,
    symbol: opp.symbol,
    timeframe: opp.timeframe,
    direction,
    setupType: liveAndSelectable ? opp.setupType ?? null : null,
    confidence,
    urgency: mapUrgency(confidence),
    entryPlan: {
      entryPrice: direction !== "NONE" ? entry : null,
      entryZoneLow: null,
      entryZoneHigh: null,
    },
    riskPlan: {
      stopLoss: direction !== "NONE" ? opp.stopLoss : null,
      takeProfit: direction !== "NONE" ? target : null,
      riskAmount: null,
      expectedR,
    },
    reason: liveAndSelectable
      ? actionable
        ? opp.entryRoom?.defendedLevel != null
          ? `Take profit at defended ${direction === "BUY" ? "resistance" : "support"} at ${target}. Room from the executable entry is ${expectedR?.toFixed(2)}R.`
          : opp.reasonForTrade || "Setup scouted from live feed."
        : waitReason
      : `Awaiting a confirmed live feed for ${opp.symbol}.`,
    invalidationLevel: null,
    warnings,
    marketSnapshot: {
      bias: opp.bias,
      dataSource: opp.dataSource,
      dataStatus: opp.dataStatus,
      confidenceScore: opp.confidenceScore,
      riskRewardRatio: opp.riskRewardRatio,
      recommendedAction: opp.recommendedAction,
      scannerTarget: opp.takeProfit,
      defendedLevel: opp.entryRoom?.defendedLevel ?? null,
      finalRead: opp.finalRead?.label ?? null,
    },
    status: "proposed",
    riskObjection: null,
    judgeDecision: null,
    selectionReason: null,
    rejectionReason: null,
  };
}

// Honest feed-truth mapping: only a confirmed LIVE_FEED is a live edge; every
// other scanner data source caps/blocks the edge into context-only (Scanner
// Truth — the Edge Engine never mints an actionable edge from a feed we don't
// trust). Unknown sources are treated as awaiting (the safest non-live state).
function mapEdgeFeedStatus(dataSource: ScannerOpportunity["dataSource"]): EdgeFeedStatus {
  switch (dataSource) {
    case "LIVE_FEED":
      return "live";
    case "LIVE_DELAYED":
      return "delayed";
    case "STALE_FEED":
      return "stale";
    case "SIMULATOR":
      return "simulator";
    default:
      return "awaiting";
  }
}

/**
 * Compose a scanner opportunity onto the pure Edge Engine input. Components come
 * straight from scanner truth (no re-derivation); honest caps come from the feed
 * status. Spread/timing stay `unknown` unless the scanner positively reports a
 * bad regime. Measured same-timeframe tradeability contributes to the score.
 */
export function opportunityToEdgeInput(opp: ScannerOpportunity, proposal: AgentProposal): EdgeInput {
  const timing = opp.timingContext?.timeframe === opp.timeframe ? opp.timingContext : undefined;
  return {
    direction: proposal.direction,
    components: {
      directionConviction: Number.isFinite(opp.confidenceScore) ? opp.confidenceScore : null,
      entryQuality: Number.isFinite(opp.entrySniperScore) ? opp.entrySniperScore : null,
      rewardToRisk: rewardToRiskScore(proposal.riskPlan.expectedR),
      timingQuality: timing && timing.dataQualityLabel !== "basic_timing_estimate" ? timing.tradeabilityScore : null,
    },
    honesty: {
      feedStatus: mapEdgeFeedStatus(opp.dataSource),
      spread: "unknown",
      timing: "unknown",
    },
  };
}

// Per-user risk appetite → fraction of account risked per planned setup. Honest
// + bounded; never martingale (fixed fraction, never increases after a loss).
const RISK_PERCENT_BY_PROFILE: Record<RiskProfile, number> = {
  conservative: 0.5,
  balanced: 1,
  aggressive: 2,
  extreme: 3,
};

export interface MissionScanResult {
  proposals: MissionProposalRow[];
  selectedProposalId: string | null;
  judgeDecision: "best" | "no_trade";
  judgeReason: string;
  liveFeedConnected: boolean;
  symbolsScanned: number;
  /** Risk-adjusted opportunity queue (ordered; "wait" when no A/B edge). */
  queue: OpportunityQueue;
  /** Mission-impact preview for the selected best proposal (null if none). */
  missionImpact: MissionImpact | null;
}

/**
 * Run a mission scan: seed the team, scout each proposer's eligible symbols via
 * the existing scanner engine, run the pure Risk reviewer + Execution Judge, and
 * persist the structured proposals. Returns an honest empty/context-only result
 * when no live feed yields an edge. Per-user/mission scoped throughout.
 */
export async function runMissionScan(args: {
  userId: number;
  missionId: number;
  settings: Record<string, unknown> | null | undefined;
}): Promise<MissionScanResult> {
  const { userId, missionId } = args;
  const { symbols, timeframe } = resolveMissionScanSettings(args.settings);

  const team = await seedMissionTeam(missionId, userId);
  const agentIdByKey = new Map<string, number>(team.map((a) => [a.agentKey, a.id]));

  const scanRunTs = Date.now();
  const proposers = MISSION_AGENT_TEAM.filter((a) => a.kind === "proposer");

  let liveFeedConnected = false;
  const reviewed: AgentProposal[] = [];
  const edgeByProposalId = new Map<string, EdgeScore>();
  // Keep the scanner read behind each kept proposal so the Edge Engine can be
  // composed over scanner truth (no re-derivation) after the debate resolves.
  const oppByProposalId = new Map<string, ScannerOpportunity>();
  // Every specialist judges the same observation of a market in this scan.
  const raw: ScannerOpportunity[] = [];
  for (const symbol of symbols) {
    if (!proposers.some(agent => agentProposesOn(agent, symbol))) continue;
    const row = await scanSymbolTimeframe(symbol, timeframe).catch(() => null);
    if (row) raw.push(row);
  }
  const observations = new Map((await reviewScannerOpportunities(raw)).map(row => [row.symbol, row]));

  for (const agent of proposers) {
    const eligible = symbols.filter((sym) => agentProposesOn(agent, sym));
    if (eligible.length === 0) continue;

    // Scout each eligible symbol; keep the single best read for this agent.
    let best: { opp: ScannerOpportunity; proposal: AgentProposal; edge: EdgeScore } | null = null;
    for (const sym of eligible) {
      const opp = observations.get(sym);
      if (!opp) continue;
      if (ACTIONABLE_DATA_SOURCES.has(opp.dataSource) && opp.selectable) liveFeedConnected = true;
      const candidate = opportunityToProposal(
        agent.agentKey,
        `${missionId}:${agent.agentKey}:${scanRunTs}`,
        opp,
      );
      const edge = computeEdgeScore(opportunityToEdgeInput(opp, candidate));
      candidate.riskObjection = candidate.direction !== "NONE" && candidate.riskPlan.expectedR == null
        ? "The current entry is outside the stop and target."
        : assessRiskObjection(candidate);
      candidate.status = candidate.direction === "NONE" ? "context_only" : candidate.riskObjection ? "vetoed" : "proposed";
      candidate.rejectionReason = candidate.riskObjection;
      const eligible = edge.actionable && candidate.status === "proposed";
      const bestEligible = best?.edge.actionable && best.proposal.status === "proposed";
      if (!best || (eligible !== bestEligible ? eligible :
        edge.finalEdgeScore > best.edge.finalEdgeScore ||
        (edge.finalEdgeScore === best.edge.finalEdgeScore && candidate.confidence > best.proposal.confidence))) {
        best = { opp, proposal: candidate, edge };
      }
    }
    if (best) {
      reviewed.push(best.proposal);
      oppByProposalId.set(best.proposal.proposalId, best.opp);
      edgeByProposalId.set(best.proposal.proposalId, best.edge);
    }
  }

  // ── Mission context for the router + impact (scoped read; honest math). ────
  const missionRows = await db
    .select()
    .from(profitMissionsTable)
    .where(and(eq(profitMissionsTable.id, missionId), eq(profitMissionsTable.userId, userId)))
    .limit(1);
  const missionRow = missionRows[0] ?? null;
  const nowMs = Date.now();
  const missionMath = missionRow
    ? computeMissionMath({
        startingAmount: missionRow.startingAmount,
        targetAmount: missionRow.targetAmount,
        timeframeStartMs: missionRow.timeframeStart.getTime(),
        timeframeEndMs: missionRow.timeframeEnd.getTime(),
        currentValue: missionRow.currentValue,
        nowMs,
      })
    : null;
  const riskProfile: RiskProfile =
    missionRow && missionRow.riskProfile in RISK_PERCENT_BY_PROFILE
      ? (missionRow.riskProfile as RiskProfile)
      : "balanced";
  const accountBalance = missionRow?.currentValue ?? 0;

  // ── Edge Engine + position sizing per reviewed proposal (advisory). ───────
  // Edge can only LOWER standing (honest caps), never raise a setup over a
  // safety block; position sizing is a FIXED-FRACTION risk (never martingale).
  const sizedRiskByProposalId = new Map<string, number | null>();
  // Specialists reading the same instrument, timeframe and side share one
  // market observation. Keep every proposal for attribution, rank the setup once.
  const candidates = new Map<string, RouterCandidate>();

  for (const p of reviewed) {
    // Position sizing only when we have a real entry + protective stop.
    const entry = p.entryPlan.entryPrice;
    const stopLoss = p.riskPlan.stopLoss;
    let riskAmount: number | null = p.riskPlan.riskAmount;
    if (
      entry != null && Number.isFinite(entry) &&
      stopLoss != null && Number.isFinite(stopLoss) &&
      accountBalance > 0
    ) {
      const sized = calculatePositionSize({
        accountBalance,
        riskPercent: RISK_PERCENT_BY_PROFILE[riskProfile],
        entry,
        stopLoss,
        symbol: p.symbol,
      });
      if (sized.stopDistance > 0) riskAmount = sized.riskAmount;
    }
    sizedRiskByProposalId.set(p.proposalId, riskAmount);

    const expectedR = p.riskPlan.expectedR;
    const estimatedProfitContribution =
      riskAmount != null && expectedR != null && Number.isFinite(expectedR)
        ? Math.round(riskAmount * expectedR * 100) / 100
        : null;
    if (p.status === "vetoed") continue;
    const key = [p.symbol, p.timeframe, p.direction].join("|");
    if (candidates.has(key)) continue;
    candidates.set(key, {
      proposalId: p.proposalId,
      agentKey: p.agentKey,
      symbol: p.symbol,
      timeframe: p.timeframe,
      direction: p.direction,
      edge: edgeByProposalId.get(p.proposalId)!,
      expectedR,
      estimatedProfitContribution,
      riskAmount,
    });
  }

  // ── Risk-adjusted opportunity queue (NOT raw confidence). "wait" if no A/B. ─
  const queue: OpportunityQueue = routeOpportunities([...candidates.values()], {
    remainingProfit: missionMath?.remainingProfit ?? 0,
    requiredDailyProfit: missionMath?.requiredDailyProfit ?? 0,
  });

  // ── Mission-impact preview for the selected best proposal (estimate only). ─
  let missionImpact: MissionImpact | null = null;
  const selectedId = queue.best?.candidate.proposalId ?? null;
  const chosen = reviewed.find(p => p.proposalId === selectedId);
  const judgeReason = chosen ? "Highest-ranked eligible setup after timing, reward-to-risk and risk review."
    : "No setup passed both risk review and the Mission edge threshold.";
  if (chosen) {
    chosen.status = "selected";
    chosen.judgeDecision = "best";
    chosen.selectionReason = judgeReason;
  }
  if (selectedId && missionRow) {
    const selectedProposal = reviewed.find((p) => p.proposalId === selectedId) ?? null;
    const selRisk = sizedRiskByProposalId.get(selectedId) ?? null;
    const selExpectedR = selectedProposal?.riskPlan.expectedR ?? null;
    if (selectedProposal && selRisk != null && selRisk > 0 && selExpectedR != null && selExpectedR > 0) {
      missionImpact = computeMissionImpact({
        math: {
          startingAmount: missionRow.startingAmount,
          targetAmount: missionRow.targetAmount,
          timeframeStartMs: missionRow.timeframeStart.getTime(),
          timeframeEndMs: missionRow.timeframeEnd.getTime(),
          currentValue: missionRow.currentValue,
          nowMs,
        },
        riskAmount: selRisk,
        expectedR: selExpectedR,
        // Scanner confidence is a heuristic score, not a measured probability
        // of this proposal's target beating its stop within a bound horizon.
      });
    }
  }

  // ── Phase 7 advisory annotation (execution-quality + net-profit per proposal;
  // exposure on the selected one) so the Judge view + frontend see full cost /
  // exposure truth. Display/decision-support only — never an execution path.
  const phase7ByProposalId = await annotateScanProposals({
    userId,
    budget: exposureBudgetFrom(DEFAULT_MISSION_RISK_BUDGET),
    proposals: reviewed.map((p) => ({
      proposalId: p.proposalId,
      symbol: p.symbol,
      timeframe: p.timeframe,
      direction: p.direction,
      dataSource: oppByProposalId.get(p.proposalId)?.dataSource ?? "AWAITING_FEED",
      riskAmount: sizedRiskByProposalId.get(p.proposalId) ?? p.riskPlan.riskAmount,
      expectedR: p.riskPlan.expectedR,
      isSelected: p.proposalId === selectedId,
    })),
  });

  // Persist: replace this mission's prior proposals with the fresh scan set.
  const persisted = await db.transaction(async (tx) => {
    await tx
      .delete(missionProposalsTable)
      .where(
        and(
          eq(missionProposalsTable.missionId, missionId),
          eq(missionProposalsTable.userId, userId),
        ),
      );
    if (reviewed.length === 0) return [] as MissionProposalRow[];
    return tx
      .insert(missionProposalsTable)
      .values(
        reviewed.map((p) => ({
          proposalId: p.proposalId,
          missionId,
          userId,
          missionAgentId: agentIdByKey.get(p.agentKey) ?? 0,
          agentKey: p.agentKey,
          symbol: p.symbol,
          timeframe: p.timeframe,
          direction: p.direction,
          setupType: p.setupType,
          confidence: p.confidence,
          urgency: p.urgency,
          expectedR: p.riskPlan.expectedR,
          riskAmount: sizedRiskByProposalId.get(p.proposalId) ?? p.riskPlan.riskAmount,
          entryPlanJson: p.entryPlan,
          riskPlanJson: p.riskPlan,
          edgeJson: edgeByProposalId.get(p.proposalId) ?? null,
          executionQualityJson: phase7ByProposalId.get(p.proposalId) ?? null,
          missionImpactJson: p.proposalId === selectedId ? missionImpact : null,
          marketSnapshotJson: p.marketSnapshot,
          warningsJson: p.warnings,
          reason: p.reason,
          invalidationLevel: p.invalidationLevel,
          status: p.status,
          selectionReason: p.selectionReason,
          rejectionReason: p.rejectionReason,
          riskObjection: p.riskObjection,
          judgeDecision: p.judgeDecision,
        })),
      )
      .returning();
  });

  return {
    proposals: persisted,
    selectedProposalId: selectedId,
    judgeDecision: chosen ? "best" : "no_trade",
    judgeReason,
    liveFeedConnected,
    symbolsScanned: symbols.length,
    queue,
    missionImpact,
  };
}
