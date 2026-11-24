import type { DbOrTx } from "./audit.js";
import { atiDecisionSettingsHash } from "./atiStrategyOrigin.js";
import { createHash, randomUUID } from "node:crypto";
import { and, asc, eq, inArray, isNotNull, isNull, lte, sql } from "drizzle-orm";
import {
  atiShadowObservationsTable as observations, atiShadowOutcomesTable as outcomes,
  atiShadowRunsTable as runs, db,
} from "@workspace/db";
import type { DecisionCandidate, SetupKind } from "@workspace/domain/self-trade";
import { classifyQuoteFreshness } from "../data/freshness.js";
import { evidenceMatches, isCurrentBuild } from "../truth/marketReadEvidence.js";
import { ATI_FLEET_BASELINE, ATI_FLEET_CAPTURE, ATI_FLEET_SCOPE, ATI_FLEET_SYMBOL, fleetInputGap,
  type AtiFleetRead, type AtiFleetReceipt } from "./atiFleetShadow.js";
import { canObserveSelfTradeAgent, observeSelfTradeCandidate } from "./decisionEngine.js";
import { readAtiExecutionCosts } from "./atiExecutionCosts.js";
import { atiMt5QuoteOrigin, type AtiMt5QuoteOrigin } from "../data/atiMt5QuoteOrigin.js";
import { atiDerivQuoteOrigin, flushAtiDerivQuotes, retainAtiDerivQuotes, type AtiDerivQuoteOrigin } from "../data/atiDerivQuotes.js";
import { loadAtiMt5ReplayQuotes, type AtiMt5ReplayQuote } from "./atiMt5QuoteReplay.js";
import { loadAtiDerivReplayQuotes } from "./atiDerivQuoteReplay.js";
import { freezeAtiMeasuredCosts, selectAtiMeasuredCosts, type AtiMeasuredCostProfile } from "./atiMeasuredCosts.js";
import { logger } from "../logger.js";
import { ATI_GUARDIAN_GRADE_VERSION, guardianComparisonPolicy } from "./atiGuardian.js";
import { assessAtiCounterargument, counterargumentOutcome, ATI_RETEST_CHALLENGER, atiChallengerVersion, atiRetestPlan,
  freezeAtiRetestPlan, isAtiCounterargumentChallenger, type AtiChallengerVersion, type AtiCounterargumentEvidence,
  type AtiCounterargumentHistory, type AtiRetestPlan } from "./atiCounterargument.js";
import { readAtiCounterargumentHistory } from "./atiTradingMemory.js";
import { ATI_REGIME_INSTRUMENT_CHALLENGER, assessAtiRegimeInstrument, atiInstrumentProfile, atiObservedRegime,
  atiRegimeOutcome, boundAtiRegimeAssessment, summarizeAtiRegimeTransitions, type AtiRegimeAssessment } from "./atiRegimeInstrument.js";
import { getBuildIdentity } from "../startup/buildIdentity.js";
import {
  ATI_DERIV_ARCHIVE_GRADE_VERSION, ATI_MT5_GRADE_VERSION, ATI_RETEST_GRADE_VERSION, ATI_SHADOW_GRADE_VERSION, ATI_SHADOW_HOLD_WINDOW_MS,
  ATI_SHADOW_DECISION_SCOPE, atiShadowDefinition, gradeAtiShadowPair, timeframeConflictOutcome, isAtiEntryDecision, summarizeAtiShadowGrades,
  type AtiAssumedCosts, type AtiShadowGrade,
} from "./atiShadowGrading.js";

type Run = typeof runs.$inferSelect;
type CandidateRead = NonNullable<Awaited<ReturnType<typeof observeSelfTradeCandidate>>>;

const { timeframe: TIMEFRAME, barMs: BAR_MS, baselineVersion: BASELINE_VERSION,
  challengerVersion: CHALLENGER_VERSION } = atiShadowDefinition;
const AUTHORITY = "NONE";

export type AtiShadowPilot = {
  baselineVersion?: typeof ATI_FLEET_BASELINE | typeof BASELINE_VERSION;
  symbol: string;
  setup: Exclude<SetupKind, "NONE">;
  durationMinutes: number;
  assumedCosts?: AtiAssumedCosts;
  challengerVersion?: AtiChallengerVersion;
};

const entryOutcomes = ["APPROVED", "APPROVED_REDUCED"];
const outcomeJoin = and(eq(outcomes.runId, observations.runId), eq(outcomes.observationKey, observations.observationKey));

function runScope(ownerId: number, agentId: number, runId: string, mode: "SHADOW" | "RESEARCH" = "SHADOW") {
  return and(eq(runs.ownerId, ownerId), eq(runs.agentId, agentId), eq(runs.id, runId),
    mode === "RESEARCH" ? isNotNull(runs.researchSource) : isNull(runs.researchSource));
}

function sawObservedFeed(read: CandidateRead, run: Run) {
  const { input, boundQuote } = read.observation;
  const { signal } = input;
  const origin = signal.marketEvidence;
  if (!origin || !boundQuote || signal.dataSource !== "LIVE_FEED" || !signal.hasSufficientData ||
      origin.symbol !== run.symbol || origin.timeframe !== run.timeframe ||
      !evidenceMatches(origin, origin, read.evaluatedAt, run.ownerId) ||
      !isCurrentBuild(signal.generatedAt, read.evaluatedAt)) return false;
  if (origin.source === "mt5_broker" && !read.observation.mt5QuoteOrigin) return false;
  const quoteAge = read.evaluatedAt - Date.parse(boundQuote.observedAt);
  return Number.isFinite(quoteAge) && quoteAge >= 0 && classifyQuoteFreshness(quoteAge).fresh &&
    Number.isFinite(boundQuote.bid) && Number.isFinite(boundQuote.ask) && boundQuote.bid > 0 && boundQuote.ask > boundQuote.bid;
}

function observedSourceIdentity(read: CandidateRead, run: Run) {
  const origin = read.observation.input.signal.marketEvidence;
  if (!origin || !sawObservedFeed(read, run)) return null;
  const mt5 = read.observation.mt5QuoteOrigin;
  return mt5 && origin.source === "mt5_broker"
    ? createHash("sha256").update(JSON.stringify([origin.sourceIdentity, mt5.mode, mt5.accountBinding, mt5.streamKey])).digest("hex")
    : origin.sourceIdentity;
}

async function counterargumentHistory(read: CandidateRead, run: Run) {
  const { candidate } = read;
  if (!isAtiCounterargumentChallenger(run.challengerVersion) || candidate.setup !== run.setup ||
      !isAtiEntryDecision(candidate.outcome) || !candidate.side) return null;
  const sourceIdentity = observedSourceIdentity(read, run);
  const barAt = Date.parse(read.observation.input.signal.marketEvidence?.lastClosedCandleAt ?? "");
  if (!sourceIdentity || !Number.isFinite(barAt)) return null;
  try {
    return await readAtiCounterargumentHistory(run.ownerId, run.agentId, {
      asOf: new Date(read.evaluatedAt - 1), beforeBar: new Date(barAt), sourceIdentity, setup: run.setup,
      symbol: run.symbol, timeframe: run.timeframe, baselineVersion: run.baselineVersion, side: candidate.side,
    });
  } catch (error) {
    logger.warn({ err: error, runId: run.id }, "ATI counterargument history unavailable");
    return null;
  }
}

function comparison(read: CandidateRead, run: Run, sourceIdentity: string | null, history: AtiCounterargumentHistory | null = null) {
  const baseline = read.candidate;
  const { input } = read.observation;
  const origin = input.signal.marketEvidence;
  const actualSource = observedSourceIdentity(read, run);
  const observed = actualSource != null;
  const mt5Origin = read.observation.mt5QuoteOrigin;
  const wrongResearchSource = run.researchSource != null &&
    (origin?.source !== run.researchSource || (mt5Origin?.mode ?? null) !== run.researchMode);
  const coverage = !actualSource ? "NO_OBSERVED_FEED"
    : wrongResearchSource || (sourceIdentity && sourceIdentity !== actualSource) ? "SOURCE_CHANGED" : "OBSERVED";

  const eligible = coverage === "OBSERVED" && baseline.setup === run.setup && isAtiEntryDecision(baseline.outcome);
  const usesLegacyChallenger = eligible && run.challengerVersion === CHALLENGER_VERSION &&
    timeframeConflictOutcome(baseline) !== baseline.outcome;
  const counterargument = eligible && isAtiCounterargumentChallenger(run.challengerVersion)
    ? assessAtiCounterargument(baseline, input, read.observation.boundQuote, run.ownerId, read.evaluatedAt, history) : null;
  const retestPlan = counterargument && run.challengerVersion === ATI_RETEST_CHALLENGER
    ? freezeAtiRetestPlan(baseline, input, counterargument) : null;
  const usesRegime = run.challengerVersion === ATI_REGIME_INSTRUMENT_CHALLENGER;
  const regimeAssessment = usesRegime && coverage === "OBSERVED"
    ? assessAtiRegimeInstrument(baseline, input, read.evaluatedAt, atiInstrumentProfile(run.symbol)) : null;
  const challengerOutcome = usesRegime && eligible ? atiRegimeOutcome(baseline.outcome, regimeAssessment)
    : counterargument ? counterargumentOutcome(baseline.outcome, counterargument.decision)
    : usesLegacyChallenger ? "WAIT" : baseline.outcome;
  const challengerReason = usesRegime && eligible ? regimeAssessment?.reasons.join(", ") || (regimeAssessment ? baseline.reason : "Regime evidence is unavailable.")
    : usesLegacyChallenger
    ? "Higher timeframe opposes the entry."
    : counterargument ? counterargument.concerns.map((item) => item.detail).join(" ") || baseline.reason : baseline.reason;
  const derivOrigin = read.observation.derivQuoteOrigin;
  const retainedDerivOrigin = derivOrigin && coverage === "OBSERVED" && origin?.source === "deriv_public" &&
    isAtiEntryDecision(baseline.outcome) && baseline.setup === run.setup &&
    retainAtiDerivQuotes(derivOrigin, read.evaluatedAt, read.evaluatedAt + ATI_SHADOW_HOLD_WINDOW_MS) ? derivOrigin : null;

  return {
    runId: run.id,
    // A primary closed bar can contribute at most one observation. Feed
    // misses retain their own time slot so they cannot mask a later real read.
    observationKey: observed && origin
      ? `${coverage === "SOURCE_CHANGED" ? "source-changed" : "bar"}:${Date.parse(origin.lastClosedCandleAt)}`
      : `gap:${Math.floor(read.evaluatedAt / BAR_MS)}`,
    observedAt: new Date(read.evaluatedAt),
    sourceIdentity: actualSource,
    coverage,
    setup: baseline.setup,
    baselineOutcome: baseline.outcome,
    challengerOutcome,
    evidence: {
      executionAuthority: AUTHORITY,
      input,
      quote: read.observation.boundQuote,
      chartConfirmation: read.observation.chartConfirmation,
      mt5QuoteOrigin: read.observation.mt5QuoteOrigin ?? null,
      ...(derivOrigin !== undefined ? { derivQuoteOrigin: retainedDerivOrigin } : {}),
      feedGapReason: !observed && origin?.source === "mt5_broker" && !mt5Origin ? "MT5_REPLAY_ORIGIN_UNVERIFIED" : null,
      baseline,
      challengerReason,
      ...(counterargument ? { counterargument } : {}),
      ...(retestPlan ? { retestPlan } : {}),
      ...(regimeAssessment ? { regimeAssessment } : {}),
      ...(run.researchSource ? {
        researchBuild: getBuildIdentity(),
        decisionSettingsHash: atiDecisionSettingsHash(input),
      } : {}),
    },
  };
}

async function costProfileFor(run: Run, row: ReturnType<typeof comparison>) {
  const origin = row.evidence.mt5QuoteOrigin;
  if (row.coverage !== "OBSERVED" || !row.sourceIdentity || !origin) return null;
  try {
    return await freezeAtiMeasuredCosts(run.ownerId, run.symbol, row.sourceIdentity, origin, row.observedAt);
  } catch (error) {
    logger.warn({ err: error, runId: run.id }, "ATI measured cost receipts unavailable");
    return null;
  }
}

export async function startAtiShadowRun(ownerId: number, agentId: number, pilot: AtiShadowPilot) {
  const challenger = atiChallengerVersion.safeParse(pilot.challengerVersion ?? CHALLENGER_VERSION);
  if (!challenger.success) return null;
  const native = pilot.baselineVersion === ATI_FLEET_BASELINE;
  if (native && (pilot.symbol !== ATI_FLEET_SYMBOL || challenger.data !== CHALLENGER_VERSION ||
      !await canObserveSelfTradeAgent(ownerId, agentId, pilot.symbol))) return null;
  const read = native ? null : await observeSelfTradeCandidate(ownerId, agentId, pilot.symbol);
  if (!native && !read) return null;
  const startMs = read?.evaluatedAt ?? Date.now();
  const run: Run = {
    id: randomUUID(), ownerId, agentId, symbol: pilot.symbol, timeframe: TIMEFRAME, setup: pilot.setup,
    baselineVersion: native ? ATI_FLEET_BASELINE : BASELINE_VERSION, challengerVersion: challenger.data,
    assumedCosts: pilot.assumedCosts ?? null,
    measuredCostProfile: null,
    researchSource: null, researchMode: null,
    startedAt: new Date(startMs),
    endsAt: new Date(startMs + pilot.durationMinutes * 60_000),
  };
  const first = read ? comparison(read, run, null, await counterargumentHistory(read, run)) : null;
  run.measuredCostProfile = first ? await costProfileFor(run, first) : null;
  await db.transaction(async (tx) => {
    await tx.insert(runs).values(run);
    if (first) await tx.insert(observations).values(first);
  });
  return { runId: run.id, startedAt: run.startedAt, endsAt: run.endsAt, challengerVersion: run.challengerVersion, executionAuthority: AUTHORITY };
}

export async function appendAtiShadowObservation(ownerId: number, agentId: number, runId: string, mode: "SHADOW" | "RESEARCH" = "SHADOW") {
  const scope = runScope(ownerId, agentId, runId, mode);
  const [run] = await db.select().from(runs).where(scope).limit(1);
  if (!run) return { status: "NOT_FOUND" as const };
  if (run.baselineVersion === ATI_FLEET_BASELINE) return { status: "PASSIVE_FLEET_CAPTURE" as const };
  if (run.baselineVersion !== BASELINE_VERSION || !atiChallengerVersion.safeParse(run.challengerVersion).success)
    return { status: "VERSION_CHANGED" as const };
  if (Date.now() < +run.startedAt) return { status: "NOT_STARTED" as const };
  if (Date.now() >= +run.endsAt) return { status: "RUN_ENDED" as const };
  const read = await observeSelfTradeCandidate(ownerId, agentId, run.symbol);
  if (!read) return { status: "AGENT_UNAVAILABLE" as const };
  if (read.evaluatedAt < +run.startedAt) return { status: "NOT_STARTED" as const };
  if (read.evaluatedAt >= +run.endsAt) return { status: "RUN_ENDED" as const };
  const history = await counterargumentHistory(read, run);

  let costProfile: AtiMeasuredCostProfile | null = null;
  if (run.measuredCostProfile == null && read.observation.mt5QuoteOrigin && sawObservedFeed(read, run)) {
    const [existing] = await db.select({ runId: observations.runId }).from(observations)
      .where(and(eq(observations.runId, runId), eq(observations.coverage, "OBSERVED"))).limit(1);
    if (!existing) costProfile = await costProfileFor(run, comparison(read, run, null));
  }

  return storeObservation(run, scope, identity => comparison(read, run, identity, history), costProfile);
}

async function storeObservation(run: Run, scope: ReturnType<typeof runScope>,
  makeRow: (sourceIdentity: string | null) => typeof observations.$inferInsert, costProfile: AtiMeasuredCostProfile | null,
  connection: DbOrTx = db) {
  const runId = run.id;
  return connection.transaction(async (tx) => {
    // Resolve the first observed source and deduplicate under the same lock,
    // including the case where two callers first see different source eras.
    const [locked] = await tx.select({ id: runs.id }).from(runs).where(scope).for("update");
    if (!locked) return { status: "NOT_FOUND" as const };
    const [source] = await tx.select({ identity: observations.sourceIdentity }).from(observations)
      .where(and(eq(observations.runId, runId), eq(observations.coverage, "OBSERVED")))
      .orderBy(asc(observations.observedAt)).limit(1);
    const row = makeRow(source?.identity ?? null);
    const inserted = await tx.insert(observations).values(row).onConflictDoNothing()
      .returning({ observationKey: observations.observationKey, coverage: observations.coverage });
    if (!inserted.length) return { status: "ALREADY_OBSERVED" as const, observationKey: row.observationKey };
    if (!source && costProfile && row.coverage === "OBSERVED") {
      await tx.update(runs).set({ measuredCostProfile: costProfile }).where(and(scope, isNull(runs.measuredCostProfile)));
    }
    return { status: "RECORDED" as const, ...inserted[0] };
  });
}

export async function recordAtiFleetObservation(run: Run, candidate: DecisionCandidate, captured: AtiFleetRead,
  availableAt: number, receipt: AtiFleetReceipt, connection: DbOrTx) {
  if (run.baselineVersion !== ATI_FLEET_BASELINE || run.challengerVersion !== CHALLENGER_VERSION ||
      (run.researchSource != null && run.researchSource !== "deriv_public") || run.researchMode != null || run.agentId !== candidate.agentId || candidate.symbol !== run.symbol ||
      captured.observation.input.agentId !== run.agentId || captured.observation.input.symbol !== run.symbol ||
      receipt.cycleStartedAt < +run.startedAt || availableAt < receipt.cycleStartedAt || availableAt >= +run.endsAt) return;
  const read = { candidate, observation: captured.observation, evaluatedAt: availableAt };
  const gap = fleetInputGap(captured, run.ownerId, availableAt) ?? (sawObservedFeed(read, run) ? null : "UNVERIFIED_DECISION_QUOTE");
  return storeObservation(run, runScope(run.ownerId, run.agentId, run.id, run.researchSource ? "RESEARCH" : "SHADOW"), identity => {
    if (gap) return {
      runId: run.id, observationKey: `gap:${Math.floor(availableAt / BAR_MS)}`, observedAt: new Date(availableAt),
      coverage: "NO_OBSERVED_FEED", sourceIdentity: null, setup: candidate.setup,
      baselineOutcome: candidate.outcome, challengerOutcome: "UNOBSERVED",
      evidence: { executionAuthority: AUTHORITY, fleetReceipt: receipt, feedGapReason: gap,
        challengerReason: "Comparison unavailable for this feed." },
    };
    const row = comparison(read, run, identity);
    return { ...row, evidence: { ...row.evidence, fleetReceipt: receipt, fleetPriceOrigin: captured.priceOrigin } };
  }, null, connection);
}

export async function gradeAtiShadowRun(ownerId: number, agentId: number, runId: string, mode: "SHADOW" | "RESEARCH" = "SHADOW") {
  const scope = runScope(ownerId, agentId, runId, mode);
  const [run] = await db.select().from(runs).where(scope).limit(1);
  if (!run) return null;
  const now = Date.now();
  const releaseCutoff = new Date(+run.endsAt + ATI_SHADOW_HOLD_WINDOW_MS);
  if (mode === "RESEARCH" && now >= +releaseCutoff) {
    return { checked: 0, recorded: 0, pending: 0, executionAuthority: AUTHORITY };
  }
  const pending = await db.select({
    observationKey: observations.observationKey,
    observedAt: observations.observedAt,
    sourceIdentity: observations.sourceIdentity,
    source: sql<string | null>`${observations.evidence} #>> '{input,signal,marketEvidence,source}'`,
    mt5Origin: sql<unknown>`${observations.evidence} -> 'mt5QuoteOrigin'`,
    derivOrigin: sql<unknown>`${observations.evidence} -> 'derivQuoteOrigin'`,
    derivTracked: sql<boolean>`${observations.evidence} ? 'derivQuoteOrigin'`,
    retest: sql<unknown>`${observations.evidence} -> 'retestPlan'`,
    quote: sql<AtiMt5ReplayQuote | null>`${observations.evidence} -> 'quote'`,
    baseline: sql<DecisionCandidate>`${observations.evidence} -> 'baseline'`,
    challengerOutcome: observations.challengerOutcome,
  }).from(observations)
    .leftJoin(outcomes, outcomeJoin)
    .where(and(eq(observations.runId, runId), eq(observations.coverage, "OBSERVED"),
      eq(observations.setup, run.setup), inArray(observations.baselineOutcome, entryOutcomes),
      isNull(outcomes.runId))).orderBy(asc(observations.observedAt), asc(observations.observationKey)).limit(100);
  const replayKey = (origin: AtiMt5QuoteOrigin) => JSON.stringify([origin.bridgeConnectionId, origin.streamKey]);
  const streams = new Map<string, { origin: AtiMt5QuoteOrigin; from: number; through: number }>();
  const derivStreams = new Map<string, { origin: AtiDerivQuoteOrigin; through: number }>();
  const inputs = pending.map((row) => {
    const parsed = atiMt5QuoteOrigin.safeParse(row.mt5Origin);
    const origin = row.source === "mt5_broker" && parsed.success && +row.observedAt < now ? parsed.data : null;
    if (origin) {
      const key = replayKey(origin);
      const prior = streams.get(key);
      streams.set(key, { origin, from: Math.min(prior?.from ?? Infinity, +row.observedAt),
        through: Math.max(prior?.through ?? 0, Math.min(now, +row.observedAt + ATI_SHADOW_HOLD_WINDOW_MS)) });
    }
    const deriv = atiDerivQuoteOrigin.safeParse(row.derivOrigin);
    const derivOrigin = row.source === "deriv_public" && deriv.success && +row.observedAt < now ? deriv.data : null;
    const derivKey = derivOrigin ? JSON.stringify([derivOrigin.streamId, derivOrigin.symbol, Math.floor(+row.observedAt / ATI_SHADOW_HOLD_WINDOW_MS)]) : null;
    if (derivOrigin && derivKey) {
      const prior = derivStreams.get(derivKey);
      const through = Math.min(now, +row.observedAt + ATI_SHADOW_HOLD_WINDOW_MS);
      derivStreams.set(derivKey, { origin: prior && prior.origin.epoch < derivOrigin.epoch ? prior.origin : derivOrigin,
        through: Math.max(prior?.through ?? 0, through) });
    }
    return { row, origin, derivOrigin, derivKey };
  });
  if (derivStreams.size) await flushAtiDerivQuotes();
  const [archives, derivArchives] = await Promise.all([
    Promise.all([...streams].map(async ([key, stream]) => [key,
      await loadAtiMt5ReplayQuotes(ownerId, stream.origin, stream.from, stream.through)] as const)).then((rows) => new Map(rows)),
    Promise.all([...derivStreams].map(async ([key, stream]) => [key,
      await loadAtiDerivReplayQuotes(stream.origin, stream.through)] as const)).then((rows) => new Map(rows)),
  ]);
  const frozenCosts = run.measuredCostProfile as AtiMeasuredCostProfile | null;
  const guardian = run.challengerVersion === guardianComparisonPolicy.version;
  const usePlannedRisk = run.challengerVersion === ATI_RETEST_CHALLENGER;
  const grades = inputs.flatMap(({ row: { observationKey, observedAt, sourceIdentity, source, baseline, challengerOutcome, quote, derivTracked, retest },
    origin, derivOrigin, derivKey }) => {
    const planned = usePlannedRisk && retest != null ? atiRetestPlan.safeParse(retest) : null;
    const evidence = planned && !planned.success ? { state: "UNRESOLVED" as const, reason: "INVALID_PLAN" } : gradeAtiShadowPair({
      source, baseline, challengerOutcome, observedAt: +observedAt, symbol: run.symbol, guardian, usePlannedRisk, retestPlan: planned?.data,
      mt5Replay: origin ? { origin, quote, rows: archives.get(replayKey(origin)) ?? [] } : undefined,
      derivReplay: derivOrigin && derivKey ? { origin: derivOrigin, quote, rows: derivArchives.get(derivKey) ?? [] }
        : source === "deriv_public" && derivTracked ? null : undefined,
      assumedCosts: run.assumedCosts as AtiAssumedCosts | null,
      measuredCosts: origin ? selectAtiMeasuredCosts(frozenCosts, origin, sourceIdentity, +observedAt) : null,
    }, now);
    return evidence ? [{
      runId, observationKey, evaluatedAt: new Date(now),
      gradeVersion: guardian ? ATI_GUARDIAN_GRADE_VERSION : planned ? ATI_RETEST_GRADE_VERSION
        : source === "mt5_broker" ? ATI_MT5_GRADE_VERSION : derivTracked ? ATI_DERIV_ARCHIVE_GRADE_VERSION : ATI_SHADOW_GRADE_VERSION,
      evidence: mode === "RESEARCH" ? { ...evidence, researchBuild: getBuildIdentity() } : evidence,
    }] : [];
  });
  let recorded = 0;
  if (grades.length) {
    if (mode === "RESEARCH") {
      recorded = await db.transaction(async (tx) => {
        const [locked] = await tx.select({ id: runs.id }).from(runs).where(scope).for("update");
        const { rows: [clock] } = await tx.execute<{ open: boolean }>(sql`SELECT clock_timestamp() < ${releaseCutoff.toISOString()}::timestamptz AS open`);
        if (!locked || !clock?.open) return 0;
        return (await tx.insert(outcomes).values(grades).onConflictDoNothing().returning({ key: outcomes.observationKey })).length;
      });
    } else {
      recorded = (await db.insert(outcomes).values(grades).onConflictDoNothing().returning({ key: outcomes.observationKey })).length;
    }
  }
  return { checked: pending.length, recorded, pending: pending.length - grades.length, executionAuthority: AUTHORITY };
}

export async function readAtiShadowRun(ownerId: number, agentId: number, runId: string, asOf?: Date) {
  const [run] = await db.select().from(runs).where(runScope(ownerId, agentId, runId)).limit(1);
  if (!run || (asOf && run.startedAt > asOf)) return null;
  const rows = await db.select({
    observationKey: observations.observationKey,
    observedAt: observations.observedAt,
    coverage: observations.coverage,
    setup: observations.setup,
    baselineOutcome: observations.baselineOutcome,
    challengerOutcome: observations.challengerOutcome,
    baselineReason: sql<string>`${observations.evidence} #>> '{baseline,reason}'`,
    chartConfirmation: sql<CandidateRead["observation"]["chartConfirmation"] | null>`${observations.evidence} -> 'chartConfirmation'`,
    challengerReason: sql<string>`${observations.evidence} ->> 'challengerReason'`,
    counterargument: sql<AtiCounterargumentEvidence | null>`${observations.evidence} -> 'counterargument'`,
    retestPlan: sql<AtiRetestPlan | null>`${observations.evidence} -> 'retestPlan'`,
    regimeAssessment: sql<AtiRegimeAssessment | null>`${observations.evidence} -> 'regimeAssessment'`,
    fleetSource: observations.sourceIdentity,
    fleetPriceOrigin: sql<AtiDerivQuoteOrigin | null>`${observations.evidence} -> 'fleetPriceOrigin'`,
    fleetReceipt: sql<AtiFleetReceipt | null>`${observations.evidence} -> 'fleetReceipt'`,
    feedGapReason: sql<string | null>`${observations.evidence} ->> 'feedGapReason'`,
    decisionQuote: sql<CandidateRead["observation"]["boundQuote"]>`
      case when ${observations.coverage} = 'OBSERVED' then ${observations.evidence} -> 'quote' end`,
    grade: sql<AtiShadowGrade | null>`${outcomes.evidence}`,
    gradeVersion: outcomes.gradeVersion,
    gradedAt: outcomes.evaluatedAt,
  }).from(observations).leftJoin(outcomes, and(outcomeJoin, asOf ? and(lte(outcomes.evaluatedAt, asOf),
    lte(outcomes.recordedAt, asOf)) : undefined)).where(and(eq(observations.runId, runId),
      asOf ? and(lte(observations.observedAt, asOf), lte(observations.recordedAt, asOf)) : undefined))
    .orderBy(asc(observations.observedAt), asc(observations.observationKey));
  const native = run.baselineVersion === ATI_FLEET_BASELINE;
  if (asOf && !rows.length && !native) return null;
  const storedProfile = run.measuredCostProfile as AtiMeasuredCostProfile | null;
  const measuredCostProfile = !asOf || rows.some(row => row.coverage === "OBSERVED" && +row.observedAt === storedProfile?.availableBeforeMs)
    ? storedProfile : null;
  const paired = rows.filter((row) => row.coverage === "OBSERVED" && row.setup === run.setup);
  const eligible = paired.filter((row) => isAtiEntryDecision(row.baselineOutcome));
  const nativeGroups = new Map<string, typeof paired>();
  if (native) {
    for (const row of paired) {
      const version = row.fleetReceipt?.version;
      if (!version || !row.fleetSource) continue;
      const key = JSON.stringify([version.engine, version.build.revision, version.build.sourceState,
        version.decisionSettingsHash, row.fleetSource]);
      const group = nativeGroups.get(key);
      if (group) group.push(row);
      else nativeGroups.set(key, [row]);
    }
  }
  const fills = eligible.flatMap(({ grade }) => grade?.state === "SIMULATED_FILL" ? [grade] : []);
  const retests = eligible.flatMap(({ grade }) => grade?.state === "RETEST_COMPARISON" ? [grade] : []);
  const guardians = eligible.flatMap(({ grade }) => grade?.state === "GUARDIAN_COMPARISON" ? [grade] : []);
  const regimeReport = run.challengerVersion === ATI_REGIME_INSTRUMENT_CHALLENGER ? (() => {
    const observed = rows.filter((row) => row.coverage === "OBSERVED");
    const instrument = observed.find((row) => row.regimeAssessment)?.regimeAssessment?.instrument ?? null;
    const assessments = observed.filter((row) => boundAtiRegimeAssessment(row.regimeAssessment, {
      observedAtMs: +row.observedAt, observationKey: row.observationKey, instrument,
    }));
    return {
      instrument, unattestedBars: observed.length - assessments.length,
      transitions: summarizeAtiRegimeTransitions(assessments.map((row) => row.regimeAssessment!), BAR_MS),
      cohorts: atiObservedRegime.options.map((regime) => {
        const cohort = assessments.filter((row) => row.regimeAssessment?.regime === regime);
        const candidates = cohort.filter((row) => row.setup === run.setup && isAtiEntryDecision(row.baselineOutcome));
        const grades = candidates.flatMap(({ grade, baselineOutcome, challengerOutcome, regimeAssessment }) =>
          grade?.state === "SIMULATED_FILL" && atiRegimeOutcome(baselineOutcome, regimeAssessment) === challengerOutcome ? [grade] : []);
        return {
          regime, observedBars: cohort.length, eligible: candidates.length, unresolved: candidates.length - grades.length,
          quoteSideOnly: summarizeAtiShadowGrades(grades, "quoteSidePnl"),
          withAssumedCosts: run.assumedCosts ? summarizeAtiShadowGrades(grades, "pnlWithAssumedCosts") : null,
          withMeasuredCosts: measuredCostProfile ? summarizeAtiShadowGrades(grades, "pnlWithMeasuredCosts") : null,
        };
      }),
    };
  })() : null;
  // Once capture ends, late receipts still settle the original dispatch cohort.
  const now = Date.now();
  const costCutoff = asOf ?? (now >= +run.endsAt ? new Date(now) : undefined);
  const executionCosts = await readAtiExecutionCosts(ownerId, run.symbol, run.startedAt, run.endsAt, costCutoff);
  const { ownerId: _ownerId, researchSource: _source, researchMode: _mode, measuredCostProfile: _storedProfile, ...runInfo } = run;
  return {
    ...runInfo,
    ...(asOf ? { asOf } : {}),
    executionAuthority: AUTHORITY,
    decisionScope: native ? ATI_FLEET_SCOPE : ATI_SHADOW_DECISION_SCOPE,
    captureMode: native ? ATI_FLEET_CAPTURE : "ON_DEMAND",
    outcomeEvaluation: "SIMULATED_FILLS_ON_OBSERVED_VENUE_QUOTES",
    ...(native ? { fleetCohorts: [...nativeGroups.values()].map(group => {
      const first = group[0]!;
      const version = first.fleetReceipt!.version;
      const entries = group.filter(row => isAtiEntryDecision(row.baselineOutcome));
      const settled = entries.flatMap(row => row.grade?.state === "SIMULATED_FILL" ? [row.grade] : []);
      return {
        version, sourceIdentity: first.fleetSource, symbol: run.symbol, setup: run.setup, timeframe: run.timeframe,
        baselineVersion: run.baselineVersion, challengerVersion: run.challengerVersion, agentId: run.agentId,
        hasVerifiedVersion: version.build.sourceState === "clean" && !!version.build.revision && !!version.decisionSettingsHash,
        matchingBars: group.length, eligibleEntries: entries.length, changedDecisions: group.filter(r => r.baselineOutcome !== r.challengerOutcome).length,
        pending: entries.filter(r => r.grade == null).length, unresolved: entries.filter(r => r.grade?.state === "UNRESOLVED").length,
        unverifiedEntry: entries.filter(r => r.grade?.state === "UNRESOLVED" && r.grade.reason === "ENTRY_UNVERIFIED").length,
        quoteSideOnly: summarizeAtiShadowGrades(settled, "quoteSidePnl"),
        withAssumedCosts: run.assumedCosts ? summarizeAtiShadowGrades(settled, "pnlWithAssumedCosts") : null,
      };
    }) } : {}),
    executionCosts,
    measuredCostProfile: measuredCostProfile as AtiMeasuredCostProfile | null,
    simulations: {
      quoteSideOnly: summarizeAtiShadowGrades(fills, "quoteSidePnl", retests, guardians),
      withAssumedCosts: run.assumedCosts ? summarizeAtiShadowGrades(fills, "pnlWithAssumedCosts", retests, guardians) : null,
      withMeasuredSlippage: measuredCostProfile ? summarizeAtiShadowGrades(fills, "pnlWithMeasuredSlippage", retests, guardians) : null,
      withMeasuredCosts: measuredCostProfile ? summarizeAtiShadowGrades(fills, "pnlWithMeasuredCosts", retests, guardians) : null,
    },
    counts: {
      observations: rows.length,
      paired: paired.length,
      different: paired.filter((row) => row.baselineOutcome !== row.challengerOutcome).length,
      noObservedFeed: rows.filter((row) => row.coverage === "NO_OBSERVED_FEED").length,
      sourceChanged: rows.filter((row) => row.coverage === "SOURCE_CHANGED").length,
      ungraded: eligible.filter((row) => !row.grade).length,
      unresolved: eligible.filter(({ grade }) => grade?.state === "UNRESOLVED" ||
        (grade?.state === "GUARDIAN_COMPARISON" && grade.status === "UNRESOLVED") ||
        (grade?.state === "RETEST_COMPARISON" && (grade.baseline.state === "UNRESOLVED" || grade.challenger.state === "UNRESOLVED"))).length,
    },
    ...(run.challengerVersion === guardianComparisonPolicy.version ? { guardianPolicy: guardianComparisonPolicy,
      guardianCoverage: { eligible: eligible.length, pending: eligible.filter(({ grade }) => !grade).length,
        noFill: guardians.filter((grade) => grade.status === "NO_FILL").length,
        settledPairs: guardians.filter((grade) => grade.status === "SETTLED_PAIR").length,
        unresolved: eligible.filter(({ grade }) => grade?.state === "UNRESOLVED" ||
          (grade?.state === "GUARDIAN_COMPARISON" && grade.status === "UNRESOLVED")).length } } : {}),
    ...(run.challengerVersion === ATI_RETEST_CHALLENGER ? {
      retestCoverage: { planned: eligible.filter((row) => row.retestPlan).length,
        pending: eligible.filter((row) => row.retestPlan && !row.grade).length,
        challengerFills: retests.filter((grade) => grade.challenger.state === "SIMULATED_FILL").length,
        challengerNoFills: retests.filter((grade) => grade.challenger.state === "NO_FILL").length,
        challengerUnresolved: retests.filter((grade) => grade.challenger.state === "UNRESOLVED").length +
          eligible.filter((row) => row.retestPlan && row.grade?.state === "UNRESOLVED").length },
      pnlRiskBasis: "FROZEN_PLANNED_STOP_DISTANCE",
    } : {}),
    ...(regimeReport ? { regimeReport } : {}),
    observations: rows.map(({ decisionQuote, fleetSource: _sourceIdentity, fleetPriceOrigin, fleetReceipt, chartConfirmation, counterargument, retestPlan, regimeAssessment, ...row }) => ({
      ...row,
      ...(fleetReceipt ? { fleetReceipt, fleetPrice: fleetPriceOrigin ? {
        symbol: fleetPriceOrigin.symbol, epoch: fleetPriceOrigin.epoch,
      } : null } : {}),
      ...(chartConfirmation ? { chartConfirmation } : {}),
      ...(counterargument ? { counterargument } : {}),
      ...(retestPlan ? { retestPlan } : {}),
      ...(regimeAssessment ? { regimeAssessment } : {}),
      decisionQuote: decisionQuote && {
        ...decisionQuote,
        spreadPriceUnits: decisionQuote.ask - decisionQuote.bid,
      },
    })),
  };
}
