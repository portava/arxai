import { and, desc, eq, isNull, lt, lte, or, sql } from "drizzle-orm";
import { atiShadowObservationsTable as observations, atiShadowOutcomesTable as outcomes,
  atiShadowRunsTable as runs, db } from "@workspace/db";
import type { DecisionCandidate, DecisionCheck } from "@workspace/domain/self-trade";
import type { EleanorMarketEdgeSignal } from "@workspace/domain/signal-intelligence";
import { isAtiEntryDecision, type AtiShadowGrade } from "./atiShadowGrading.js";
import { captureAtiMarketContext } from "./atiTradingContext.js";
import { atiCounterargumentPolicy, type AtiCounterargumentEvidence, type AtiCounterargumentHistory, type AtiRetestPlan } from "./atiCounterargument.js";
import type { AtiRegimeAssessment } from "./atiRegimeInstrument.js";

export type AtiMemoryFilter = { asOf: Date; limit: number; symbol?: string; setup?: string; sourceIdentity?: string; observedBefore?: Date };
export type AtiShadowMemoryCursor = { observedAt: string; runId: string; observationKey: string };

const at = (date: Date | null) => date?.toISOString() ?? null;

export function atiDecisionWarnings(checks: unknown) {
  if (!Array.isArray(checks)) return [];
  return (checks as DecisionCheck[]).filter((row) => row && (row.status === "WARN" || row.status === "FAIL") &&
    typeof row.key === "string" && typeof row.detail === "string")
    .map(({ key, status, detail }) => ({ key, status, detail }));
}

type ShadowFacts = {
  input?: { signal?: EleanorMarketEdgeSignal };
  baseline?: DecisionCandidate;
  mt5QuoteOrigin?: { mode?: "LIVE" | "DEMO" };
  quote?: { observedAt: string; bid: number; ask: number };
  challengerReason?: string;
  chartConfirmation?: import("./decisionEngine.js").SelfTradeObservationInput["chartConfirmation"];
  counterargument?: AtiCounterargumentEvidence;
  retestPlan?: AtiRetestPlan;
  regimeAssessment?: AtiRegimeAssessment;
  feedGapReason?: string;
};

export async function readAtiShadowMemory(ownerId: number, agentId: number, filter: AtiMemoryFilter, cursor?: AtiShadowMemoryCursor) {
  const cursorTime = cursor ? new Date(cursor.observedAt) : null;
  const rows = await db.select({
    runId: runs.id, symbol: runs.symbol, timeframe: runs.timeframe, configuredSetup: runs.setup,
    baselineVersion: runs.baselineVersion, challengerVersion: runs.challengerVersion,
    observationKey: observations.observationKey, observedAt: observations.observedAt, recordedAt: observations.recordedAt,
    sourceIdentity: observations.sourceIdentity, coverage: observations.coverage, setup: observations.setup,
    baselineOutcome: observations.baselineOutcome, challengerOutcome: observations.challengerOutcome,
    facts: sql<ShadowFacts>`${observations.evidence}`,
    outcome: sql<AtiShadowGrade | null>`${outcomes.evidence}`, outcomeRecordedAt: outcomes.recordedAt, gradeVersion: outcomes.gradeVersion,
  }).from(runs).innerJoin(observations, eq(observations.runId, runs.id)).leftJoin(outcomes, and(
    eq(outcomes.runId, observations.runId), eq(outcomes.observationKey, observations.observationKey),
    lte(outcomes.evaluatedAt, filter.asOf), or(isNull(outcomes.recordedAt), lte(outcomes.recordedAt, filter.asOf)),
  )).where(and(
    eq(runs.ownerId, ownerId), eq(runs.agentId, agentId), isNull(runs.researchSource), lte(observations.observedAt, filter.asOf),
    or(isNull(observations.recordedAt), lte(observations.recordedAt, filter.asOf)),
    filter.symbol ? eq(runs.symbol, filter.symbol) : undefined,
    filter.setup ? eq(observations.setup, filter.setup) : undefined,
    filter.sourceIdentity ? eq(observations.sourceIdentity, filter.sourceIdentity) : undefined,
    filter.observedBefore ? lt(observations.observedAt, filter.observedBefore) : undefined,
    cursor && cursorTime ? or(lt(observations.observedAt, cursorTime), and(eq(observations.observedAt, cursorTime),
      or(lt(runs.id, cursor.runId), and(eq(runs.id, cursor.runId), lt(observations.observationKey, cursor.observationKey))))) : undefined,
  )).orderBy(desc(observations.observedAt), desc(runs.id), desc(observations.observationKey)).limit(filter.limit + 1);

  const episodes = rows.slice(0, filter.limit).map(({ facts, outcome, ...row }) => {
    const signal = facts.input?.signal;
    const context = signal ? captureAtiMarketContext(signal, ownerId, +row.observedAt) : null;
    const plan = facts.baseline?.thesis ?? null;
    const warnings = atiDecisionWarnings(facts.baseline?.checks);
    const released = row.outcomeRecordedAt ? outcome : null;
    const settled = released?.state === "SIMULATED_FILL" ? released : null;
    const retest = released?.state === "RETEST_COMPARISON" ? released : null;
    const guardian = released?.state === "GUARDIAN_COMPARISON" ? released : null;
    const path = settled?.observedPath;
    const feedGap = row.coverage !== "OBSERVED";
    const eligible = !feedGap && row.setup === row.configuredSetup && isAtiEntryDecision(row.baselineOutcome);
    const outcomeState = feedGap ? "FEED_GAP" : !eligible ? "NO_BASELINE_ENTRY"
      : guardian ? guardian.state : retest ? "RETEST_COMPARISON" : settled ? "SIMULATED_FILL" : released ? "UNRESOLVED" : outcome ? "GRADE_AVAILABILITY_UNVERIFIED" : "AWAITING_GRADE";
    const quote = !feedGap ? facts.quote : null;
    return {
      source: "SHADOW" as const, runId: row.runId, observationKey: row.observationKey, symbol: row.symbol,
      timeframe: row.timeframe, setup: row.setup, configuredSetup: row.configuredSetup,
      baselineVersion: row.baselineVersion, challengerVersion: row.challengerVersion,
      observedAt: at(row.observedAt)!, availableAt: at(row.recordedAt),
      sourceIdentity: row.sourceIdentity, venue: context?.source ?? signal?.marketEvidence?.source ?? null,
      feedMode: facts.mt5QuoteOrigin?.mode ?? null, marketContext: feedGap ? null : context,
      ...(facts.regimeAssessment ? { regimeAssessment: facts.regimeAssessment } : {}),
      entry: { side: facts.baseline?.side ?? null, decision: row.baselineOutcome, reason: facts.baseline?.reason ?? null,
        challengerDecision: row.challengerOutcome, challengerReason: facts.challengerReason ?? null,
        ...(facts.counterargument ? { counterargument: facts.counterargument } : {}),
        ...(facts.chartConfirmation ? { chartConfirmation: facts.chartConfirmation } : {}),
        warnings, quote: quote ? { ...quote, spreadPriceUnits: quote.ask - quote.bid } : null },
      expected: { plan, trajectory: null, ...(facts.retestPlan ? { retestPlan: facts.retestPlan } : {}) },
      outcome: { state: outcomeState, availableAt: at(row.outcomeRecordedAt), gradeVersion: row.gradeVersion,
        reason: released?.state === "UNRESOLVED" ? released.reason : settled?.exitReason ?? facts.feedGapReason ?? null,
        replay: settled,
        ...(guardian ? { guardian } : {}),
        ...(retest ? { retest } : {}),
        excursions: path ? { maxFavorablePriceUnits: path.favorable?.signedPriceUnits ?? 0,
          maxAdversePriceUnits: path.adverse?.signedPriceUnits ?? 0, samples: path.samples } : null },
      evidenceGaps: [
        ...(!row.recordedAt ? ["DECISION_AVAILABILITY_UNVERIFIED"] : []),
        ...(outcome && !row.outcomeRecordedAt ? ["GRADE_AVAILABILITY_UNVERIFIED"] : []),
        ...(!context && !feedGap ? ["MARKET_CONTEXT_UNAVAILABLE"] : []),
        ...(plan ? ["FORECAST_TRAJECTORY_UNAVAILABLE"] : []),
        ...(feedGap ? [row.coverage] : []),
        ...(settled && !settled.observedPath ? ["EXCURSION_PATH_UNAVAILABLE"] : []),
      ],
    };
  });

  // Preserve the boundaries that make a warning's observed outcomes comparable.
  const cohorts = new Map<string, { symbol: string; timeframe: string; setup: string; sourceIdentity: string;
    baselineVersion: string; warning: string; settled: number; losses: number; wins: number }>();
  for (const episode of episodes) {
    if (!episode.availableAt || !episode.sourceIdentity || !episode.outcome.replay) continue;
    const pnl = episode.outcome.replay.quoteSidePnl.baselineR;
    for (const warning of new Set(episode.entry.warnings.map((row) => row.key))) {
      const { symbol, timeframe, setup, sourceIdentity, baselineVersion } = episode;
      const key = JSON.stringify([symbol, timeframe, setup, sourceIdentity, baselineVersion, warning]);
      const group = cohorts.get(key) ?? { symbol, timeframe, setup, sourceIdentity, baselineVersion, warning, settled: 0, losses: 0, wins: 0 };
      group.settled++;
      if (pnl < 0) group.losses++;
      if (pnl > 0) group.wins++;
      cohorts.set(key, group);
    }
  }
  const last = episodes.at(-1);
  return {
    source: "SHADOW" as const, asOf: filter.asOf.toISOString(), executionAuthority: "NONE" as const,
    episodes,
    warningOutcomes: { scope: "RETURNED_EPISODES" as const, pnlBasis: "SIMULATED_QUOTE_SIDES" as const, cohorts: [...cohorts.values()] },
    nextCursor: last && rows.length > episodes.length ? { observedAt: last.observedAt, runId: last.runId, observationKey: last.observationKey } : null,
  };
}

export async function readAtiCounterargumentHistory(ownerId: number, agentId: number, input: {
  asOf: Date; beforeBar: Date; sourceIdentity: string; setup: string; symbol: string;
  timeframe: string; baselineVersion: string; side: "BUY" | "SELL";
}): Promise<AtiCounterargumentHistory> {
  const page = await readAtiShadowMemory(ownerId, agentId, {
    asOf: input.asOf, limit: atiCounterargumentPolicy.historyScanLimit, symbol: input.symbol, setup: input.setup,
    sourceIdentity: input.sourceIdentity, observedBefore: input.beforeBar,
  });
  const unique = new Set<string>();
  const observations: AtiCounterargumentHistory["observations"] = [];
  const earliest = +input.asOf - atiCounterargumentPolicy.historyDays * 24 * 60 * 60_000;
  for (const episode of page.episodes) {
    const replay = episode.outcome.replay;
    const key = episode.observationKey;
    if (!replay || replay.pnlRiskBasis || !episode.availableAt || Date.parse(episode.observedAt) < earliest || replay.exitObservedAt >= +input.asOf ||
        episode.entry.side !== input.side || episode.timeframe !== input.timeframe || episode.baselineVersion !== input.baselineVersion ||
        episode.setup !== episode.configuredSetup || !Number.isFinite(replay.quoteSidePnl.baselineR) || unique.has(key)) continue;
    unique.add(key);
    observations.push({ runId: episode.runId, observationKey: key, baselineR: replay.quoteSidePnl.baselineR });
    if (observations.length === atiCounterargumentPolicy.historyLimit) break;
  }
  const total = observations.reduce((sum, row) => sum + row.baselineR, 0);
  return { basis: "PRIOR_OWNER_SHADOW_QUOTE_SIDE_R", observations,
    lossCount: observations.filter((row) => row.baselineR < 0).length,
    meanR: observations.length && Number.isFinite(total) ? total / observations.length : null };
}
