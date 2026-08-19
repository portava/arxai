// Centralized realized-P/L validator for live trades.
//
// SAFETY (inviolable):
// - A close fill price reported by the EA is only trustworthy when it is
//   a finite number strictly greater than zero. Missing / null / undefined
//   / NaN / 0 / +-Infinity / negative MUST NEVER be treated as a real fill.
// - When the close fill is not valid we DO NOT invent a P/L. We mark the
//   row pnlStatus="UNKNOWN" + dataQualityFlag="MISSING_CLOSE_FILL_PRICE"
//   and leave realizedPlUsd=null. Every downstream consumer (allocation
//   ledger, AI learning, aggregates, reports) must skip rows whose
//   pnlStatus !== "COMPUTED".
// - The math for COMPUTED is byte-identical to the previous inline
//   implementation in liveTestCycle.ts (EURUSD direction * 100_000 *
//   requestedVolume). Do not change the math without updating the test
//   suite — see scripts/src/realizedPnlGuardTest.ts.

export type PnlStatus = "PENDING" | "COMPUTED" | "UNKNOWN";

export const PNL_DATA_QUALITY_MISSING_CLOSE_FILL = "MISSING_CLOSE_FILL_PRICE" as const;

/**
 * Returns true ONLY when `x` is a finite real number > 0. Rejects null,
 * undefined, NaN, +-Infinity, 0, and negative numbers.
 */
export function isValidFillPrice(x: unknown): x is number {
  return typeof x === "number" && Number.isFinite(x) && x > 0;
}

export interface ComputeRealizedPnlInput {
  side: "BUY" | "SELL";
  requestedVolume: number;
  openFillPrice: number | null | undefined;
  closeFillPrice: number | null | undefined;
}

export interface ComputeRealizedPnlResult {
  pnlStatus: PnlStatus;
  realizedPlUsd: number | null;
  dataQualityFlag: string | null;
}

/**
 * Pure: never throws, never logs, no IO.
 *
 * - If BOTH open and close fills are valid (finite, > 0) → COMPUTED with
 *   the EURUSD math (direction * 100_000 * requestedVolume * (close-open)).
 * - If the close fill is invalid → UNKNOWN with the
 *   MISSING_CLOSE_FILL_PRICE flag. realizedPlUsd stays null.
 * - If the open fill is invalid → UNKNOWN with a generic missing-open
 *   flag (we still refuse to invent a number).
 */
export function computeRealizedPnlUsd(input: ComputeRealizedPnlInput): ComputeRealizedPnlResult {
  if (!isValidFillPrice(input.closeFillPrice)) {
    return {
      pnlStatus: "UNKNOWN",
      realizedPlUsd: null,
      dataQualityFlag: PNL_DATA_QUALITY_MISSING_CLOSE_FILL,
    };
  }
  if (!isValidFillPrice(input.openFillPrice)) {
    return {
      pnlStatus: "UNKNOWN",
      realizedPlUsd: null,
      dataQualityFlag: "MISSING_OPEN_FILL_PRICE",
    };
  }
  const direction = input.side === "BUY" ? 1 : -1;
  const vol = Number(input.requestedVolume);
  if (!Number.isFinite(vol) || vol <= 0) {
    return {
      pnlStatus: "UNKNOWN",
      realizedPlUsd: null,
      dataQualityFlag: "INVALID_REQUESTED_VOLUME",
    };
  }
  const pnl = (input.closeFillPrice - input.openFillPrice) * direction * 100_000 * vol;
  return {
    pnlStatus: "COMPUTED",
    realizedPlUsd: Number(pnl.toFixed(2)),
    dataQualityFlag: null,
  };
}

/**
 * Guard for any downstream reducer that ingests realized P/L. Returns true
 * when the row is safe to include in ledgers / aggregates / learning.
 */
export function isRealizedPnlIngestible(row: { pnlStatus?: string | null; realizedPlUsd?: number | null }): boolean {
  return row.pnlStatus === "COMPUTED"
    && typeof row.realizedPlUsd === "number"
    && Number.isFinite(row.realizedPlUsd);
}
