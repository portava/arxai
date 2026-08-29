// ═══════════════════════════════════════════════════════════════════════════
// Capability #24 — Market Selection Engine (advisory).
//
// Turns the hand-curated ARX_FOCUS_MARKETS registry into a SCORED selection
// process: per market it scores data quality, execution quality, edge
// coverage, evidence maturity, capacity, correlation crowding, and broker
// trust, then proposes moving the market between ACTIVE / SHADOW / EXCLUDED
// postures — as an ADVISORY POSTURE RECORD only.
//
// SAFETY:
//   • This engine NEVER mutates the registry and never flips any enabled*
//     flag. Actual list changes remain an owner press (ownerActionRequired).
//   • A dimension whose evidence is missing is scored null with a typed
//     reason — never a fabricated 0.5.
//   • Insufficient evidence coverage (<50% of dimensions, or no maturity
//     evidence) → NO upgrade is ever proposed. Downgrades on hard red flags
//     remain possible (default-deny: lack of evidence can only take a market
//     DOWN or hold it, never promote it).
//   • Hysteresis: a posture change is only proposed when the composite is
//     clearly (± margin) across the band, so records don't flap.
// ═══════════════════════════════════════════════════════════════════════════

import {
  ARX_FOCUS_MARKETS,
  type ArxFocusMarket,
} from "./arxFocusMarkets";

export type MarketPosture = "ACTIVE" | "SHADOW" | "EXCLUDED";

export type SelectionDimensionKey =
  | "dataQuality"
  | "executionQuality"
  | "edgeCoverage"
  | "evidenceMaturity"
  | "capacity"
  | "correlation"
  | "brokerTrust";

export interface DimensionScore {
  key: SelectionDimensionKey;
  /** 0..1, or null when honestly not computable. */
  score01: number | null;
  /** Typed reason REQUIRED when score01 is null. */
  missingReason?: string;
  evidence?: string;
}

export interface MarketSelectionEvidence {
  canonicalSymbol: string;
  /** 0..1 — e.g. fraction of recent sufficiency verdicts that were "sufficient". */
  dataQuality01?: number | null;
  dataQualityEvidence?: string;
  executionQuality01?: number | null;
  executionQualityEvidence?: string;
  /** 0..1 — fraction of the strategy roster with a validated edge on this market. */
  edgeCoverage01?: number | null;
  edgeCoverageEvidence?: string;
  /** Sample counts behind the evidence (maturity). */
  closedTrades?: number | null;
  backtestRuns?: number | null;
  /** 0..1 — capacity headroom (1 = deep, 0 = cannot absorb our size). */
  capacity01?: number | null;
  capacityEvidence?: string;
  /** 0..1 — avg |correlation| with the currently ACTIVE set (1 = crowded). */
  correlationWithActiveSet01?: number | null;
  correlationEvidence?: string;
  /** 0..1 — trust in the venue(s) serving this market. */
  brokerTrust01?: number | null;
  brokerTrustEvidence?: string;
  /**
   * For callers whose posture state lives OUTSIDE the registry (e.g. a market
   * previously advised down to SHADOW while the registry still says enabled).
   * Display/proposal baseline only — the registry itself is never touched.
   */
  currentPostureOverride?: MarketPosture;
}

export interface AdvisoryPostureRecord {
  marketId: string;
  canonicalSymbol: string;
  displayName: string;
  currentPosture: MarketPosture;
  proposedPosture: MarketPosture;
  changed: boolean;
  direction: "UPGRADE" | "DOWNGRADE" | "NONE";
  /** Composite over the available dimensions, or null with reason. */
  composite01: number | null;
  /** Fraction of the 7 dimensions that had real evidence. */
  evidenceCoverage01: number;
  dimensions: DimensionScore[];
  status: "SCORED" | "INSUFFICIENT_EVIDENCE" | "NOT_IN_REGISTRY";
  advisoryOnly: true;
  ownerActionRequired: boolean;
  reasons: string[];
}

// Registry enables → current posture. The registry stays the single source of
// truth for what IS enabled; this only reads it.
export function currentPostureOf(m: ArxFocusMarket): MarketPosture {
  if (m.enabledForScanner && m.enabledForLiveTrading) return "ACTIVE";
  if (m.enabledForScanner || m.enabledForChart || m.enabledForRuby) return "SHADOW";
  return "EXCLUDED";
}

// Dimension weights (sum 1). Correlation is inverted (crowded = bad).
const WEIGHTS: Record<SelectionDimensionKey, number> = {
  dataQuality: 0.22,
  executionQuality: 0.18,
  edgeCoverage: 0.16,
  evidenceMaturity: 0.12,
  capacity: 0.10,
  correlation: 0.10,
  brokerTrust: 0.12,
};

const ACTIVE_THRESHOLD = 0.65;
const SHADOW_THRESHOLD = 0.40;
const HYSTERESIS = 0.05;
const MIN_EVIDENCE_COVERAGE = 0.5;
const MATURITY_FULL_TRADES = 100;
const MATURITY_FULL_BACKTESTS = 20;

function clamp01(x: number): number { return x < 0 ? 0 : x > 1 ? 1 : x; }

function dim(
  key: SelectionDimensionKey,
  value: number | null | undefined,
  missingReason: string,
  evidence?: string,
  invert = false,
): DimensionScore {
  if (value === null || value === undefined || !Number.isFinite(value)) {
    return { key, score01: null, missingReason };
  }
  const v = clamp01(value);
  return { key, score01: invert ? 1 - v : v, evidence };
}

export function scoreMarketSelection(ev: MarketSelectionEvidence): {
  dimensions: DimensionScore[];
  composite01: number | null;
  evidenceCoverage01: number;
} {
  // Evidence maturity from raw counts — null only when BOTH counts are unknown.
  let maturity: number | null = null;
  let maturityEvidence = "";
  if (ev.closedTrades !== null && ev.closedTrades !== undefined) {
    maturity = clamp01(ev.closedTrades / MATURITY_FULL_TRADES);
    maturityEvidence = `${ev.closedTrades} closed trade(s)`;
  }
  if (ev.backtestRuns !== null && ev.backtestRuns !== undefined) {
    const b = clamp01(ev.backtestRuns / MATURITY_FULL_BACKTESTS);
    maturity = maturity === null ? b * 0.5 : Math.max(maturity, Math.min(1, maturity + b * 0.25));
    maturityEvidence += `${maturityEvidence ? ", " : ""}${ev.backtestRuns} backtest run(s)`;
  }

  const dimensions: DimensionScore[] = [
    dim("dataQuality", ev.dataQuality01, "no data-sufficiency evidence supplied", ev.dataQualityEvidence),
    dim("executionQuality", ev.executionQuality01, "no execution-quality evidence supplied", ev.executionQualityEvidence),
    dim("edgeCoverage", ev.edgeCoverage01, "no validated-edge evidence supplied", ev.edgeCoverageEvidence),
    maturity === null
      ? { key: "evidenceMaturity", score01: null, missingReason: "no trade/backtest sample counts supplied" }
      : { key: "evidenceMaturity", score01: maturity, evidence: maturityEvidence },
    dim("capacity", ev.capacity01, "no capacity evidence supplied", ev.capacityEvidence),
    dim("correlation", ev.correlationWithActiveSet01, "no correlation evidence supplied", ev.correlationEvidence, true),
    dim("brokerTrust", ev.brokerTrust01, "no broker-trust evidence supplied", ev.brokerTrustEvidence),
  ];

  let weightSum = 0;
  let acc = 0;
  for (const d of dimensions) {
    if (d.score01 === null) continue;
    acc += WEIGHTS[d.key] * d.score01;
    weightSum += WEIGHTS[d.key];
  }
  const evidenceCoverage01 = dimensions.filter((d) => d.score01 !== null).length / dimensions.length;
  const composite01 = weightSum > 0 ? acc / weightSum : null;
  return { dimensions, composite01, evidenceCoverage01 };
}

export function buildAdvisoryPostureRecord(
  ev: MarketSelectionEvidence,
): AdvisoryPostureRecord {
  const market = ARX_FOCUS_MARKETS.find(
    (m) => m.canonicalSymbol.toUpperCase() === ev.canonicalSymbol.toUpperCase());
  if (!market) {
    return {
      marketId: ev.canonicalSymbol.toLowerCase(),
      canonicalSymbol: ev.canonicalSymbol,
      displayName: ev.canonicalSymbol,
      currentPosture: "EXCLUDED", proposedPosture: "EXCLUDED",
      changed: false, direction: "NONE",
      composite01: null, evidenceCoverage01: 0, dimensions: [],
      status: "NOT_IN_REGISTRY", advisoryOnly: true, ownerActionRequired: false,
      reasons: [`${ev.canonicalSymbol} is not in the approved ARX registry — selection scoring does not apply (adding a market is an owner decision, not an engine output)`],
    };
  }

  const currentPosture = ev.currentPostureOverride ?? currentPostureOf(market);
  const { dimensions, composite01, evidenceCoverage01 } = scoreMarketSelection(ev);
  const reasons: string[] = [];

  const maturityDim = dimensions.find((d) => d.key === "evidenceMaturity");
  const insufficient =
    composite01 === null
    || evidenceCoverage01 < MIN_EVIDENCE_COVERAGE
    || maturityDim?.score01 === null;

  let proposedPosture: MarketPosture = currentPosture;
  let status: AdvisoryPostureRecord["status"] = "SCORED";

  if (insufficient) {
    status = "INSUFFICIENT_EVIDENCE";
    reasons.push(`evidence coverage ${(evidenceCoverage01 * 100).toFixed(0)}% ` +
      (composite01 === null ? `(no scorable dimension)` : ``) +
      ` — no posture UPGRADE can be proposed on insufficient evidence`);
    // Default-deny: insufficient evidence can still surface hard red flags on
    // an ACTIVE market (a dimension we DO have that is very bad).
    const hardRed = dimensions.find((d) => d.score01 !== null && d.score01 < 0.15
      && (d.key === "dataQuality" || d.key === "brokerTrust" || d.key === "executionQuality"));
    if (currentPosture === "ACTIVE" && hardRed) {
      proposedPosture = "SHADOW";
      reasons.push(`hard red flag on ${hardRed.key} (${hardRed.score01!.toFixed(2)}) — advisory downgrade ACTIVE → SHADOW despite thin evidence`);
    } else {
      reasons.push(`posture held at ${currentPosture} (no change proposed)`);
    }
  } else {
    const c = composite01!;
    // Hysteresis: to PROPOSE a change the composite must clear the band by
    // the margin in the direction of the move.
    if (currentPosture === "ACTIVE") {
      if (c < SHADOW_THRESHOLD - HYSTERESIS) proposedPosture = "EXCLUDED";
      else if (c < ACTIVE_THRESHOLD - HYSTERESIS) proposedPosture = "SHADOW";
    } else if (currentPosture === "SHADOW") {
      if (c >= ACTIVE_THRESHOLD + HYSTERESIS) proposedPosture = "ACTIVE";
      else if (c < SHADOW_THRESHOLD - HYSTERESIS) proposedPosture = "EXCLUDED";
    } else { // EXCLUDED
      if (c >= ACTIVE_THRESHOLD + HYSTERESIS) proposedPosture = "SHADOW"; // never excluded→active in one step
      else if (c >= SHADOW_THRESHOLD + HYSTERESIS) proposedPosture = "SHADOW";
    }
    reasons.push(`composite ${c.toFixed(3)} over ${(evidenceCoverage01 * 100).toFixed(0)}% evidence coverage → proposed ${proposedPosture}`);
    if (currentPosture === "EXCLUDED" && proposedPosture === "SHADOW" && c >= ACTIVE_THRESHOLD + HYSTERESIS) {
      reasons.push(`excluded markets step up via SHADOW first — never straight to ACTIVE`);
    }
  }

  const changed = proposedPosture !== currentPosture;
  const order: Record<MarketPosture, number> = { EXCLUDED: 0, SHADOW: 1, ACTIVE: 2 };
  const direction = !changed ? "NONE"
    : order[proposedPosture] > order[currentPosture] ? "UPGRADE" : "DOWNGRADE";
  if (changed) {
    reasons.push(`ADVISORY ONLY: registry stays ${currentPosture} until the owner presses the change`);
  }

  return {
    marketId: market.id,
    canonicalSymbol: market.canonicalSymbol,
    displayName: market.displayName,
    currentPosture, proposedPosture, changed, direction,
    composite01, evidenceCoverage01, dimensions,
    status, advisoryOnly: true,
    ownerActionRequired: changed,
    reasons,
  };
}

/** Batch: one advisory record per supplied evidence row. Pure; no mutation. */
export function runMarketSelectionEngine(
  evidence: ReadonlyArray<MarketSelectionEvidence>,
): AdvisoryPostureRecord[] {
  return evidence.map((ev) => buildAdvisoryPostureRecord(ev));
}
