import type {
  TradeJournalEntry, JournalSeed, JournalCloseInput, HealthChangeInput, HealthChange,
} from "./tradeJournal.types";

// ── Build a fresh journal entry at trade open ──────────────────────────────
// Captures everything frozen at entry time: candle context, AI notes, market
// snapshot, risk score. healthChanges starts empty; finalResult is null until
// close.
export function buildJournalEntry(seed: JournalSeed): TradeJournalEntry {
  const now = seed.now ?? new Date();
  return {
    tradeId: seed.trade.id,
    symbol: seed.trade.symbol,
    direction: seed.trade.direction,
    strategyName: seed.strategyName,
    strategyVersion: seed.strategyVersion,

    candlesBeforeEntry: seed.candlesBeforeEntry.map(toJournalCandle),
    entryCandle: toJournalCandle(seed.entryCandle),
    exitCandle: null,

    aiNotes: [...seed.aiNotes],
    spreadAtEntry: seed.spreadAtEntry,
    sessionAtEntry: seed.sessionAtEntry,
    volatilityAtEntry: seed.volatilityAtEntry,

    riskScore: clamp01_100(seed.riskScore),
    riskGateBreakdown: [...seed.riskGateBreakdown],

    healthChanges: [],
    finalResult: null,

    createdAt: now.toISOString(),
    sealedAt: null,
  };
}

// ── Append a health snapshot — only stores changes, not duplicates ─────────
// Useful when the management loop ticks frequently; we keep the timeline
// compact by skipping back-to-back entries with identical state + same
// rMultiple bucket (rounded to 0.05 R).
export function recordHealthChange(
  entry: TradeJournalEntry,
  change: HealthChangeInput,
): TradeJournalEntry {
  const last = entry.healthChanges[entry.healthChanges.length - 1];
  const sameState = last && last.state === change.state;
  const sameBucket = last && bucket(last.rMultiple) === bucket(change.rMultiple);
  if (sameState && sameBucket) return entry;     // no meaningful change

  const next: HealthChange = {
    at: change.at.toISOString(),
    score: clamp01_100(change.score),
    state: change.state,
    rMultiple: change.rMultiple,
    price: change.price,
    note: change.note,
  };
  return { ...entry, healthChanges: [...entry.healthChanges, next] };
}

// ── Close & finalize ───────────────────────────────────────────────────────
// Called when the trade transitions CLOSED — fills in exit candle and final
// result. Does NOT seal yet (sealing happens at REVIEWED).
export function closeJournalEntry(
  entry: TradeJournalEntry,
  close: JournalCloseInput,
): TradeJournalEntry {
  const durationSeconds = Math.max(
    0,
    Math.round((close.closedAt.getTime() - new Date(entry.createdAt).getTime()) / 1000),
  );
  return {
    ...entry,
    exitCandle: toJournalCandle(close.exitCandle),
    finalResult: {
      status: close.finalStatus,
      pnl: close.pnl,
      pnlPct: close.pnlPct,
      rMultiple: close.rMultiple,
      durationSeconds,
      exitReason: close.exitReason,
    },
  };
}

// ── Seal at REVIEWED — entry becomes immutable from the system's POV ───────
export function sealJournalEntry(entry: TradeJournalEntry, at?: Date): TradeJournalEntry {
  return { ...entry, sealedAt: (at ?? new Date()).toISOString() };
}

export function isJournalSealed(entry: TradeJournalEntry): boolean {
  return entry.sealedAt != null;
}

// ── Derived views ──────────────────────────────────────────────────────────

// Worst & best health points reached during the trade — useful for charts
export function summarizeHealthArc(entry: TradeJournalEntry): {
  minR: number; maxR: number; minScore: number; maxScore: number; samples: number;
} {
  if (entry.healthChanges.length === 0) {
    return { minR: 0, maxR: 0, minScore: 50, maxScore: 50, samples: 0 };
  }
  let minR = Infinity, maxR = -Infinity, minScore = 100, maxScore = 0;
  for (const h of entry.healthChanges) {
    if (h.rMultiple < minR) minR = h.rMultiple;
    if (h.rMultiple > maxR) maxR = h.rMultiple;
    if (h.score < minScore) minScore = h.score;
    if (h.score > maxScore) maxScore = h.score;
  }
  return { minR, maxR, minScore, maxScore, samples: entry.healthChanges.length };
}

// ── Internal helpers ───────────────────────────────────────────────────────
function toJournalCandle(c: { time: number; open: number; high: number; low: number; close: number; volume?: number }) {
  return { time: c.time, open: c.open, high: c.high, low: c.low, close: c.close, volume: c.volume };
}

function clamp01_100(n: number): number {
  return Math.max(0, Math.min(100, n));
}

function bucket(r: number): number {
  return Math.round(r * 20) / 20;     // 0.05 R buckets
}
