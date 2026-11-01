import type { Freshness } from "@/hooks/useLiveAccountSnapshot";

export const MASTER_VALUE_LIMITATION = "Value freshness unverified — these stored values may include older or default amounts after a partial update. Individual broker observations are unverified. Open P/L is unavailable without a verified broker profit report.";
export function masterAccountMoney(n: number | null | undefined, currency: string | null | undefined): string {
  if (typeof n !== "number" || !Number.isFinite(n)) return "—";
  return typeof currency === "string" && /^[A-Z]{3}$/.test(currency)
    ? new Intl.NumberFormat(undefined, { style: "currency", currency }).format(n)
    : `${n.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })} (currency unverified)`;
}
export function masterAccountUpdateText(evidence: {observedAtMs:number|null;freshness:Freshness}): string {
  const stamp=evidence.observedAtMs == null ? "Last account update: unknown." : `Last account update: ${new Date(evidence.observedAtMs).toISOString()}.`;
  return stamp + (evidence.freshness === "stale" ? " This account update is stale." : evidence.freshness === "unavailable" ? " Account update freshness is unverified." : evidence.freshness === "delayed" ? " This account update is delayed." : "");
}
