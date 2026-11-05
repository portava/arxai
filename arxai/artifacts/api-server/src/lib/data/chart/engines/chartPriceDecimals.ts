// One precision rule for every chart engine that rounds or prints a level
// price: the instrument's declared precision (the chart truth result, else the
// symbol profile), widened by the digits the bars actually carry, and the
// legacy magnitude rule only when neither is known (resolveChartPriceDecimals,
// the same rule as the dashboard price axis). Display / report only — never an
// order tick size or an execution input.

import { resolveChartPriceDecimals } from "@workspace/domain/chart-patterns";
import type { NormalizedChartCandle } from "../candleNormalization.js";
import { knownPricePrecision } from "../symbolProfile.js";

type PriceBar = Pick<NormalizedChartCandle, "open" | "high" | "low" | "close"> & { symbol?: string };

/**
 * Decimals to round / print this window's level prices at. `symbol` defaults
 * to the bars' own symbol. `declaredPricePrecision`: the chart truth result's
 * precision; when omitted (undefined) the symbol profile's known precision is
 * used; null means "not declared" (observed digits only).
 */
export function chartPriceDecimals(
  closed: readonly PriceBar[],
  symbol?: string | null,
  declaredPricePrecision?: number | null,
): number {
  const last = closed[closed.length - 1];
  const sym = symbol ?? last?.symbol ?? "";
  const declared = declaredPricePrecision === undefined ? knownPricePrecision(sym) : declaredPricePrecision;
  return resolveChartPriceDecimals(
    declared,
    closed.slice(-60).flatMap((c) => [c.open, c.high, c.low, c.close]),
    last?.close ?? 0,
  );
}

/** A usable decimals value (0–8 whole places), else null. */
export function validPriceDecimals(d: unknown): number | null {
  return typeof d === "number" && Number.isSafeInteger(d) && d >= 0 && d <= 8 ? d : null;
}

/**
 * A price printed at `decimals` fixed places ("2400.50", never "2400.5"), or
 * the plain number when no precision is known.
 */
export function chartPriceText(price: number, decimals: number | null | undefined): string {
  const d = validPriceDecimals(decimals);
  return d == null ? `${price}` : price.toFixed(d);
}
