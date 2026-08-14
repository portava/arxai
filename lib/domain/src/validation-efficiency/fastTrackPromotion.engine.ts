import {
  type FastTrackGates, type FastTrackDecision, type CandidateId,
} from "./validationEfficiency.types";

// ═══════════════════════════════════════════════════════════════════════════
// Fast-Track Promotion — pure ALL-of decision: only fast-track when every
// upstream gate passed AND the candidate is not flagged for any blocker.
// Even one missing gate forces fastTrack=false. Conservative on purpose.
// ═══════════════════════════════════════════════════════════════════════════

export interface FastTrackInput {
  candidateId: CandidateId;
  gates: FastTrackGates;
  // Optional structural blockers — e.g. duplicate-match action MERGE,
  // candidate is currently paused, or risk governor freeze.
  externalBlockers?: ReadonlyArray<string>;
}

export function evaluateFastTrack(input: FastTrackInput): FastTrackDecision {
  const reasons: string[] = [];
  const blockers: string[] = [...(input.externalBlockers ?? [])];

  const allPass = input.gates.replayPass && input.gates.shadowPass
    && input.gates.paperPass && input.gates.riskPass;

  if (!input.gates.replayPass) reasons.push(`replay gate FAILED`);
  if (!input.gates.shadowPass) reasons.push(`shadow gate FAILED`);
  if (!input.gates.paperPass)  reasons.push(`paper gate FAILED`);
  if (!input.gates.riskPass)   reasons.push(`risk gate FAILED`);

  if (allPass) reasons.push(`all gates PASSED (replay+shadow+paper+risk)`);

  const fastTrack = allPass && blockers.length === 0;
  if (allPass && blockers.length > 0) {
    reasons.push(`gates passed but ${blockers.length} external blocker(s) present — refusing fast-track`);
  }
  return {
    candidateId: input.candidateId, fastTrack,
    gates: input.gates, reasons, blockers,
  };
}
