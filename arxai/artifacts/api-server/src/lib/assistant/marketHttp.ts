import { logger } from "../logger.js";

type Failure = "AUTHENTICATION" | "ACCESS_RESTRICTED" | "RATE_LIMITED" | "PROVIDER_ERROR";
export function providerFailureCode(payload: unknown): Failure | null {
  if (!payload || typeof payload !== "object") return null;
  const p = payload as Record<string, unknown>;
  const text = [p.Information, p.Note, p["Error Message"], p.error, p.message, p.status]
    .filter(v => typeof v === "string").join(" ").toLowerCase();
  if (/invalid.{0,12}(api|key)|unauthenticated/.test(text)) return "AUTHENTICATION";
  if (/premium|subscription|not.authorized|access to this resource|entitlement/.test(text)) return "ACCESS_RESTRICTED";
  if (/rate.limit|call frequency|requests per|calls per|too many/.test(text) || p.code === 429) return "RATE_LIMITED";
  return p.error || p["Error Message"] || p.Information || p.Note || p.status === "error" ? "PROVIDER_ERROR" : null;
}
export interface MarketHttpObservation {
  provider: string; operation: "quote" | "candles" | "other";
  status: number | null; reason: Failure | "HTTP_ERROR" | "TRANSPORT_ERROR" | "TIMEOUT" | "INVALID_JSON" | null;
  observedAt: string;
}
const observations: MarketHttpObservation[] = [];
export function getMarketHttpObservations(): MarketHttpObservation[] { return observations.map(o => ({ ...o })); }
export function resetMarketHttpObservations(): void { observations.length = 0; }
function identity(url: string): Pick<MarketHttpObservation, "provider" | "operation"> {
  const u = new URL(url);
  const provider = ({ "www.alphavantage.co": "alpha_vantage", "api.polygon.io": "polygon",
    "finnhub.io": "finnhub", "api.twelvedata.com": "twelve_data", "newsapi.org": "newsapi" } as Record<string, string>)[u.hostname] ?? "other";
  const fn = u.searchParams.get("function") ?? "";
  const operation = /candle|time_series|\/range\//.test(u.pathname) || fn === "FX_INTRADAY" ? "candles"
    : /quote|snapshot|\/prev$/.test(u.pathname) || ["GLOBAL_QUOTE", "CURRENCY_EXCHANGE_RATE"].includes(fn) ? "quote" : "other";
  return { provider, operation };
}
export async function marketHttpJson(url: string, headers?: Record<string, string>, timeoutMs = 5000): Promise<unknown> {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  const entry: MarketHttpObservation = { ...identity(url), status: null, reason: null, observedAt: new Date().toISOString() };
  try {
    const response = await fetch(url, { headers, signal: ctrl.signal });
    entry.status = response.status;
    if (!response.ok) {
      entry.reason = response.status === 401 ? "AUTHENTICATION" : response.status === 403 ? "ACCESS_RESTRICTED"
        : response.status === 429 ? "RATE_LIMITED" : "HTTP_ERROR";
      return null;
    }
    let data: unknown;
    try { data = await response.json(); } catch { entry.reason = ctrl.signal.aborted ? "TIMEOUT" : "INVALID_JSON"; return null; }
    entry.reason = providerFailureCode(data);
    return data;
  } catch { entry.reason = ctrl.signal.aborted ? "TIMEOUT" : "TRANSPORT_ERROR"; return null; }
  finally {
    clearTimeout(timer);
    observations.push(entry); if (observations.length > 32) observations.shift();
    // No URL, query, credential, upstream message, payload or thrown error text.
    if (entry.reason) logger.warn(entry, "Market data request unavailable");
  }
}
