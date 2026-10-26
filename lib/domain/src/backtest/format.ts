// Display helpers for diagnostic backtests. Never infer currency or convert an
// absent/non-finite observation into zero. Price units retain small FX moves.
const finite = (value: unknown): value is number => typeof value === "number" && Number.isFinite(value);
const priceFormat = new Intl.NumberFormat("en-US", { maximumSignificantDigits: 10, useGrouping: false });
const numberFormat = new Intl.NumberFormat("en-US", { maximumFractionDigits: 2 });
const percentFormat = new Intl.NumberFormat("en-US", { maximumFractionDigits: 1 });
const unavailable = "Unavailable";

export function formatBacktestPriceUnits(value: unknown): string {
  if (!finite(value)) return unavailable;
  if (value === 0) return "0";
  if (Math.abs(value) < 0.000001 || Math.abs(value) >= 1e12) {
    const [coefficient, exponent] = value.toExponential(9).split("e");
    return `${coefficient!.replace(/\.?0+$/, "")}e${exponent}`;
  }
  return priceFormat.format(value);
}

export function formatBacktestNumber(value: unknown): string {
  if (!finite(value)) return unavailable;
  if (value !== 0 && Math.abs(value) < 0.01) return formatBacktestPriceUnits(value);
  return numberFormat.format(value === 0 ? 0 : value);
}

/** Input is the existing 0..1 ratio, not an already-scaled percentage. */
export function formatBacktestPercent(value: unknown): string {
  if (!finite(value) || !finite(value * 100)) return unavailable;
  const scaled = value * 100;
  if (scaled !== 0 && Math.abs(scaled) < 0.1) return `${formatBacktestPriceUnits(scaled)}%`;
  return `${percentFormat.format(scaled === 0 ? 0 : scaled)}%`;
}

export function formatBacktestProfitFactor(value: unknown): string {
  if (!finite(value)) return unavailable;
  // The old producer used 999 for infinity but could also produce exactly 999
  // as a finite ratio. The stored number cannot distinguish those histories.
  return value === 999 ? "Unavailable (legacy 999 marker)" : formatBacktestNumber(value);
}
