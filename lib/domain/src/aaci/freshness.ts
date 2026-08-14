// ── AACI Data Freshness Monitor — pure ──────────────────────────────────────
//
// Data Freshness (F) measures whether the app is using current data. Each source
// is scored 0–100 by how far its signal age is within an app-defined staleness
// threshold. Unknown ages are treated as honest-unknown (a low, conservative
// score) — never fabricated as fresh. F is the weighted average of per-source
// scores. Critical staleness (bridge heartbeat, account snapshot) also drives
// the HARD_GATE and confidence ceilings elsewhere.

import type { AaciFreshnessRecord, AaciSharedTruthSnapshot } from "./types";

// Per-source staleness thresholds (ms) and their weight in the F average.
// Thresholds follow the spec's suggested freshness windows (fast-market biased).
export const AACI_FRESHNESS_THRESHOLDS_MS = {
  marketFeed: 1_000,
  candle: 3_000,
  scanner: 3_000,
  ruby: 30_000,
  heat: 60_000,
  news: 15 * 60_000,
  bridgeHeartbeat: 15_000,
  account: 5_000,
  positions: 3_000,
  risk: 10_000,
} as const;

export type AaciFreshnessSource = keyof typeof AACI_FRESHNESS_THRESHOLDS_MS;

const AACI_FRESHNESS_WEIGHTS: Record<AaciFreshnessSource, number> = {
  marketFeed: 0.16,
  candle: 0.12,
  scanner: 0.12,
  ruby: 0.08,
  heat: 0.08,
  news: 0.06,
  bridgeHeartbeat: 0.14,
  account: 0.08,
  positions: 0.1,
  risk: 0.06,
};

// Sources whose staleness is critical enough to also fail HARD_GATE freshness.
export const AACI_CRITICAL_FRESHNESS_SOURCES: readonly AaciFreshnessSource[] = [
  "marketFeed",
  "bridgeHeartbeat",
];

// Score one source 0–100. Fresh (age 0) → 100; at threshold → 50; older decays
// linearly to 0 at 2× threshold. Unknown age → conservative honest-unknown 25.
export function scoreFreshness(ageMs: number | null, thresholdMs: number): number {
  if (ageMs === null || !Number.isFinite(ageMs) || ageMs < 0) return 25;
  if (ageMs <= thresholdMs) {
    // 100 at age 0 → 50 at the threshold.
    return clamp100(100 - (ageMs / thresholdMs) * 50);
  }
  // 50 at threshold → 0 at 2× threshold (and beyond).
  const over = (ageMs - thresholdMs) / thresholdMs;
  return clamp100(50 - over * 50);
}

function ageFromIso(nowMs: number, iso?: string): number | null {
  if (!iso) return null;
  const t = Date.parse(iso);
  if (Number.isNaN(t)) return null;
  return Math.max(0, nowMs - t);
}

export interface AaciFreshnessReport {
  // F — weighted average freshness score (0–100).
  score: number;
  records: AaciFreshnessRecord[];
  // Logical sources that are stale beyond threshold (admin diagnostics).
  staleSources: string[];
  // True when a CRITICAL source (market feed / bridge heartbeat) is stale.
  criticalStale: boolean;
}

/**
 * Compute the Data Freshness report (F) from a Shared Truth Snapshot. Pure given
 * a fixed `nowMs`. Sources whose age cannot be determined are scored as
 * honest-unknown rather than dropped, so missing data lowers F honestly.
 */
export function computeFreshness(
  snapshot: AaciSharedTruthSnapshot,
  nowMs: number,
): AaciFreshnessReport {
  const ages: Record<AaciFreshnessSource, number | null> = {
    marketFeed: ageFromIso(nowMs, snapshot.smartChart?.lastUpdated),
    candle: ageFromIso(nowMs, snapshot.smartChart?.lastCandleTime),
    scanner: ageFromIso(nowMs, snapshot.scanner?.lastUpdated),
    ruby: ageFromIso(nowMs, snapshot.ruby?.lastUpdated),
    heat: ageFromIso(nowMs, snapshot.heat?.lastUpdated),
    news: ageFromIso(nowMs, snapshot.news?.lastUpdated),
    bridgeHeartbeat:
      typeof snapshot.bridge.heartbeatAgeMs === "number"
        ? Math.max(0, snapshot.bridge.heartbeatAgeMs)
        : ageFromIso(nowMs, snapshot.bridge.lastHeartbeat),
    account: ageFromIso(nowMs, snapshot.account.lastUpdated),
    positions: ageFromIso(nowMs, snapshot.positions.lastUpdated),
    risk: ageFromIso(nowMs, snapshot.risk?.lastUpdated),
  };

  const records: AaciFreshnessRecord[] = [];
  const staleSources: string[] = [];
  let weighted = 0;
  let weightSum = 0;
  let criticalStale = false;

  for (const source of Object.keys(AACI_FRESHNESS_THRESHOLDS_MS) as AaciFreshnessSource[]) {
    const thresholdMs = AACI_FRESHNESS_THRESHOLDS_MS[source];
    const ageMs = ages[source];
    const score = scoreFreshness(ageMs, thresholdMs);
    const stale = ageMs === null ? true : ageMs > thresholdMs;
    const weight = AACI_FRESHNESS_WEIGHTS[source];
    weighted += score * weight;
    weightSum += weight;
    records.push({ source, ageMs, thresholdMs, score, stale });
    if (stale) {
      staleSources.push(source);
      if (AACI_CRITICAL_FRESHNESS_SOURCES.includes(source) && ageMs !== null) {
        criticalStale = true;
      }
    }
  }

  const score = weightSum > 0 ? clamp100(weighted / weightSum) : 0;
  return { score, records, staleSources, criticalStale };
}

function clamp100(n: number): number {
  if (!Number.isFinite(n)) return 0;
  return Math.max(0, Math.min(100, n));
}
