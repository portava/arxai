import {
  type Heartbeat, type HeartbeatVerdict, clampNonNegative,
} from "./resilience.types";

// ═══════════════════════════════════════════════════════════════════════════
// Heartbeat Monitor — declares each service alive/dead based on staleness
// vs intervalMs. Pure.
//
//   alive = (staleMs ≤ 2 · intervalMs) AND (consecutiveMisses < hardMisses)
//   blocker if staleMs > deadAfterMisses · intervalMs
// ═══════════════════════════════════════════════════════════════════════════

export interface HeartbeatInput {
  beats: ReadonlyArray<Heartbeat>;
  nowMs: number;
  hardMisses?: number;        // default 3
  deadAfterMisses?: number;   // default 5
}

export function evaluateHeartbeats(input: HeartbeatInput): ReadonlyArray<HeartbeatVerdict> {
  const hard = input.hardMisses ?? 3;
  const dead = input.deadAfterMisses ?? 5;
  return input.beats.map((b) => {
    const reasons: string[] = []; const blockers: string[] = [];
    const staleMs = clampNonNegative(input.nowMs - b.lastHeartbeatAtMs);
    const aliveByTime = staleMs <= 2 * b.intervalMs;
    const aliveByMisses = b.consecutiveMisses < hard;
    const alive = aliveByTime && aliveByMisses;
    reasons.push(`stale ${staleMs}ms (interval ${b.intervalMs}ms) · misses ${b.consecutiveMisses}`);
    if (!aliveByTime)   blockers.push(`stale ${staleMs}ms > 2× interval ${b.intervalMs}ms`);
    if (!aliveByMisses) blockers.push(`consecutiveMisses ${b.consecutiveMisses} ≥ hard ${hard}`);
    if (staleMs > dead * b.intervalMs) blockers.push(`DEAD: stale > ${dead}× interval`);
    return { serviceId: b.serviceId, alive, staleMs, reasons, blockers };
  });
}
