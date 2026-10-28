import { format } from "date-fns";
import { priceDecimalsOf } from "@/lib/instrumentPriceFormat";

/**
 * Format a stored price without rounding away the digits it was quoted at:
 * at least 2 decimals, more when the value carries them (EURUSD 1.08523 →
 * "1.08523", USDJPY 150.123 → "150.123"), capped at 8. A missing or
 * non-finite price is "—", never a fabricated "0.00".
 */
export function formatPrice(price: number | undefined | null): string {
  if (price == null || !Number.isFinite(price)) return "—";
  return price.toFixed(Math.max(2, priceDecimalsOf(price)));
}

export function formatPnl(pnl: number | undefined | null): string {
  if (pnl == null) return "$0.00";
  const sign = pnl > 0 ? "+" : "";
  return `${sign}$${pnl.toFixed(2)}`;
}

export function formatPercent(pct: number | undefined | null): string {
  if (pct == null) return "0.00%";
  return `${pct.toFixed(2)}%`;
}

export function formatDate(dateStr: string | undefined | null): string {
  if (!dateStr) return "N/A";
  try {
    return format(new Date(dateStr), "yyyy-MM-dd HH:mm:ss");
  } catch (e) {
    return dateStr;
  }
}

export function formatConfidence(score: number | undefined | null): string {
  if (score == null) return "0%";
  return `${Math.round(score)}%`;
}
