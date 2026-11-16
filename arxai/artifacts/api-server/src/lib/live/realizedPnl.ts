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
// - P0-2: the COMPUTED math is contract-size aware. It previously hardcoded
//   `* 100_000`, which is the EURUSD standard-lot contract size and is wrong
//   for every instrument that is not a standard FX lot: gold (100) was
//   over-stated 1,000x, silver (5,000) 20x, and any JPY-quoted pair booked
//   raw JPY as if it were USD. `contractSize` and `quoteToAccountFx` are now
//   REQUIRED inputs, resolved from broker truth by
//   `lib/mt5/contractSize.ts`. When either cannot be established we withhold
//   the figure (UNKNOWN) rather than book a plausible wrong dollar amount.
//   Do not change the math without updating the test suites —
//   scripts/src/realizedPnlGuardTest.ts and
//   scripts/src/realizedPnlContractSizeTest.ts.

export type PnlStatus = "PENDING" | "COMPUTED" | "UNKNOWN";

export const PNL_DATA_QUALITY_MISSING_CLOSE_FILL = "MISSING_CLOSE_FILL_PRICE" as const;
/** No trustworthy per-lot contract size for the symbol — figure withheld. */
export const PNL_DATA_QUALITY_MISSING_CONTRACT_SIZE = "MISSING_CONTRACT_SIZE" as const;
/** P/L is in a currency we cannot convert to the account currency — withheld. */
export const PNL_DATA_QUALITY_MISSING_FX = "MISSING_FX_CONVERSION" as const;

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
  /**
   * Units of the base instrument per 1.00 lot, from broker truth
   * (`arx_symbol_specs.contractSize`) via `resolveContractSize`. REQUIRED —
   * passing null withholds the figure instead of assuming a standard FX lot.
   */
  contractSize: number | null;
  /**
   * Profit-currency → account-currency factor from `resolveQuoteToAccountFx`.
   * 1 when the symbol's profit currency IS the account currency. REQUIRED —
   * passing null withholds the figure instead of booking a foreign-currency
   * amount as if it were account currency.
   */
  quoteToAccountFx: number | null;
}

export interface ComputeRealizedPnlResult {
  pnlStatus: PnlStatus;
  realizedPlUsd: number | null;
  dataQualityFlag: string | null;
}

/**
 * Pure: never throws, never logs, no IO.
 *
 * - If both fills are valid AND the sizing inputs are established → COMPUTED
 *   with (close-open) * direction * volume * contractSize * quoteToAccountFx.
 * - If the close fill is invalid → UNKNOWN with the
 *   MISSING_CLOSE_FILL_PRICE flag. realizedPlUsd stays null.
 * - If the open fill is invalid → UNKNOWN with a generic missing-open
 *   flag (we still refuse to invent a number).
 * - If contractSize or quoteToAccountFx is null → UNKNOWN with
 *   MISSING_CONTRACT_SIZE / MISSING_FX_CONVERSION. We do NOT fall back to a
 *   standard FX lot or a 1:1 rate: a plausible wrong dollar figure is worse
 *   than an honest absent one, because it silently feeds equity readouts and
 *   the allocation-blown risk cap.
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
  // P0-2 — sizing is REQUIRED, never assumed. A missing contract size used to
  // be an invisible `* 100_000`, which mis-sized every non-standard-FX-lot
  // instrument (gold 1,000x, silver 20x) and booked JPY as USD.
  const { contractSize, quoteToAccountFx } = input;
  if (contractSize == null || !Number.isFinite(contractSize) || contractSize <= 0) {
    return {
      pnlStatus: "UNKNOWN",
      realizedPlUsd: null,
      dataQualityFlag: PNL_DATA_QUALITY_MISSING_CONTRACT_SIZE,
    };
  }
  if (quoteToAccountFx == null || !Number.isFinite(quoteToAccountFx) || quoteToAccountFx <= 0) {
    return {
      pnlStatus: "UNKNOWN",
      realizedPlUsd: null,
      dataQualityFlag: PNL_DATA_QUALITY_MISSING_FX,
    };
  }
  const pnl =
    (input.closeFillPrice - input.openFillPrice) * direction * vol * contractSize * quoteToAccountFx;
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
