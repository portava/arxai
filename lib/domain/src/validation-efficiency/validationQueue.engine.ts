import {
  type QueueEntry, type CandidateRef, type PriorityScore,
  type MarketRegime,
} from "./validationEfficiency.types";

// ═══════════════════════════════════════════════════════════════════════════
// Validation Queue — pure functional ordered set keyed by candidateId.
// Operations return a NEW queue snapshot; nothing mutates input arrays.
//
// Ordering: by priorityScore.score01 descending. Paused entries sink to
// the bottom but are not removed (Control Tower may resume them).
//
// Market-regime gating: dequeueForRegime(regime) only returns the highest
// priority entry whose designedRegimes include the active regime (or ANY).
// ═══════════════════════════════════════════════════════════════════════════

export type Queue = ReadonlyArray<QueueEntry>;

export function emptyQueue(): Queue { return []; }

export function enqueue(
  queue: Queue,
  candidate: CandidateRef,
  priorityScore: PriorityScore,
  designedRegimes: MarketRegime[],
  enqueuedAtIso: string,
): { queue: Queue; reasons: string[]; blockers: string[] } {
  const reasons: string[] = [];
  const blockers: string[] = [];
  if (designedRegimes.length === 0) {
    blockers.push(`enqueue requires at least one designedRegime`);
    return { queue, reasons, blockers };
  }
  if (priorityScore.candidateId !== candidate.candidateId) {
    blockers.push(`priorityScore.candidateId ${priorityScore.candidateId} ≠ candidate.candidateId ${candidate.candidateId}`);
    return { queue, reasons, blockers };
  }
  // De-dupe by candidateId — replace existing entry if present.
  const without = queue.filter((e) => e.candidate.candidateId !== candidate.candidateId);
  if (without.length !== queue.length) {
    reasons.push(`replaced existing queue entry for ${candidate.candidateId}`);
  }
  const entry: QueueEntry = {
    candidate, priorityScore,
    designedRegimes: [...designedRegimes],
    enqueuedAtIso, attempts: 0, paused: false,
  };
  return { queue: sortQueue([...without, entry]), reasons, blockers };
}

export function remove(queue: Queue, candidateId: string): Queue {
  return queue.filter((e) => e.candidate.candidateId !== candidateId);
}

export function pause(queue: Queue, candidateId: string, reason: string): Queue {
  return sortQueue(queue.map((e) =>
    e.candidate.candidateId === candidateId
      ? { ...e, paused: true, pausedReason: reason } : e));
}

export function resume(queue: Queue, candidateId: string): Queue {
  return sortQueue(queue.map((e) =>
    e.candidate.candidateId === candidateId
      ? { ...e, paused: false, pausedReason: undefined } : e));
}

export function bumpAttempts(queue: Queue, candidateId: string): Queue {
  return queue.map((e) =>
    e.candidate.candidateId === candidateId
      ? { ...e, attempts: e.attempts + 1 } : e);
}

export function peek(queue: Queue): QueueEntry | null {
  for (const e of queue) if (!e.paused) return e;
  return null;
}

export function peekForRegime(queue: Queue, regime: MarketRegime): QueueEntry | null {
  for (const e of queue) {
    if (e.paused) continue;
    if (regimeMatches(e.designedRegimes, regime)) return e;
  }
  return null;
}

export function dequeueForRegime(
  queue: Queue, regime: MarketRegime,
): { queue: Queue; entry: QueueEntry | null; reasons: string[] } {
  const reasons: string[] = [];
  const entry = peekForRegime(queue, regime);
  if (!entry) {
    reasons.push(`no queue entry matches regime ${regime}`);
    return { queue, entry: null, reasons };
  }
  reasons.push(`dequeued ${entry.candidate.candidateId} for regime ${regime}`);
  return { queue: remove(queue, entry.candidate.candidateId), entry, reasons };
}

export function snapshot(queue: Queue): Queue { return [...queue]; }

// ── helpers ────────────────────────────────────────────────────────────────
function sortQueue(q: QueueEntry[]): QueueEntry[] {
  return [...q].sort((a, b) => {
    if (a.paused !== b.paused) return a.paused ? 1 : -1;
    return b.priorityScore.score01 - a.priorityScore.score01;
  });
}

export function regimeMatches(designed: ReadonlyArray<MarketRegime>, active: MarketRegime): boolean {
  // The candidate's `designed` list is authoritative. An entry that lists
  // ANY is a wildcard candidate. The active regime being ANY is NOT a
  // wildcard — that would let untargeted candidates run in any market.
  if (designed.includes("ANY")) return true;
  return designed.includes(active);
}
