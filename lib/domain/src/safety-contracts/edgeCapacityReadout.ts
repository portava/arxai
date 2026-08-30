// ═══════════════════════════════════════════════════════════════════════════
// EDGE CAPACITY READOUT — what gate #23 would actually do, per edge, right now.
//
// WHY THIS EXISTS
// ---------------
// Gate #23 (EDGE_CAPACITY_EXCEEDED) currently refuses EVERY driver-placed live
// entry, on every edge, because no edge has a recorded capacity estimate. That
// is the correct behaviour — and it is completely invisible. An operator sees
// entries not happening and has no way to learn that one specific missing
// number is the reason, or which number, or who can supply it.
//
// This module makes the refusal legible. It asks the REAL gate — the same
// `evaluateEdgeCapacityGate` the dispatch pipeline calls, not a paraphrase of
// it — what it would say about an edge, and returns the verdict with the
// gate's own words.
//
// HONESTY
// -------
//   * The verdict comes from the gate function itself. If the gate changes,
//     this readout changes with it; it cannot drift into a comfortable lie.
//   * A driver-placed entry's SIZE is not known ahead of time. Rather than
//     invent a plausible candidate size, the readout evaluates the smallest
//     possible candidate and says so explicitly (`probeCandidateUsd`): it
//     answers "could this edge admit ANY entry at all", which is precisely the
//     question an all-refuse state raises. Headroom is reported separately
//     from real numbers, or as null when they are unknown.
//   * Every null is a null with a reason. Nothing degrades to a confident zero.
// ═══════════════════════════════════════════════════════════════════════════

import {
  evaluateEdgeCapacityGate,
  resolveEdgeCapacityCeilingUsd,
  EDGE_CAPACITY_STATUS_ESTIMATED,
} from "./foundationGates.js";

/**
 * The smallest candidate the readout probes with. Deliberately one cent: it is
 * the least this gate could ever be asked to admit, so a refusal at this size
 * is a refusal at EVERY size — which is what makes "would this edge admit
 * anything?" a well-posed question rather than a guess about order size.
 */
export const EDGE_CAPACITY_PROBE_CANDIDATE_USD = 0.01;

/** The recorded capacity state of one edge, as read from production_edges. */
export interface EdgeCapacityRecord {
  edgeId: number;
  /** production_edges.capacity_status — null when nothing was ever recorded. */
  capacityStatus: string | null;
  /** production_edges.capacity_max_deployed_usd — the admin-pressed ceiling. */
  capacityMaxDeployedUsd: number | null;
  /** production_edges.capacity_deploy_cap_override_usd — tighten-only. */
  capacityDeployCapOverrideUsd: number | null;
  /** production_edges.capacity_recorded_by_admin_id — who pressed, or null. */
  capacityRecordedByAdminId: number | null;
  /** production_edges.capacity_estimated_at, ISO, or null. */
  capacityEstimatedAt: string | null;
  /**
   * Cumulative USD already deployed on this edge, platform-wide. null = it
   * could not be established from real specs/prices — which is itself a
   * refusal reason, not a zero.
   */
  deployedUsd: number | null;
  /** Present only when deployedUsd is null. */
  deployedUsdUnknownReason: string | null;
}

export type EdgeCapacityBlocker =
  | "NO_ESTIMATE_RECORDED"
  | "STATUS_NOT_ESTIMATED"
  | "NO_PRESSED_USD_CEILING"
  | "DEPLOYED_SIZE_UNKNOWN"
  | "CEILING_ALREADY_FULL";

export interface EdgeCapacityReadout {
  edgeId: number;
  /**
   * Would a driver-placed LIVE entry on this edge pass gate #23 right now, at
   * the smallest conceivable size? false ⇒ it refuses at EVERY size.
   */
  wouldAdmitAnEntry: boolean;
  /** The gate's own detail string. null only when it passed. */
  gateDetail: string | null;
  /** The single reason the gate refuses, as a code an operator can act on. */
  blocker: EdgeCapacityBlocker | null;
  /** What the operator would have to do about it. null when nothing is wrong. */
  remedy: string | null;
  /** min(pressed ceiling, tighten-only override). null when unusable. */
  effectiveCeilingUsd: number | null;
  deployedUsd: number | null;
  /** ceiling − deployed. null when either side is unknown. */
  headroomUsd: number | null;
  /** The size the probe used. Disclosed so nobody reads it as a real order. */
  probeCandidateUsd: number;
  /** True when a human/ADMIN press is what is missing (as opposed to data). */
  awaitingOwnerPress: boolean;
}

/**
 * Ask the real gate what it would do about a driver-placed live entry on this
 * edge, and translate the answer into something an operator can act on.
 *
 * `required: true, edgeRefPresent: true` is the driver-placed case by
 * definition: an autonomous entry always carries its edge reference (a machine
 * entry without one is refused by this same gate for a different reason).
 */
export function readEdgeCapacityGate(rec: EdgeCapacityRecord): EdgeCapacityReadout {
  const effectiveCeilingUsd = resolveEdgeCapacityCeilingUsd(
    rec.capacityMaxDeployedUsd,
    rec.capacityDeployCapOverrideUsd,
  );

  const verdict = evaluateEdgeCapacityGate(true, {
    required: true,
    edgeRefPresent: true,
    capacityStatus: rec.capacityStatus,
    capacityDeployableUsd: rec.capacityMaxDeployedUsd,
    capacityCapOverrideUsd: rec.capacityDeployCapOverrideUsd,
    deployedUsd: rec.deployedUsd,
    candidateUsd: EDGE_CAPACITY_PROBE_CANDIDATE_USD,
  });

  let blocker: EdgeCapacityBlocker | null = null;
  let remedy: string | null = null;
  let awaitingOwnerPress = false;

  if (!verdict.passed) {
    if (rec.capacityStatus == null) {
      blocker = "NO_ESTIMATE_RECORDED";
      awaitingOwnerPress = true;
      remedy = "No capacity estimate has ever been recorded on this edge. Gate #23 fails closed: every driver-placed live entry refuses. An admin must record an estimate on the Edge capacity page — a proposal cannot record itself.";
    } else if (rec.capacityStatus !== EDGE_CAPACITY_STATUS_ESTIMATED) {
      blocker = "STATUS_NOT_ESTIMATED";
      remedy = `The recorded capacity status is "${rec.capacityStatus}", not ${EDGE_CAPACITY_STATUS_ESTIMATED}. The simulator found no safe deployable capacity for this edge under the inputs it was given. This is a REFUSAL by the simulator, not a missing press — better inputs or a better edge is the only remedy.`;
    } else if (effectiveCeilingUsd == null) {
      blocker = "NO_PRESSED_USD_CEILING";
      awaitingOwnerPress = true;
      remedy = "An ESTIMATED verdict is recorded but no usable USD deployable ceiling was pressed alongside it. An estimate on its own admits nothing. The ceiling is the owner's number and must be pressed explicitly.";
    } else if (rec.deployedUsd == null || !Number.isFinite(rec.deployedUsd)) {
      blocker = "DEPLOYED_SIZE_UNKNOWN";
      remedy = `The cumulative USD already deployed on this edge could not be established (${rec.deployedUsdUnknownReason ?? "reason not recorded"}), so the gate cannot know whether one more entry fits. It refuses rather than estimate.`;
    } else {
      blocker = "CEILING_ALREADY_FULL";
      remedy = `Deployed size $${rec.deployedUsd.toFixed(2)} already sits at this edge's ceiling $${effectiveCeilingUsd.toFixed(2)}. Nothing further is admitted until positions close or the owner presses a higher ceiling.`;
    }
  }

  const headroomUsd = effectiveCeilingUsd != null
    && rec.deployedUsd != null && Number.isFinite(rec.deployedUsd)
    ? effectiveCeilingUsd - rec.deployedUsd
    : null;

  return {
    edgeId: rec.edgeId,
    wouldAdmitAnEntry: verdict.passed,
    gateDetail: verdict.detail,
    blocker,
    remedy,
    effectiveCeilingUsd,
    deployedUsd: rec.deployedUsd,
    headroomUsd,
    probeCandidateUsd: EDGE_CAPACITY_PROBE_CANDIDATE_USD,
    awaitingOwnerPress,
  };
}

/** Portfolio-level summary of an all-refuse (or partly-refuse) state. */
export interface EdgeCapacityFleetSummary {
  edges: number;
  admitting: number;
  refusing: number;
  awaitingOwnerPress: number;
  byBlocker: Record<string, number>;
  /** One sentence an operator can read without opening a single edge. */
  headline: string;
}

export function summariseEdgeCapacityFleet(
  readouts: readonly EdgeCapacityReadout[],
): EdgeCapacityFleetSummary {
  const byBlocker: Record<string, number> = {};
  let admitting = 0;
  let awaiting = 0;
  for (const r of readouts) {
    if (r.wouldAdmitAnEntry) admitting += 1;
    if (r.awaitingOwnerPress) awaiting += 1;
    if (r.blocker) byBlocker[r.blocker] = (byBlocker[r.blocker] ?? 0) + 1;
  }
  const refusing = readouts.length - admitting;
  const headline = readouts.length === 0
    ? "No edges exist in the edge library, so gate #23 has nothing to admit or refuse."
    : refusing === readouts.length
      ? `Gate #23 currently refuses a driver-placed live entry on ALL ${readouts.length} edge(s). ${awaiting} of them are waiting on an admin press, not on more data.`
      : `Gate #23 would admit an entry on ${admitting} of ${readouts.length} edge(s); ${refusing} refuse (${awaiting} waiting on an admin press).`;
  return { edges: readouts.length, admitting, refusing, awaitingOwnerPress: awaiting, byBlocker, headline };
}
