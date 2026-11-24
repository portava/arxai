import { randomUUID } from "node:crypto";
import { and, asc, desc, eq, gt, gte, isNotNull, lt, sql } from "drizzle-orm";
import { atiResearchSealsTable as seals, atiResearchStudiesTable as studies, atiShadowObservationsTable as observations,
  atiShadowOutcomesTable as outcomes, atiShadowRunsTable as runs, db, selfTradeAgentsTable as agents,
  selfTradeAgentSettingsTable as settings } from "@workspace/db";
import type { DecisionCandidate } from "@workspace/domain/self-trade";
import { atiMt5QuoteOrigin } from "../data/atiMt5QuoteOrigin.js";
import { atiDerivQuoteOrigin } from "../data/atiDerivQuotes.js";
import { getBuildIdentity } from "../startup/buildIdentity.js";
import { ATI_DERIV_ARCHIVE_GRADE_VERSION, ATI_MT5_GRADE_VERSION, ATI_RETEST_GRADE_VERSION,
  ATI_SHADOW_DECISION_SCOPE, atiShadowDefinition, gradeAtiShadowPair, type AtiShadowGrade } from "./atiShadowGrading.js";
import { loadAtiMt5ReplayQuotes, type AtiMt5ReplayQuote } from "./atiMt5QuoteReplay.js";
import { loadAtiDerivReplayQuotes } from "./atiDerivQuoteReplay.js";
import { selectAtiMeasuredCosts, type AtiMeasuredCostProfile } from "./atiMeasuredCosts.js";
import { ATI_GUARDIAN_GRADE_VERSION, guardianComparisonPolicy } from "./atiGuardian.js";
import { ATI_RETEST_CHALLENGER, atiCounterargumentEvidence, atiRetestPlan, isAtiCounterargumentChallenger } from "./atiCounterargument.js";
import { ATI_REGIME_INSTRUMENT_CHALLENGER, atiInstrumentProfileSchema, atiRegimeAssessment } from "./atiRegimeInstrument.js";
import { ATI_WALK_FORWARD_VERSION, atiResearchDataset, atiResearchInput, canonicalResearch, evaluateAtiResearch, researchRegistration, atiReplicationPolicy,
  type AtiResearchDataset, type AtiResearchInput } from "./atiResearchModel.js";

const researchLock = 1096042834; // ATI research registration and overlap checks, keyed by authenticated owner.
const databaseClock = sql`SELECT floor(extract(epoch from clock_timestamp()) * 1000)::double precision AS at`;
const maxDatasetBytes = 12 * 1024 * 1024;

type Registration = ReturnType<typeof researchRegistration>;
type Study = typeof studies.$inferSelect;
type Seal = typeof seals.$inferSelect;
type Run = typeof runs.$inferSelect;
const ms = (value: Date | null) => value == null ? null : +value;

const replayColumns = {
  observedAt: observations.observedAt, sourceIdentity: observations.sourceIdentity, challenger: observations.challengerOutcome,
  baselinePlan: sql<DecisionCandidate | null>`${observations.evidence}->'baseline'`,
  mt5Origin: sql<unknown>`${observations.evidence}->'mt5QuoteOrigin'`,
  derivOrigin: sql<unknown>`${observations.evidence}->'derivQuoteOrigin'`,
  retestPlan: sql<unknown>`${observations.evidence}->'retestPlan'`,
  regimeAssessment: sql<unknown>`${observations.evidence}->'regimeAssessment'`,
  decisionQuote: sql<AtiMt5ReplayQuote | null>`${observations.evidence}->'quote'`,
};
type ReplayInput = { observedAt: Date; sourceIdentity: string | null; challenger: string; baselinePlan: DecisionCandidate | null;
  mt5Origin: unknown; derivOrigin: unknown; retestPlan: unknown; regimeAssessment: unknown; decisionQuote: AtiMt5ReplayQuote | null };

function replayInputHash(row: ReplayInput, venue: "deriv_public" | "mt5_broker") {
  return canonicalResearch([+row.observedAt, row.sourceIdentity, row.challenger,
    row.baselinePlan, venue === "mt5_broker" ? row.mt5Origin : row.derivOrigin, row.decisionQuote,
    ...(row.retestPlan != null ? [row.retestPlan] : []),
    ...(row.regimeAssessment != null ? [row.regimeAssessment] : [])]).hash;
}

function withoutResearchBuild<T extends { state: string; researchBuild?: unknown }>(grade: T) {
  const { researchBuild: _build, ...outcome } = grade;
  return outcome;
}

function gradeHash(grade: AtiShadowGrade & { researchBuild?: unknown }) {
  return canonicalResearch(withoutResearchBuild(grade)).hash;
}

function studyScope(ownerId: number, agentId: number) {
  return and(eq(studies.ownerId, ownerId), eq(studies.agentId, agentId));
}

function runScope(ownerId: number, agentId: number, runId: string) {
  return and(eq(runs.id, runId), eq(runs.ownerId, ownerId), eq(runs.agentId, agentId), isNotNull(runs.researchSource));
}

function integrity(): never {
  throw new Error("ATI_RESEARCH_EVIDENCE_INTEGRITY");
}

function verifyRegistration(study: Study, run: Run): Registration {
  const stored = JSON.parse(study.registration) as Registration;
  const parsed = atiResearchInput.safeParse(stored.spec);
  if (!parsed.success) return integrity();
  const { spec } = stored;
  if (study.runId !== run.id || study.ownerId !== run.ownerId || study.agentId !== run.agentId ||
      study.requestId !== spec.requestId || +study.registeredAt >= spec.startsAtMs ||
      run.symbol !== spec.symbol || run.setup !== spec.setup || run.researchSource !== spec.market.source ||
      run.researchMode !== spec.market.mode || +run.startedAt !== spec.startsAtMs || +run.endsAt !== spec.holdoutEndsAtMs ||
      run.timeframe !== stored.definition.timeframe || run.baselineVersion !== stored.definition.baselineVersion ||
      run.challengerVersion !== stored.definition.challengerVersion ||
      canonicalResearch(run.assumedCosts).hash !== canonicalResearch(spec.costs.basis === "ASSUMED" ? spec.costs.assumptions : null).hash) return integrity();
  const instrument = spec.challengerVersion === ATI_REGIME_INSTRUMENT_CHALLENGER
    ? atiInstrumentProfileSchema.safeParse(stored.instrumentProfile) : null;
  if (instrument && !instrument.success) return integrity();
  const expected = researchRegistration(run.id, run.ownerId, run.agentId, +study.registeredAt, parsed.data, stored.build, instrument?.data);
  const { canonical, hash } = canonicalResearch(expected);
  if (canonical !== study.registration || hash !== study.registrationHash) return integrity();
  return expected;
}

export async function registerAtiResearch(ownerId: number, agentId: number, input: AtiResearchInput) {
  const parsed = atiResearchInput.safeParse(input);
  if (!parsed.success) return { status: "INVALID_REGISTRATION" as const };
  const spec = parsed.data;
  return db.transaction(async (tx) => {
    await tx.execute(sql`SELECT pg_advisory_xact_lock(${researchLock}::int, ${ownerId}::int)`);
    const [agent] = await tx.select({ allowedSymbols: settings.allowedSymbols }).from(agents)
      .innerJoin(settings, eq(settings.agentId, agents.id)).where(and(eq(agents.id, agentId),
        eq(agents.ownerType, "USER"), eq(agents.ownerId, ownerId))).limit(1);
    if (!Array.isArray(agent?.allowedSymbols) || !agent.allowedSymbols.some((value) =>
      typeof value === "string" && value.trim() === spec.symbol)) return { status: "AGENT_UNAVAILABLE" as const };

    const [existing] = await tx.select({ study: studies, run: runs }).from(studies)
      .innerJoin(runs, eq(runs.id, studies.runId)).where(and(studyScope(ownerId, agentId), eq(studies.requestId, spec.requestId))).limit(1);
    if (existing) {
      const registration = verifyRegistration(existing.study, existing.run);
      if (canonicalResearch(registration.spec).hash !== canonicalResearch(spec).hash) return { status: "REQUEST_CONFLICT" as const };
      return { status: "ALREADY_REGISTERED" as const, registration, registrationHash: existing.study.registrationHash };
    }

    const { rows: [clock] } = await tx.execute<{ at: number }>(databaseClock);
    if (!clock || spec.startsAtMs <= clock.at) return { status: "START_MUST_BE_FUTURE" as const };
    const [overlap] = await tx.select({ id: runs.id }).from(runs).where(and(
      eq(runs.ownerId, ownerId), eq(runs.agentId, agentId), eq(runs.symbol, spec.symbol), eq(runs.setup, spec.setup),
      eq(runs.researchSource, spec.market.source), sql`${runs.researchMode} is not distinct from ${spec.market.mode}::text`,
      lt(runs.startedAt, new Date(spec.holdoutEndsAtMs)), gt(runs.endsAt, new Date(spec.startsAtMs)),
    )).limit(1);
    if (overlap) return { status: "OVERLAPPING_STUDY" as const };

    const runId = randomUUID();
    const registration = researchRegistration(runId, ownerId, agentId, clock.at, spec, getBuildIdentity());
    if (spec.replicates) {
      const parentId = spec.replicates.runId;
      const [parent] = await tx.select({ study:studies, run:runs, seal:seals }).from(runs)
        .innerJoin(studies,and(eq(studies.runId,runs.id),studyScope(ownerId,agentId)))
        .innerJoin(seals,eq(seals.runId,studies.runId)).where(runScope(ownerId,agentId,parentId)).limit(1);
      if (!parent || +parent.seal.sealedAt >= clock.at) return {status:"SEALED_PARENT_UNAVAILABLE" as const};
      const original = verifyRegistration(parent.study,parent.run);
      const checked = releaseSeal(original,parent.study.registrationHash,parent.seal);
      if (original.spec.replicates || spec.replicates.datasetHash !== checked.datasetHash || spec.replicates.resultHash !== checked.resultHash ||
          atiReplicationPolicy(original) !== atiReplicationPolicy(registration) ||
          canonicalResearch(original.build).hash !== canonicalResearch(registration.build).hash) {
        return {status:"REPLICATION_IDENTITY_MISMATCH" as const};
      }
      const [prior] = await tx.select({id:studies.runId}).from(studies).where(and(studyScope(ownerId,agentId),
        sql`(${studies.registration}::jsonb #>> '{spec,replicates,runId}') = ${parentId}`)).limit(1);
      if (prior) return {status:"REPLICATION_ALREADY_DESIGNATED" as const};
    }
    const { canonical, hash } = canonicalResearch(registration);
    await tx.insert(runs).values({ id: runId, ownerId, agentId, symbol: spec.symbol, setup: spec.setup,
      timeframe: atiShadowDefinition.timeframe, baselineVersion: atiShadowDefinition.baselineVersion,
      challengerVersion: registration.definition.challengerVersion, startedAt: new Date(spec.startsAtMs),
      endsAt: new Date(spec.holdoutEndsAtMs), researchSource: spec.market.source, researchMode: spec.market.mode,
      assumedCosts: spec.costs.basis === "ASSUMED" ? spec.costs.assumptions : null,
    });
    await tx.insert(studies).values({ runId, ownerId, agentId, requestId: spec.requestId, registration: canonical,
      registrationHash: hash, registeredAt: new Date(clock.at) });
    return { status: "REGISTERED" as const, registration, registrationHash: hash };
  });
}

function releaseSeal(registration: Registration, registrationHash: string, seal: Seal) {
  const parsed = atiResearchDataset.safeParse(JSON.parse(seal.dataset));
  if (!parsed.success || +seal.sealedAt < registration.gradeCutoffMs || parsed.data.registrationHash !== registrationHash) return integrity();
  const dataset = parsed.data;
  const { canonical, hash } = canonicalResearch(dataset);
  if (canonical !== seal.dataset || hash !== seal.datasetHash) return integrity();
  const result = evaluateAtiResearch(registration, dataset);
  if (canonicalResearch(result).hash !== seal.resultHash || result.verdict !== seal.verdict) return integrity();
  return { status: "SEALED" as const, registration, registrationHash, dataset, result,
    datasetHash: seal.datasetHash, resultHash: seal.resultHash, sealedAt: seal.sealedAt.toISOString() };
}

export async function readAtiResearch(ownerId: number, agentId: number, runId: string) {
  const [row] = await db.select({ study: studies, run: runs, seal: seals }).from(runs)
    .innerJoin(studies, and(eq(studies.runId, runs.id), studyScope(ownerId, agentId)))
    .leftJoin(seals, eq(seals.runId, studies.runId)).where(runScope(ownerId, agentId, runId)).limit(1);
  if (!row) return null;
  const registration = verifyRegistration(row.study, row.run);
  return row.seal ? releaseSeal(registration, row.study.registrationHash, row.seal)
    : { status: "REGISTERED" as const, registration, registrationHash: row.study.registrationHash };
}

/** Independent forward evidence for one exact research experiment. Only sealed
 * reports can release outcomes. This packet carries no trading authority. */
export async function readAtiReplication(ownerId: number, agentId: number, runId: string) {
  const parent = await readAtiResearch(ownerId,agentId,runId);
  if (!parent) return null;
  const summary = (study: NonNullable<typeof parent>) => ({
    runId:study.registration.runId, registrationHash:study.registrationHash, status:study.status,
    build:study.registration.build, startsAtMs:study.registration.spec.startsAtMs, endsAtMs:study.registration.spec.holdoutEndsAtMs,
    sealed:study.status === "SEALED" ? {datasetHash:study.datasetHash,resultHash:study.resultHash,sealedAt:study.sealedAt,
      sourceIdentity: study.dataset.sourceIdentity, decisionSettingsHash: study.dataset.decisionSettingsHash,
      verdict:study.result.verdict,phases:study.result.phases.map(p => ({name:p.name,eligible:p.eligible,
        changedPairs:p.changedPairs,meanDeltaR:p.meanDeltaR,drawdownIncreaseR:p.drawdownIncreaseR,
        evidenceGaps:p.evidenceGaps,rejectionReasons:p.rejectionReasons}))} : null,
  });
  const { spec, definition, agentId: registeredAgentId } = parent.registration;
  const comparison = {
    agentId: registeredAgentId,
    decisionScope: ATI_SHADOW_DECISION_SCOPE,
    symbol: spec.symbol,
    setup: spec.setup,
    timeframe: definition.timeframe,
    baselineVersion: definition.baselineVersion,
    challengerVersion: definition.challengerVersion,
    market: spec.market,
    costs: spec.costs,
  };
  const head = { comparison, primary: summary(parent), policyHash: atiReplicationPolicy(parent.registration),
    scope: "SEALED_SHADOW_STUDY_COMPARISON" as const, executionAuthority: "NONE" as const };
  const [child,extra] = await db.select({id:studies.runId}).from(studies).where(and(studyScope(ownerId,agentId),
    sql`(${studies.registration}::jsonb #>> '{spec,replicates,runId}') = ${runId.toLowerCase()}`)).limit(2);
  if (extra) return integrity();
  const forward = child ? await readAtiResearch(ownerId,agentId,child.id) : null;
  const gaps: string[] = [];
  if (parent.status !== "SEALED") gaps.push("PRIMARY_UNSEALED");
  else if (parent.result.verdict !== "FORWARD_REVIEW_REQUIRED") gaps.push("PRIMARY_" + parent.result.verdict);
  if (!forward) gaps.push("NO_DESIGNATED_FORWARD_STUDY");
  else if (forward.status !== "SEALED") gaps.push("FORWARD_UNSEALED");
  else if (forward.result.verdict !== "FORWARD_REVIEW_REQUIRED") gaps.push("FORWARD_" + forward.result.verdict);
  if (forward && parent.status === "SEALED") {
    const link = forward.registration.spec.replicates;
    if (parent.registration.spec.replicates || link?.runId !== parent.registration.runId ||
        link.datasetHash !== parent.datasetHash || link.resultHash !== parent.resultHash ||
        Date.parse(parent.sealedAt) >= forward.registration.registeredAtMs ||
        atiReplicationPolicy(forward.registration) !== head.policyHash) gaps.push("REPLICATION_IDENTITY_MISMATCH");
    const build = parent.registration.build, other = forward.registration.build;
    if (!build.revision || build.sourceState !== "clean" || other.revision !== build.revision || other.sourceState !== "clean")
      gaps.push("BUILD_UNVERIFIED");
    if (forward.status === "SEALED" && (!parent.dataset.decisionSettingsHash ||
        parent.dataset.decisionSettingsHash !== forward.dataset.decisionSettingsHash ||
        !parent.dataset.sourceIdentity || parent.dataset.sourceIdentity !== forward.dataset.sourceIdentity))
      gaps.push("SOURCE_OR_SETTINGS_MISMATCH");
  }
  return {...head,forward:forward ? summary(forward) : null, gaps,
    status:gaps.length ? "FORWARD_EVIDENCE_INCOMPLETE" as const : "PASSED_REGISTERED_FORWARD_COMPARISON" as const};
}

export async function replayAtiResearchObservation(ownerId: number, agentId: number, runId: string, observationKey: string) {
  const study = await readAtiResearch(ownerId, agentId, runId);
  if (!study) return null;
  const authority = { executionAuthority: "NONE" as const };
  if (study.status !== "SEALED") return { status: "STUDY_NOT_SEALED" as const, ...authority };
  const episode = study.dataset.observations.find((row) => row.observationKey === observationKey);
  if (!episode) return null;
  const spec = study.registration.spec;
  const proof = spec.market.source === "mt5_broker" ? episode.mt5ReplayProof : episode.derivReplayProof;
  if (!proof || !episode.evidence || (!episode.evidence.fill && !episode.evidence.retest && !episode.evidence.guardian)) return { status: "NO_ARCHIVE_PROOF" as const, ...authority };
  const [row] = await db.select({ ...replayColumns, measuredCostProfile: runs.measuredCostProfile }).from(runs)
    .innerJoin(observations, and(eq(observations.runId, runs.id), eq(observations.observationKey, observationKey)))
    .where(runScope(ownerId, agentId, runId)).limit(1);
  if (!row) return { status: "ARCHIVE_UNAVAILABLE" as const, ...authority };
  const cohort = study.dataset;
  const measuredCostHash = row.measuredCostProfile ? canonicalResearch(row.measuredCostProfile).hash : null;
  if (!row.baselinePlan || !row.decisionQuote || episode.sourceIdentity !== cohort.sourceIdentity ||
      replayInputHash(row, spec.market.source) !== proof.inputHash ||
      measuredCostHash !== cohort.measuredCostProfileHash) return { status: "ARCHIVE_MISMATCH" as const, ...authority };

  const decisionAt = +row.observedAt;
  const evaluatedAt = episode.evidence.evaluatedAtMs;
  const through = Math.min(evaluatedAt, decisionAt + study.registration.holdWindowMs);
  const plan = row.retestPlan != null ? atiRetestPlan.safeParse(row.retestPlan) : null;
  if (plan && (!plan.success || spec.challengerVersion !== ATI_RETEST_CHALLENGER)) return { status: "ARCHIVE_MISMATCH" as const, ...authority };
  const input = {
    source: spec.market.source, symbol: spec.symbol, observedAt: decisionAt, baseline: row.baselinePlan, challengerOutcome: row.challenger,
    assumedCosts: spec.costs.basis === "ASSUMED" ? spec.costs.assumptions : null,
    guardian: spec.challengerVersion === guardianComparisonPolicy.version,
    usePlannedRisk: spec.challengerVersion === ATI_RETEST_CHALLENGER, retestPlan: plan?.data,
  };
  let grade: AtiShadowGrade | null;
  if (spec.market.source === "mt5_broker") {
    const origin = atiMt5QuoteOrigin.safeParse(row.mt5Origin);
    if (!origin.success || origin.data.mode !== spec.market.mode) return { status: "ARCHIVE_MISMATCH" as const, ...authority };
    const rows = await loadAtiMt5ReplayQuotes(ownerId, origin.data, decisionAt, through);
    if (!rows.length) return { status: "ARCHIVE_UNAVAILABLE" as const, ...authority };
    grade = gradeAtiShadowPair({ ...input,
      measuredCosts: selectAtiMeasuredCosts(row.measuredCostProfile as AtiMeasuredCostProfile | null, origin.data, row.sourceIdentity, decisionAt),
      mt5Replay: { origin: origin.data, quote: row.decisionQuote, rows },
    }, evaluatedAt);
  } else {
    const origin = atiDerivQuoteOrigin.safeParse(row.derivOrigin);
    if (!origin.success) return { status: "ARCHIVE_MISMATCH" as const, ...authority };
    const rows = await loadAtiDerivReplayQuotes(origin.data, through);
    if (!rows.length) return { status: "ARCHIVE_UNAVAILABLE" as const, ...authority };
    grade = gradeAtiShadowPair({ ...input, derivReplay: { origin: origin.data, quote: row.decisionQuote, rows } }, evaluatedAt);
  }
  if ((grade?.state !== "SIMULATED_FILL" && grade?.state !== "RETEST_COMPARISON" && grade?.state !== "GUARDIAN_COMPARISON") || gradeHash(grade) !== proof.gradeHash) {
    return { status: "ARCHIVE_MISMATCH" as const, ...authority };
  }
  return { status: "REPRODUCED" as const, observationKey, evaluatedAtMs: evaluatedAt,
    datasetHash: study.datasetHash, gradeHash: proof.gradeHash, grade, ...authority };
}

export async function listAtiResearch(ownerId: number, agentId: number, limit: number) {
  const rows = await db.select({ study: studies, run: runs, datasetHash: seals.datasetHash, resultHash: seals.resultHash,
    verdict: seals.verdict, sealedAt: seals.sealedAt })
    .from(studies).innerJoin(runs, and(eq(runs.id, studies.runId), eq(runs.ownerId, ownerId), eq(runs.agentId, agentId),
      isNotNull(runs.researchSource))).leftJoin(seals, eq(seals.runId, studies.runId))
    .where(studyScope(ownerId, agentId)).orderBy(desc(studies.registeredAt), desc(studies.runId)).limit(limit);
  return rows.map((row) => ({
    registration: verifyRegistration(row.study, row.run), registrationHash: row.study.registrationHash,
    seal: row.sealedAt ? { sealedAt: row.sealedAt.toISOString(), datasetHash: row.datasetHash,
      resultHash: row.resultHash, verdict: row.verdict } : null,
  }));
}

function fillFrom(grade: AtiShadowGrade | null): NonNullable<AtiResearchDataset["observations"][number]["evidence"]>["fill"] {
  if (grade?.state !== "SIMULATED_FILL") return null;
  const { exitObservedAt, baselineSizeRatio, challengerSizeRatio, quoteSidePnl, pnlWithAssumedCosts,
    quoteSource, entry, exit, exitReason, riskPriceUnits } = grade;
  return { exitObservedAt, baselineSizeRatio, challengerSizeRatio, quoteSidePnl, pnlWithAssumedCosts,
    pnlWithMeasuredCosts: grade.pnlWithMeasuredCosts ?? null, quoteSource, entry, exit,
    exitReason, riskPriceUnits, mt5Mode: grade.mt5Replay?.mode ?? null,
    ...(grade.pnlRiskBasis ? { pnlRiskBasis: grade.pnlRiskBasis } : {}) };
}

function hasArchivedReplay(grade: AtiShadowGrade | null, version: string | null, venue: "mt5_broker" | "deriv_public") {
  if (grade?.state === "GUARDIAN_COMPARISON") return version === ATI_GUARDIAN_GRADE_VERSION && grade.quoteSource === venue &&
    !!(grade.archivePrefixHash || grade.noFill?.tapeHash);
  if (grade?.state === "RETEST_COMPARISON") return version === ATI_RETEST_GRADE_VERSION && grade.quoteSource === venue &&
    (grade.baseline.state !== "UNRESOLVED" || grade.challenger.state !== "UNRESOLVED");
  if (grade?.state !== "SIMULATED_FILL") return false;
  return venue === "mt5_broker" ? version === ATI_MT5_GRADE_VERSION && !!grade.mt5Replay?.tapeHash
    : version === ATI_DERIV_ARCHIVE_GRADE_VERSION && !!grade.derivReplay?.tapeHash;
}

function counterargumentFrom(evidence: unknown) {
  const parsed = atiCounterargumentEvidence.safeParse(evidence);
  if (!parsed.success) return {};
  const { history: _history, ...review } = parsed.data;
  return { counterargument: { ...review, evidenceHash: canonicalResearch(parsed.data).hash } };
}

export async function sealAtiResearch(ownerId: number, agentId: number, runId: string) {
  return db.transaction(async (tx) => {
    // Research observation and grade writers use this same run lock.
    const [run] = await tx.select().from(runs).where(runScope(ownerId, agentId, runId)).for("update");
    if (!run) return null;
    const [study] = await tx.select().from(studies).where(and(studyScope(ownerId, agentId), eq(studies.runId, runId)));
    if (!study) return integrity();
    const registration = verifyRegistration(study, run);
    const [existing] = await tx.select().from(seals).where(eq(seals.runId, runId));
    if (existing) return releaseSeal(registration, study.registrationHash, existing);

    const { rows: [clock] } = await tx.execute<{ at: number }>(databaseClock);
    if (!clock || clock.at < registration.gradeCutoffMs) return { status: "GRADE_WINDOW_OPEN" as const };
    const cutoff = new Date(registration.gradeCutoffMs);
    const rows = await tx.select({
      ...replayColumns,
      observationKey: observations.observationKey, recordedAt: observations.recordedAt,
      coverage: observations.coverage, setup: observations.setup, baseline: observations.baselineOutcome,
      captureBuild: sql<unknown>`${observations.evidence}->'researchBuild'`,
      decisionSettingsHash: sql<string | null>`${observations.evidence}->>'decisionSettingsHash'`,
      counterargument: sql<unknown>`${observations.evidence}->'counterargument'`,
      grade: sql<AtiShadowGrade | null>`${outcomes.evidence}`,
      gradeBuild: sql<unknown>`${outcomes.evidence}->'researchBuild'`,
      evaluatedAt: outcomes.evaluatedAt, gradeRecordedAt: outcomes.recordedAt, version: outcomes.gradeVersion,
    }).from(observations).leftJoin(outcomes, and(eq(outcomes.runId, observations.runId),
      eq(outcomes.observationKey, observations.observationKey), lt(outcomes.evaluatedAt, cutoff), lt(outcomes.recordedAt, cutoff)))
      .where(and(eq(observations.runId, runId), gte(observations.observedAt, run.startedAt),
        lt(observations.observedAt, run.endsAt), lt(observations.recordedAt, cutoff)))
      .orderBy(asc(observations.observedAt), asc(observations.observationKey));

    const firstObserved = rows.find((row) => row.coverage === "OBSERVED");
    const usesRetest = registration.definition.challengerVersion === ATI_RETEST_CHALLENGER;
    const usesGuardian = registration.definition.challengerVersion === guardianComparisonPolicy.version;
    const archiveProofs = usesGuardian || registration.runnerVersion === ATI_WALK_FORWARD_VERSION || usesRetest ||
      registration.definition.challengerVersion === ATI_REGIME_INSTRUMENT_CHALLENGER;
    const data = atiResearchDataset.safeParse({
      registrationHash: study.registrationHash,
      sourceIdentity: firstObserved?.sourceIdentity ?? null,
      decisionSettingsHash: firstObserved?.decisionSettingsHash ?? null,
      measuredCostProfileHash: run.measuredCostProfile ? canonicalResearch(run.measuredCostProfile).hash : null,
      observations: rows.map((row) => {
        const regime = registration.definition.challengerVersion === ATI_REGIME_INSTRUMENT_CHALLENGER
          ? atiRegimeAssessment.safeParse(row.regimeAssessment) : null;
        return {
          observationKey: row.observationKey, observedAtMs: +row.observedAt, recordedAtMs: ms(row.recordedAt),
          sourceIdentity: row.sourceIdentity, coverage: row.coverage, setup: row.setup,
          baseline: row.baseline, challenger: row.challenger, captureBuild: row.captureBuild, decisionSettingsHash: row.decisionSettingsHash,
          ...(isAtiCounterargumentChallenger(registration.definition.challengerVersion) ? counterargumentFrom(row.counterargument) : {}),
          ...(usesRetest && row.retestPlan != null ? { retestPlan: row.retestPlan } : {}),
          ...(regime?.success ? { regimeAssessment: regime.data } : {}),
          ...(archiveProofs && row.grade && hasArchivedReplay(row.grade, row.version, "mt5_broker") && row.baselinePlan && row.decisionQuote &&
              row.sourceIdentity != null && row.sourceIdentity === firstObserved?.sourceIdentity &&
              row.coverage === "OBSERVED" && atiMt5QuoteOrigin.safeParse(row.mt5Origin).success
            ? { mt5ReplayProof: { inputHash: replayInputHash(row, "mt5_broker"), gradeHash: gradeHash(row.grade) } } : {}),
          ...(archiveProofs && row.grade && hasArchivedReplay(row.grade, row.version, "deriv_public") && row.baselinePlan && row.decisionQuote &&
              row.sourceIdentity != null && row.sourceIdentity === firstObserved?.sourceIdentity &&
              row.coverage === "OBSERVED" && atiDerivQuoteOrigin.safeParse(row.derivOrigin).success
            ? { derivReplayProof: { inputHash: replayInputHash(row, "deriv_public"), gradeHash: gradeHash(row.grade) } } : {}),
          evidence: row.grade && row.version && row.evaluatedAt && row.gradeRecordedAt ? {
            evaluatedAtMs: +row.evaluatedAt, recordedAtMs: +row.gradeRecordedAt, version: row.version,
            fill: fillFrom(row.grade), unresolvedReason: row.grade.state === "UNRESOLVED" ? row.grade.reason : null, build: row.gradeBuild,
            ...(usesGuardian && row.grade.state === "GUARDIAN_COMPARISON" ? { guardian: withoutResearchBuild(row.grade) } : {}),
            ...(row.grade.state === "RETEST_COMPARISON" ? { retest: {
              state: row.grade.state, quoteSource: row.grade.quoteSource, mt5Mode: row.grade.mt5Mode,
              plannedRiskPriceUnits: row.grade.plannedRiskPriceUnits, baseline: row.grade.baseline, challenger: row.grade.challenger,
            } } : {}),
          } : null,
        };
      }),
    });
    if (!data.success) return integrity();
    const { canonical, hash } = canonicalResearch(data.data);
    if (Buffer.byteLength(canonical, "utf8") > maxDatasetBytes) return { status: "DATASET_TOO_LARGE" as const };
    const result = evaluateAtiResearch(registration, data.data);
    const resultHash = canonicalResearch(result).hash;
    const seal = { runId, dataset: canonical, datasetHash: hash, resultHash, verdict: result.verdict, sealedAt: new Date(clock.at) };
    await tx.insert(seals).values(seal);
    return releaseSeal(registration, study.registrationHash, seal);
  });
}
