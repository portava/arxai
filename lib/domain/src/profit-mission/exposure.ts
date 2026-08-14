// ── Profit Mission Phase 7 — Mission Exposure Manager (pure, BLOCK-only) ──────
//
// PLANNING / PRE-EXECUTION PRE-CHECK ONLY. Aggregates a mission's already-open
// risk plus a proposed trade and blocks duplicate / correlated / over-exposed
// risk. It can ONLY block — it never forces or upgrades a trade.
//
// HONESTY CONTRACT:
//   - Correlation is derived from caller-supplied, honest metadata (asset class +
//     traded currencies). The caller resolves these from the ARX Focus registry;
//     this module never guesses a symbol's nature.
//   - Caps come from the mission risk budget; this module is stricter-only and
//     never relaxes a budget.
//
// PURE + DETERMINISTIC + IO-FREE.

export interface ExposurePosition {
  symbol: string;
  /** Honest asset-class bucket resolved by the caller (e.g. "forex_major"). */
  assetClass: string;
  /** Currencies this instrument is exposed to (e.g. ["EUR","USD"]); [] when n/a. */
  currencies: string[];
  direction: "BUY" | "SELL";
  /** Account-currency amount at risk on this position. */
  riskAmount: number;
}

export interface ExposureBudget {
  /** Max same-symbol positions in the SAME direction (incl. the proposed one). */
  maxSameSymbolExposure: number;
  /** Max positions in the same correlated bucket (asset-class / currency). */
  maxCorrelatedExposure: number;
  /** Max simultaneously open trades (incl. the proposed one); null = no cap. */
  maxOpenTrades?: number | null;
  /** Max total account-currency risk across the mission; null = no cap. */
  maxMissionExposureAmount?: number | null;
}

export interface ExposureInput {
  open: ExposurePosition[];
  proposed: ExposurePosition;
  budget: ExposureBudget;
}

export interface ExposureAggregates {
  openCount: number;
  totalOpenRisk: number;
  /** Open risk grouped by asset-class bucket. */
  riskByAssetClass: Record<string, number>;
  /** Open count grouped by asset-class bucket. */
  countByAssetClass: Record<string, number>;
}

export interface ExposureVerdict {
  allowed: boolean;
  blockers: string[];
  warnings: string[];
  reason: string;
  aggregates: ExposureAggregates;
}

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}

/** Summarize already-open exposure so the Judge/UI can see the full picture. */
export function aggregateExposure(open: ExposurePosition[]): ExposureAggregates {
  const riskByAssetClass: Record<string, number> = {};
  const countByAssetClass: Record<string, number> = {};
  let totalOpenRisk = 0;
  for (const p of open) {
    const risk = Number.isFinite(p.riskAmount) && p.riskAmount > 0 ? p.riskAmount : 0;
    totalOpenRisk += risk;
    riskByAssetClass[p.assetClass] = round2((riskByAssetClass[p.assetClass] ?? 0) + risk);
    countByAssetClass[p.assetClass] = (countByAssetClass[p.assetClass] ?? 0) + 1;
  }
  return {
    openCount: open.length,
    totalOpenRisk: round2(totalOpenRisk),
    riskByAssetClass,
    countByAssetClass,
  };
}

/**
 * Evaluate whether the proposed trade may be added without breaching exposure
 * caps. Pure, block-only.
 */
export function evaluateExposure(input: ExposureInput): ExposureVerdict {
  const { open, proposed, budget } = input;
  const blockers: string[] = [];
  const warnings: string[] = [];
  const aggregates = aggregateExposure(open);

  // ── Duplicate same-symbol, same-direction risk. ────────────────────────────
  const sameSymbolSameDir = open.filter(
    (p) => p.symbol === proposed.symbol && p.direction === proposed.direction,
  ).length;
  if (sameSymbolSameDir + 1 > budget.maxSameSymbolExposure) {
    blockers.push("DUPLICATE_SYMBOL_DIRECTION");
    warnings.push(
      `Already ${sameSymbolSameDir} ${proposed.direction} position(s) on ${proposed.symbol} — duplicate risk over the ${budget.maxSameSymbolExposure} cap.`,
    );
  }

  // ── Correlated bucket: same asset class. ───────────────────────────────────
  const sameClass = open.filter((p) => p.assetClass === proposed.assetClass).length;
  if (sameClass + 1 > budget.maxCorrelatedExposure) {
    blockers.push("CORRELATED_OVEREXPOSURE");
    warnings.push(
      `Adding ${proposed.symbol} would make ${sameClass + 1} positions in the ${proposed.assetClass} bucket — over the ${budget.maxCorrelatedExposure} correlated cap.`,
    );
  }

  // ── Correlated bucket: shared currency in the SAME direction (forex/metals). ─
  if (proposed.currencies.length > 0) {
    for (const ccy of proposed.currencies) {
      const sameCcySameDir = open.filter(
        (p) => p.direction === proposed.direction && p.currencies.includes(ccy),
      ).length;
      if (sameCcySameDir + 1 > budget.maxCorrelatedExposure) {
        blockers.push("CURRENCY_OVEREXPOSURE");
        warnings.push(
          `Stacking ${sameCcySameDir + 1} ${proposed.direction} positions on ${ccy} — over the ${budget.maxCorrelatedExposure} correlated cap.`,
        );
        break;
      }
    }
  }

  // ── Max open trades. ───────────────────────────────────────────────────────
  if (budget.maxOpenTrades != null && aggregates.openCount + 1 > budget.maxOpenTrades) {
    blockers.push("MAX_OPEN_TRADES");
    warnings.push(
      `Mission already has ${aggregates.openCount} open trade(s) — at the ${budget.maxOpenTrades} cap.`,
    );
  }

  // ── Total mission risk amount. ─────────────────────────────────────────────
  const proposedRisk =
    Number.isFinite(proposed.riskAmount) && proposed.riskAmount > 0 ? proposed.riskAmount : 0;
  if (
    budget.maxMissionExposureAmount != null &&
    round2(aggregates.totalOpenRisk + proposedRisk) > budget.maxMissionExposureAmount
  ) {
    blockers.push("MISSION_OVEREXPOSURE");
    warnings.push(
      `Total mission risk would reach ${round2(aggregates.totalOpenRisk + proposedRisk)} — over the ${budget.maxMissionExposureAmount} cap.`,
    );
  }

  const allowed = blockers.length === 0;
  return {
    allowed,
    blockers,
    warnings,
    reason: allowed
      ? "Exposure within mission caps."
      : `Exposure blocked: ${blockers.join(", ")}.`,
    aggregates,
  };
}
