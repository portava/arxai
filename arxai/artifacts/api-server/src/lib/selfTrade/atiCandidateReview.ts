import { readAtiCaptureRehearsal } from "./atiCaptureRecoveryEvidence.js";
import { DEMOTION_TRIGGERS } from "@workspace/domain/strategy-lifecycle";
import { readAtiExecutionCosts } from "./atiExecutionCosts.js";
import { ATI_FLEET_BASELINE } from "./atiFleetDefinition.js";
import { readAtiDevelopmentCapture, readAtiStudyPair, reviewAtiStudyPair } from "./atiResearchLab.js";
import { costsForEntryDecisions, type AtiReviewedPositions, type AtiEntryIdentity } from "./atiMatchedExecutionCosts.js";

type StudyPair = NonNullable<Awaited<ReturnType<typeof readAtiStudyPair>>>;
type Replay = NonNullable<Awaited<ReturnType<typeof reviewAtiStudyPair>>["archiveReplay"]>["primary"];
export function incumbentStudyCosts(positions: AtiReviewedPositions, decisions: ReadonlySet<number>, identity: AtiEntryIdentity) {
  return { reproducedDecisions: decisions.size, ...costsForEntryDecisions(positions, decisions, identity) };
}

async function reviewStudy(study: StudyPair["parent"], replay: Replay, reviewedAt: Date) {
  if (study.status !== "SEALED") {
    const { baselineVersion } = study.registration.definition;
    const capture = baselineVersion === ATI_FLEET_BASELINE ? await readAtiDevelopmentCapture(
      study.registration.ownerId, study.registration.agentId, study.registration.runId, reviewedAt,
    ) : null;
    return { status: "AWAITING_SEAL" as const, ...(capture && { developmentCapture: capture }) };
  }
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
