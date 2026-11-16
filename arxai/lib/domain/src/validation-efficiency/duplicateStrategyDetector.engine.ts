import {
  type StrategyFingerprint, type DuplicateMatch, type DuplicateAction,
  type MarketRegime,
} from "./validationEfficiency.types";

// ═══════════════════════════════════════════════════════════════════════════
// Duplicate Strategy Detector — pairwise comparison via:
//
//   • paramExact: identical paramHash → strong duplicate signal
//   • cosine similarity over equal-length signalVector
//   • regime overlap (Jaccard over designedRegimes)
//
// Action policy:
//   • paramExact OR similarity ≥ MERGE_AT  → MERGE
//   • similarity ≥ ARCHIVE_AT              → ARCHIVE (newer goes away)
//   • otherwise                            → DISTINCT
//
// Pure. Returns matches only above ARCHIVE_AT (no noise for distinct pairs).
// ═══════════════════════════════════════════════════════════════════════════

export const DEFAULT_DUPLICATE_TUNING = {
  MERGE_AT: 0.95,
  ARCHIVE_AT: 0.85,
} as const;
export type DuplicateTuning = typeof DEFAULT_DUPLICATE_TUNING;

export interface DetectDuplicatesInput {
  fingerprints: ReadonlyArray<StrategyFingerprint>;
  tuning?: DuplicateTuning;
}

export function detectDuplicates(input: DetectDuplicatesInput): {
  matches: ReadonlyArray<DuplicateMatch>;
  reasons: string[];
  blockers: string[];
} {
  const tuning = input.tuning ?? DEFAULT_DUPLICATE_TUNING;
  const reasons: string[] = [];
  const blockers: string[] = [];
  const matches: DuplicateMatch[] = [];

  // Length-mismatch blocker once, not per-pair.
  const refLen = input.fingerprints[0]?.signalVector.length ?? 0;
  for (const fp of input.fingerprints) {
    if (fp.signalVector.length !== refLen) {
      blockers.push(`signalVector length mismatch on ${fp.candidateId}: ${fp.signalVector.length} vs ${refLen}`);
    }
  }

  for (let i = 0; i < input.fingerprints.length; i++) {
    for (let j = i + 1; j < input.fingerprints.length; j++) {
      const a = input.fingerprints[i]!;
      const b = input.fingerprints[j]!;
      if (a.signalVector.length !== b.signalVector.length) continue;
      const sim = cosineSimilarity(a.signalVector, b.signalVector);
      const overlap = jaccardRegimes(a.designedRegimes, b.designedRegimes);
      const paramExact = a.paramHash === b.paramHash;
      const action: DuplicateAction = paramExact || sim >= tuning.MERGE_AT
        ? "MERGE"
        : sim >= tuning.ARCHIVE_AT ? "ARCHIVE" : "DISTINCT";
      if (action === "DISTINCT") continue;
      // Deterministic precedence — keep the stronger track record;
      // tie-break on earliest createdAt; final tie-break on fingerprint
      // index (i wins j, since we iterate i<j).
      const { keepId, retireId, why } = pickKeeper(a, b, i, j);
      matches.push({
        a: a.candidateId, b: b.candidateId,
        keepId, retireId,
        similarity01: clamp01(sim),
        paramExact, regimeOverlap01: clamp01(overlap), action,
        reasons: [
          paramExact ? `paramExact` : `similarity ${sim.toFixed(3)}`,
          `regimeOverlap ${overlap.toFixed(2)}`,
          `action ${action}`,
          `keep ${keepId} / retire ${retireId} — ${why}`,
        ],
      });
    }
  }
  reasons.push(`scanned ${input.fingerprints.length} fingerprints → ${matches.length} match(es) ≥ ARCHIVE_AT`);
  return { matches, reasons, blockers };
}

// ── precedence picker ─────────────────────────────────────────────────────
function pickKeeper(
  a: StrategyFingerprint, b: StrategyFingerprint, ia: number, ib: number,
): { keepId: string; retireId: string; why: string } {
  // 1) Stronger trackRecordScore01 wins.
  const ta = a.trackRecordScore01; const tb = b.trackRecordScore01;
  if (typeof ta === "number" && typeof tb === "number" && ta !== tb) {
    return ta > tb
      ? { keepId: a.candidateId, retireId: b.candidateId,
          why: `trackRecord ${ta.toFixed(2)} > ${tb.toFixed(2)}` }
      : { keepId: b.candidateId, retireId: a.candidateId,
          why: `trackRecord ${tb.toFixed(2)} > ${ta.toFixed(2)}` };
  }
  // 2) Earliest createdAt wins (the elder strategy keeps history).
  const ca = a.createdAtIso; const cb = b.createdAtIso;
  if (ca && cb && ca !== cb) {
    return ca < cb
      ? { keepId: a.candidateId, retireId: b.candidateId,
          why: `createdAt earlier: ${ca} < ${cb}` }
      : { keepId: b.candidateId, retireId: a.candidateId,
          why: `createdAt earlier: ${cb} < ${ca}` };
  }
  // 3) Final tie-break: lexicographic candidateId so result is independent
  // of input ordering.
  if (a.candidateId !== b.candidateId) {
    return a.candidateId < b.candidateId
      ? { keepId: a.candidateId, retireId: b.candidateId,
          why: `lexicographic candidateId` }
      : { keepId: b.candidateId, retireId: a.candidateId,
          why: `lexicographic candidateId` };
  }
  // Truly identical — keep first seen.
  return { keepId: a.candidateId, retireId: b.candidateId,
           why: `identical ids — keeping first index ${ia} over ${ib}` };
}

// ── pure math helpers ─────────────────────────────────────────────────────
function cosineSimilarity(a: ReadonlyArray<number>, b: ReadonlyArray<number>): number {
  let dot = 0, na = 0, nb = 0;
  for (let k = 0; k < a.length; k++) {
    const av = a[k]!; const bv = b[k]!;
    dot += av * bv; na += av * av; nb += bv * bv;
  }
  const denom = Math.sqrt(na) * Math.sqrt(nb);
  if (denom === 0) return 0;
  // Cosine ∈ [-1,1]; map to [0,1] so callers can treat as similarity.
  return (dot / denom + 1) / 2;
}

function jaccardRegimes(a: ReadonlyArray<MarketRegime>, b: ReadonlyArray<MarketRegime>): number {
  const A = new Set(a); const B = new Set(b);
  if (A.size === 0 && B.size === 0) return 0;
  let inter = 0;
  for (const x of A) if (B.has(x)) inter++;
  const union = A.size + B.size - inter;
  return union === 0 ? 0 : inter / union;
}

function clamp01(x: number): number {
  if (!Number.isFinite(x)) return 0;
  return x < 0 ? 0 : x > 1 ? 1 : x;
}
