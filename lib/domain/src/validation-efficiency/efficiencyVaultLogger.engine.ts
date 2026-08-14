import {
  type EfficiencyLogEntry, type CandidateId,
  type PriorityScore, type EarlyFailureDecision, type FastTrackDecision,
  type SampleSizeRecommendation, type DuplicateMatch,
  type ValidationCostScore, type ValidationEfficiencyScore,
  type ControlTowerRecommendation, type QueueEntry,
} from "./validationEfficiency.types";

// ═══════════════════════════════════════════════════════════════════════════
// Efficiency Vault Logger — tiny adapter that turns engine outputs into
// well-shaped EfficiencyLogEntry payloads and forwards them to the
// Black Box Vault sink. Pure factory + safe emit (try/catch).
//
// Self-contained: no imports from other subdomains. The Vault interface
// is reduced to a single function-port so this subdomain doesn't need to
// know what's behind it.
// ═══════════════════════════════════════════════════════════════════════════

export interface EfficiencyVaultPort {
  emitVaultLog(entry: EfficiencyLogEntry): Promise<void> | void;
  newEntryId(): string;
}

export type LogKind = EfficiencyLogEntry["kind"];

function build(
  ports: EfficiencyVaultPort,
  candidateId: CandidateId,
  kind: LogKind,
  payload: unknown,
  recordedAtIso: string,
  reasons: string[],
): EfficiencyLogEntry {
  return {
    entryId: ports.newEntryId(),
    candidateId, kind,
    payloadJson: JSON.stringify(payload),
    recordedAtIso, reasons,
  };
}

async function safeEmit(
  ports: EfficiencyVaultPort,
  entry: EfficiencyLogEntry,
  blockers: string[],
): Promise<void> {
  try { await ports.emitVaultLog(entry); }
  catch (e) { blockers.push(`emitVaultLog failed for ${entry.kind}: ${(e as Error).message}`); }
}

// ── Per-engine log helpers ────────────────────────────────────────────────
export async function logPriorityScore(
  ports: EfficiencyVaultPort, score: PriorityScore, atIso: string, blockers: string[],
): Promise<void> {
  await safeEmit(ports,
    build(ports, score.candidateId, "PRIORITY_SCORE", score, atIso, score.reasons), blockers);
}

export async function logQueueSnapshot(
  ports: EfficiencyVaultPort, queue: ReadonlyArray<QueueEntry>,
  atIso: string, blockers: string[],
): Promise<void> {
  // QUEUE_SNAPSHOT is queue-wide; the candidateId field is set to "*" so
  // the entry remains shape-valid while signalling a fleet event.
  await safeEmit(ports, {
    entryId: ports.newEntryId(),
    candidateId: "*",
    kind: "QUEUE_SNAPSHOT",
    payloadJson: JSON.stringify({ size: queue.length, entries: queue }),
    recordedAtIso: atIso,
    reasons: [`snapshot of ${queue.length} entries`],
  }, blockers);
}

export async function logEarlyFailureDecision(
  ports: EfficiencyVaultPort, dec: EarlyFailureDecision, atIso: string, blockers: string[],
): Promise<void> {
  await safeEmit(ports,
    build(ports, dec.candidateId, "EARLY_FAILURE_DECISION", dec, atIso, dec.reasons), blockers);
}

export async function logFastTrackDecision(
  ports: EfficiencyVaultPort, dec: FastTrackDecision, atIso: string, blockers: string[],
): Promise<void> {
  await safeEmit(ports,
    build(ports, dec.candidateId, "FAST_TRACK_DECISION", dec, atIso, dec.reasons), blockers);
}

export async function logSampleSizeRecommendation(
  ports: EfficiencyVaultPort, rec: SampleSizeRecommendation, atIso: string, blockers: string[],
): Promise<void> {
  await safeEmit(ports,
    build(ports, rec.candidateId, "SAMPLE_SIZE_RECOMMENDATION", rec, atIso, rec.reasons), blockers);
}

export async function logDuplicateMatch(
  ports: EfficiencyVaultPort, match: DuplicateMatch, atIso: string, blockers: string[],
): Promise<void> {
  // Logged against the survivor so downstream queries can find both sides
  // via the payload (a, b, keepId, retireId).
  await safeEmit(ports,
    build(ports, match.keepId, "DUPLICATE_MATCH", match, atIso, match.reasons), blockers);
}

export async function logCostScore(
  ports: EfficiencyVaultPort, cost: ValidationCostScore, atIso: string, blockers: string[],
): Promise<void> {
  await safeEmit(ports,
    build(ports, cost.candidateId, "COST_SCORE", cost, atIso, cost.reasons), blockers);
}

export async function logEfficiencyScore(
  ports: EfficiencyVaultPort, eff: ValidationEfficiencyScore, atIso: string, blockers: string[],
): Promise<void> {
  await safeEmit(ports,
    build(ports, eff.candidateId, "EFFICIENCY_SCORE", eff, atIso, eff.reasons), blockers);
}

export async function logControlTowerRecommendation(
  ports: EfficiencyVaultPort, rec: ControlTowerRecommendation, atIso: string, blockers: string[],
): Promise<void> {
  await safeEmit(ports,
    build(ports, rec.candidateId, "CONTROL_TOWER_RECOMMENDATION", rec, atIso, rec.reasons), blockers);
}
