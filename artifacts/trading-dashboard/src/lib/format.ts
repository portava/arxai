import { format } from "date-fns";

// An absent number is an absent number. Rendering null as "0.00" / "$0.00" /
// "0.00%" fabricated a confident zero on real-money surfaces (a failed read
// looked identical to a genuinely flat account). "—" is the honest render —
// same contract as the admin cockpit's fmtMoney/fmtPl.
export function formatPrice(price: number | undefined | null): string {
  if (price == null) return "—";
  return price.toFixed(2);
}

export function formatPnl(pnl: number | undefined | null): string {
  if (pnl == null) return "—";
  const sign = pnl > 0 ? "+" : "";
  return `${sign}$${pnl.toFixed(2)}`;
}

export function formatPercent(pct: number | undefined | null): string {
  if (pct == null) return "—";
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
