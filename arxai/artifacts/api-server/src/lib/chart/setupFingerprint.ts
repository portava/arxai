// Chart Brain v2 — Task 5: setup fingerprints (pure, deterministic).
//
// A "setup fingerprint" is a compact, structured snapshot of what the chart
// looked like at decision time, derived ENTIRELY from an already-built
// ChartIntelligenceState. It is deterministic (same state in → same fingerprint
// out), carries no per-user data, never re-probes a provider, and never throws —
// every accessor degrades to a null/"unknown" bucket on a shape gap.
//
// Fingerprints power the similar-setup lookup. We keep them STRUCTURED (bucketed
// strings + a handful of numerics), not free-text, so similarity is an honest
// field-by-field comparison rather than fuzzy ML.

import type { ChartIntelligenceState } from "../data/chart/chartIntelligence.js";

export type FingerprintBucket = string;

export interface ChartSetupFingerprint {
  // Identity-ish (also stored as indexed receipt columns).
  symbol: string;
  timeframe: string;
  direction: "BUY" | "SELL" | "NEUTRAL";
  tradeType: string; // scalp | intraday | structure | unknown
  // Market context.
  regime: string; // trending | ranging | volatile | quiet | unknown
  htfBias: string; // bullish | bearish | ranging | mixed | unknown
  trendStrengthBucket: FingerprintBucket; // none | weak | moderate | strong | unknown
  // Level context.
  levelType: string; // support | resistance | none
  levelPersonality: string; // fresh | defended | weakening | ... | none
  distanceBucket: FingerprintBucket; // at | near | mid | far | unknown
  // Candle / pressure.
  candlePressure: string; // buyers | sellers | balanced | unknown
  candleIntent: string; // pushing | rejecting | trapping | ... | unknown
  wickBehavior: string; // trap | rejection | clean | unknown
  // Quality / readiness.
  entryQuality: string; // strong | mixed | weak | unknown (evidence balance)
  agentAgreement: string; // support | caution | mixed | conflict | neutral
  riskStatus: string; // veto | caution | clear
  stage: string; // setup lifecycle stage
  freshnessBucket: FingerprintBucket; // fresh | aging | stale | unknown
  readinessBucket: FingerprintBucket; // high | medium | low | none | unknown
  qualityLabel: string; // A+ | A | B | ... | unrated
  // Numerics retained for finer scoring (nullable, honest).
  readinessScore: number | null;
  trendStrength: number | null;
  distancePct: number | null;
}

function safe<T>(fn: () => T, fallback: T): T {
  try {
    const v = fn();
    return v == null ? fallback : v;
  } catch {
    return fallback;
  }
}

function bucketTrendStrength(s: number | null): FingerprintBucket {
  if (s == null) return "unknown";
  if (s < 20) return "none";
  if (s < 45) return "weak";
  if (s < 70) return "moderate";
  return "strong";
}

function bucketDistance(pct: number | null): FingerprintBucket {
  if (pct == null) return "unknown";
  const a = Math.abs(pct);
  if (a <= 0.1) return "at";
  if (a <= 0.5) return "near";
  if (a <= 1.5) return "mid";
  return "far";
}

function bucketFreshness(f: number | null): FingerprintBucket {
  if (f == null) return "unknown";
  if (f >= 66) return "fresh";
  if (f >= 33) return "aging";
  return "stale";
}

export function bucketReadiness(score: number | null): FingerprintBucket {
  if (score == null) return "unknown";
  if (score >= 70) return "high";
  if (score >= 45) return "medium";
  if (score > 0) return "low";
  return "none";
}

function directionOf(state: ChartIntelligenceState): "BUY" | "SELL" | "NEUTRAL" {
  const bias = safe(() => state.decisionState.bias, "neutral");
  if (bias === "bullish") return "BUY";
  if (bias === "bearish") return "SELL";
  return "NEUTRAL";
}

function entryQualityOf(state: ChartIntelligenceState): string {
  const ev = safe(() => state.marketUnderstanding.evidence, null);
  if (!ev || !ev.populated) return "unknown";
  const forN = safe(() => ev.evidenceFor.length, 0);
  const againstN = safe(() => ev.evidenceAgainst.length, 0);
  const contradictions = safe(() => ev.contradictions.length, 0);
  if (contradictions > 0 && againstN >= forN) return "weak";
  if (forN >= againstN + 2) return "strong";
  if (forN > againstN) return "mixed";
  return "weak";
}

function wickBehaviorOf(intent: string, trapScore: number | null): string {
  if (intent === "trapping") return "trap";
  if (intent === "rejecting") return "rejection";
  if (trapScore != null && trapScore >= 60) return "trap";
  if (intent === "pushing" || intent === "continuing" || intent === "breaking_structure") {
    return "clean";
  }
  return "unknown";
}

function agentAgreementOf(state: ChartIntelligenceState): string {
  const c = safe(() => state.agentConsensus, null);
  if (!c || !c.populated) return "neutral";
  if (c.conflict) return "conflict";
  return safe(() => c.stance, "neutral");
}

function riskStatusOf(state: ChartIntelligenceState): string {
  if (safe(() => state.decisionState.vetoed, false)) return "veto";
  const downgrade = safe(() => state.decisionFork.downgrade, false);
  const protective = safe(() => state.agentConsensus.protective, false);
  if (downgrade || protective) return "caution";
  return "clear";
}

/**
 * Build a deterministic structured fingerprint from an already-built
 * ChartIntelligenceState. Never throws; every field degrades honestly to a
 * null/"unknown" bucket when the underlying engine is unpopulated.
 */
export function buildSetupFingerprint(
  state: ChartIntelligenceState,
  opts?: { direction?: "BUY" | "SELL" | "NEUTRAL" },
): ChartSetupFingerprint {
  const trend = safe(() => state.marketUnderstanding.trend, null);
  const levels = safe(() => state.marketUnderstanding.levels, null);
  const intentRead = safe(() => state.marketUnderstanding.candleIntent, null);
  const readiness = safe(() => state.marketUnderstanding.readiness, null);
  const setup = safe(() => state.setupState, null);

  // Nearest level: prefer the directionally-relevant one, else the closest.
  const nearestSupport = safe(() => levels?.nearestSupport ?? null, null);
  const nearestResistance = safe(() => levels?.nearestResistance ?? null, null);
  const pickLevel = () => {
    const cands = [nearestSupport, nearestResistance].filter(Boolean) as NonNullable<
      typeof nearestSupport
    >[];
    if (cands.length === 0) return null;
    return cands.sort((a, b) => {
      const da = a.distancePct == null ? Infinity : Math.abs(a.distancePct);
      const db = b.distancePct == null ? Infinity : Math.abs(b.distancePct);
      return da - db;
    })[0]!;
  };
  const level = pickLevel();

  const trendStrength = safe(() => trend?.strength ?? null, null);
  const freshness = safe(() => setup?.freshness ?? null, null);
  const readinessScore = safe(() => readiness?.score ?? null, null);
  const distancePct = safe(() => level?.distancePct ?? null, null);
  const latestIntent = safe(() => intentRead?.latestIntent ?? "noise", "noise");
  const candlePressure = safe(() => intentRead?.dominantPressure ?? "unknown", "unknown");
  const latestSignalTrap = safe(
    () => intentRead?.signals?.[0]?.trapScore ?? null,
    null,
  );

  return {
    symbol: safe(() => state.symbol, ""),
    timeframe: safe(() => state.timeframe, ""),
    direction: opts?.direction ?? directionOf(state),
    tradeType: safe(() => setup?.tradeType ?? "unknown", "unknown"),
    regime: safe(() => trend?.regime ?? "unknown", "unknown"),
    htfBias: safe(() => trend?.higherTimeframeBias ?? "unknown", "unknown"),
    trendStrengthBucket: bucketTrendStrength(trendStrength),
    levelType: safe(() => level?.kind ?? "none", "none"),
    levelPersonality: safe(() => level?.personality ?? "none", "none"),
    distanceBucket: bucketDistance(distancePct),
    candlePressure,
    candleIntent: latestIntent,
    wickBehavior: wickBehaviorOf(latestIntent, latestSignalTrap),
    entryQuality: entryQualityOf(state),
    agentAgreement: agentAgreementOf(state),
    riskStatus: riskStatusOf(state),
    stage: safe(() => setup?.stage ?? "no_setup", "no_setup"),
    freshnessBucket: bucketFreshness(freshness),
    readinessBucket: bucketReadiness(readinessScore),
    qualityLabel: safe(() => readiness?.quality ?? "unrated", "unrated"),
    readinessScore,
    trendStrength,
    distancePct,
  };
}

// ── Similarity scoring ──────────────────────────────────────────────────────
// A field-by-field weighted match in [0,1]. Higher = more alike. Deterministic
// and symmetric. Used by the Slow Brain similar-setup lookup; it is NEVER on the
// live path.

interface FieldWeight {
  key: keyof ChartSetupFingerprint;
  weight: number;
}

// Categorical fields that contribute to the match. Symbol/timeframe are handled
// as gating/boost separately so cross-symbol structural matches still count.
const CATEGORICAL_WEIGHTS: FieldWeight[] = [
  { key: "direction", weight: 3 },
  { key: "regime", weight: 3 },
  { key: "htfBias", weight: 2 },
  { key: "levelType", weight: 2 },
  { key: "levelPersonality", weight: 2 },
  { key: "stage", weight: 2 },
  { key: "tradeType", weight: 1 },
  { key: "candlePressure", weight: 1 },
  { key: "candleIntent", weight: 1 },
  { key: "wickBehavior", weight: 1 },
  { key: "entryQuality", weight: 2 },
  { key: "agentAgreement", weight: 1 },
  { key: "riskStatus", weight: 1 },
  { key: "qualityLabel", weight: 2 },
  { key: "trendStrengthBucket", weight: 1 },
  { key: "distanceBucket", weight: 1 },
  { key: "freshnessBucket", weight: 1 },
  { key: "readinessBucket", weight: 2 },
];

function eqBucket(a: unknown, b: unknown): boolean {
  if (a == null || b == null) return false;
  const sa = String(a);
  const sb = String(b);
  if (sa === "unknown" || sb === "unknown") return false;
  return sa === sb;
}

/**
 * Structured similarity in [0,1] between two fingerprints. Symbol match adds a
 * bounded boost (same instrument behaves alike) without dominating, so a strong
 * structural match on a different symbol still scores well. Deterministic.
 */
export function scoreFingerprintSimilarity(
  a: ChartSetupFingerprint,
  b: ChartSetupFingerprint,
): number {
  let max = 0;
  let got = 0;
  for (const { key, weight } of CATEGORICAL_WEIGHTS) {
    max += weight;
    if (eqBucket(a[key], b[key])) got += weight;
  }
  // Readiness numeric proximity (when both known) — small, bounded contribution.
  const readinessW = 2;
  max += readinessW;
  if (a.readinessScore != null && b.readinessScore != null) {
    const diff = Math.abs(a.readinessScore - b.readinessScore);
    got += readinessW * Math.max(0, 1 - diff / 100);
  }
  const base = max === 0 ? 0 : got / max;
  // Same-symbol boost: up to +0.08, never letting the score exceed 1.
  const symbolBoost = a.symbol && b.symbol && a.symbol === b.symbol ? 0.08 : 0;
  return Math.min(1, base + symbolBoost);
}
