import { format } from "date-fns";

export function formatPrice(price: number | undefined | null): string {
  if (price == null) return "0.00";
  return price.toFixed(2);
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
