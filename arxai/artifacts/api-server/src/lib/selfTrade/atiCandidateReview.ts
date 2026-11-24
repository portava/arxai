import { readAtiCaptureRehearsal } from "./atiCaptureRecoveryEvidence.js";
import { DEMOTION_TRIGGERS } from "@workspace/domain/strategy-lifecycle";
import { readAtiExecutionCosts } from "./atiExecutionCosts.js";
import { ATI_FLEET_BASELINE, ATI_FLEET_ENGINE } from "./atiFleetDefinition.js";
import { readAtiStudyPair, reviewAtiStudyPair } from "./atiResearchLab.js";
import { reportAtiEntryStrategies } from "./atiRoundTrips.js";

type StudyPair = NonNullable<Awaited<ReturnType<typeof readAtiStudyPair>>>;
type Replay = NonNullable<Awaited<ReturnType<typeof reviewAtiStudyPair>>["archiveReplay"]>["primary"];
type Positions = Awaited<ReturnType<typeof readAtiExecutionCosts>>["live"]["roundTrips"]["positions"];
type EntryIdentity = { agentId: number; revision: string; symbol: string; timeframe: string; setup: string; decisionSettingsHash: string };

/** Every opening fill must belong to a reproduced study decision, including scale-ins. */
export function incumbentStudyCosts(positions: Positions, decisions: ReadonlySet<number>, identity: EntryIdentity) {
  const matched: Positions = [];
  const linked = new Set<number>();
  const reconciled = new Set<number>();
  let unresolvedPositionsWithLinkedEntry = 0, positionsWithOtherOpeningDecisions = 0;
  for (const position of positions) {
    const entries = position.deals.filter(row => row.leg === "ENTRY");
    const scoped = entries.flatMap(row => {
      const admission = row.entryStrategy;
      if (!admission || !decisions.has(admission.decisionId)) return [];
      const strategy = admission.strategy;
      return strategy.engine === ATI_FLEET_ENGINE && strategy.revision === identity.revision &&
        strategy.agentId === identity.agentId && strategy.symbol === identity.symbol && strategy.timeframe === identity.timeframe &&
        strategy.setup === identity.setup && strategy.decisionSettingsHash === identity.decisionSettingsHash ? [admission.decisionId] : [];
    });
    if (!scoped.length) continue;
    for (const id of scoped) linked.add(id);
    if (position.state !== "OBSERVED_BROKER_ROUND_TRIP") unresolvedPositionsWithLinkedEntry++;
    else if (position.attribution !== "VERIFIED_ENTRY_STRATEGY" || scoped.length !== entries.length) positionsWithOtherOpeningDecisions++;
    else {
      matched.push(position);
      for (const id of scoped) reconciled.add(id);
    }
  }
  return { reproducedDecisions: decisions.size, decisionsWithLinkedOpeningFill: linked.size,
    decisionsWithReconciledPosition: reconciled.size, reconciledPositions: matched.length,
    unresolvedPositionsWithLinkedEntry, positionsWithOtherOpeningDecisions,
    byEntryStrategy: reportAtiEntryStrategies(matched).byEntryStrategy };
}

async function reviewStudy(study: StudyPair["parent"], replay: Replay, reviewedAt: Date) {
  if (study.status !== "SEALED") return { status: "AWAITING_SEAL" as const };
  const { registration, dataset } = study;
  const capture = study.result.phases.map(phase => ({
    phase: phase.name, expectedSlots: phase.expectedSlots, observedSlots: phase.observedSlots,
    unavailableFeed: phase.exclusions.unavailableFeed, changedSource: phase.exclusions.changedSource,
    lateOrUnverified: phase.exclusions.unverifiedOrLateCapture, unresolved: phase.exclusions.unresolved,
    unavailableLabels: phase.exclusions.unavailableLabels,
  }));
  const basis = { status: "SEALED" as const, runId: registration.runId, capture,
    simulationCosts: { basis: registration.spec.costs.basis, measuredCostProfileHash: dataset.measuredCostProfileHash } };
  if (registration.definition.baselineVersion !== ATI_FLEET_BASELINE)
    return { ...basis, incumbentCosts: { status: "NO_NATIVE_FLEET_DECISION_LINK" as const } };
  if (!replay || replay.sourceDatasetHash !== study.datasetHash || registration.build.sourceState !== "clean" ||
      !registration.build.revision || !dataset.decisionSettingsHash)
    return { ...basis, incumbentCosts: { status: "STUDY_IDENTITY_UNVERIFIED" as const } };
  const reproduced = new Set(replay.receipts.filter(row => row.status === "REPRODUCED").map(row => row.observationKey));
  const decisions = new Set(dataset.observations.flatMap(row =>
    row.fleetDecision && reproduced.has(row.observationKey) && row.sourceIdentity === dataset.sourceIdentity &&
    row.fleetDecision.version.build.revision === registration.build.revision &&
    row.fleetDecision.version.decisionSettingsHash === dataset.decisionSettingsHash ? [row.fleetDecision.decisionId] : []));
  if (!decisions.size) return { ...basis, incumbentCosts: { status: "NO_REPRODUCED_NATIVE_ENTRY" as const } };
  const { ownerId, agentId, spec, definition } = registration;
  const costs = await readAtiExecutionCosts(ownerId, spec.symbol, new Date(spec.startsAtMs), new Date(spec.holdoutEndsAtMs), reviewedAt);
  const identity = { agentId, revision: registration.build.revision, symbol: spec.symbol, setup: spec.setup,
    timeframe: definition.timeframe, decisionSettingsHash: dataset.decisionSettingsHash };
  const live = incumbentStudyCosts(costs.live.roundTrips.positions, decisions, identity);
  const demo = incumbentStudyCosts(costs.demo.roundTrips.positions, decisions, identity);
  return { ...basis, incumbentCosts: { status: live.reconciledPositions || demo.reconciledPositions ? "OBSERVED_MATCHED_ROUND_TRIPS" as const : "NO_MATCHED_ROUND_TRIP" as const,
    venue: "mt5_broker" as const, eligibleReproducedDecisions: decisions.size, dispatchWindowStart: costs.dispatchWindowStart,
    dispatchWindowEndExclusive: costs.dispatchWindowEndExclusive, evidenceAsOf: reviewedAt, live, demo } };
}

export async function readAtiCandidateReview(ownerId: number, agentId: number, runId: string) {
  let pair = await readAtiStudyPair(ownerId, agentId, runId);
  if (!pair) return null;
  const primaryLink = pair.parent.registration.spec.replicates;
  if (primaryLink) {
    const requestedForward = pair.parent.registration.runId;
    pair = await readAtiStudyPair(ownerId, agentId, primaryLink.runId);
    if (pair?.forward?.registration.runId !== requestedForward) return null;
  }
  const research = await reviewAtiStudyPair(pair, true);
  const reviewedAt = new Date();
  const [primary, forward, primaryCapture, forwardCapture] = await Promise.all([
    reviewStudy(pair.parent, research.archiveReplay?.primary ?? null, reviewedAt),
    pair.forward ? reviewStudy(pair.forward, research.archiveReplay?.forward ?? null, reviewedAt) : null,
    readAtiCaptureRehearsal(pair.parent, reviewedAt),
    pair.forward ? readAtiCaptureRehearsal(pair.forward, reviewedAt) : null,
  ]);
  const captureVerified = primaryCapture?.status === "SHADOW_CAPTURE_RESTART_VERIFIED";
  const recoveryStatus = captureVerified ? "PRIMARY_SHADOW_CAPTURE_RESTART_VERIFIED" as const
    : primaryCapture || forwardCapture ? "PRIMARY_CAPTURE_RECOVERY_UNVERIFIED" as const : "NO_CANDIDATE_BOUND_RECOVERY_RECEIPT" as const;
  // The native admission stamp identifies the incumbent. Shadow challengers have no broker admission stamp.
  return { scope: "REGISTERED_ATI_CANDIDATE_REVIEW" as const, reviewedAt, executionAuthority: "NONE" as const,
    status: "EVIDENCE_INCOMPLETE" as const, research, primary, forward,
    challengerExecution: { status: "SHADOW_ONLY" as const, observedBrokerCosts: null },
    recovery: { status: recoveryStatus, primaryCapture, forwardCapture, brokerRetries: "UNVERIFIED" as const },
    rollback: { source: "ARX_STRATEGY_LIFECYCLE" as const, triggers: DEMOTION_TRIGGERS, candidateRehearsal: null },
    gaps: [...research.gaps, "CHALLENGER_BROKER_COSTS_UNAVAILABLE", ...(captureVerified ? [] : ["CANDIDATE_RECOVERY_UNVERIFIED"]),
      ...(pair.forward && forwardCapture?.status !== "SHADOW_CAPTURE_RESTART_VERIFIED" ? ["FORWARD_CAPTURE_RECOVERY_UNVERIFIED"] : []),
      "BROKER_RETRY_RECOVERY_UNVERIFIED", "CANDIDATE_ROLLBACK_UNREHEARSED"] };
}
