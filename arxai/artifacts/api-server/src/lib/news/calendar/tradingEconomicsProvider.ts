// Trading Economics economic-calendar provider.
//
// HONESTY: this provider only ever returns events it actually fetched. It never
// fabricates an event, a forecast, or an `actual`. Missing key ⇒ not configured;
// a fetch failure surfaces as an error (caller maps to "provider error"). The
// raw→normalized mapping is pure and the HTTP fetch is injectable so the whole
// pipeline is testable offline.
//
// Read/risk-context only — imports nothing from the execution path, MT5 bridge,
// broker dispatch, or any safety gate.

import type { CalendarEvent, EconomicCalendarImpact } from "./calendarTypes.js";
import { affectedSymbolsFor, riskNoteFor } from "./calendarSymbolMap.js";

export const TRADING_ECONOMICS_PROVIDER = "trading_economics";

/** Injectable HTTP fetcher (so tests never touch the network). */
export type CalendarHttpFetcher = (url: string) => Promise<{
  ok: boolean;
  status: number;
  text(): Promise<string>;
}>;

export interface TradingEconomicsConfig {
  /** API key (or "key:secret"); presence only is ever logged. */
  key: string;
  /** Optional secret — combined as "key:secret" per TE auth. */
  secret?: string | undefined;
}

/**
 * Resolve the configured provider + key from env WITHOUT exposing the value.
 * `ECONOMIC_CALENDAR_PROVIDER` selects the provider; `TRADING_ECONOMICS_KEY`
 * (+ optional `TRADING_ECONOMICS_SECRET`) carries credentials.
 */
export function resolveTradingEconomicsConfig(
  env: NodeJS.ProcessEnv = process.env,
): TradingEconomicsConfig | null {
  const provider = (env["ECONOMIC_CALENDAR_PROVIDER"] ?? "").trim().toLowerCase();
  const key = (env["TRADING_ECONOMICS_KEY"] ?? "").trim();
  const secret = (env["TRADING_ECONOMICS_SECRET"] ?? "").trim();
  // Provider must be explicitly selected as trading_economics AND a key present.
  if (provider !== TRADING_ECONOMICS_PROVIDER) return null;
  if (!key) return null;
  return { key, secret: secret || undefined };
}

/** True when Trading Economics is the selected provider and a key is present. */
export function isTradingEconomicsConfigured(env: NodeJS.ProcessEnv = process.env): boolean {
  return resolveTradingEconomicsConfig(env) !== null;
}

/**
 * True when trading_economics is the SELECTED provider, regardless of whether a
 * key is present. Used to decide honesty vs back-compat: when TE is selected but
 * the key is missing, surfaces must serve honest-empty (never the mock
 * generator). Mock back-compat applies ONLY when no provider is selected.
 */
export function isTradingEconomicsSelected(env: NodeJS.ProcessEnv = process.env): boolean {
  return (env["ECONOMIC_CALENDAR_PROVIDER"] ?? "").trim().toLowerCase() === TRADING_ECONOMICS_PROVIDER;
}

/** The `c=` credential param for TE: "key" or "key:secret". */
function credential(cfg: TradingEconomicsConfig): string {
  return cfg.secret ? `${cfg.key}:${cfg.secret}` : cfg.key;
}

function ymd(d: Date): string {
  return d.toISOString().slice(0, 10);
}

/** Build the TE calendar URL for a [now, now+daysAhead] window. */
export function buildTradingEconomicsUrl(
  cfg: TradingEconomicsConfig,
  opts: { daysAhead: number; nowMs: number },
): string {
  const d1 = new Date(opts.nowMs);
  const d2 = new Date(opts.nowMs + Math.max(1, opts.daysAhead) * 86_400_000);
  const params = new URLSearchParams({
    c: credential(cfg),
    f: "json",
    d1: ymd(d1),
    d2: ymd(d2),
  });
  return `https://api.tradingeconomics.com/calendar?${params.toString()}`;
}

/** Raw Trading Economics calendar row (only the fields we consume). */
export interface RawTradingEconomicsEvent {
  CalendarId?: string | number;
  Date?: string;
  Country?: string;
  Category?: string;
  Event?: string;
  Reference?: string;
  Source?: string;
  Actual?: string | number | null;
  Previous?: string | number | null;
  Forecast?: string | number | null;
  TEForecast?: string | number | null;
  Revised?: string | number | null;
  Importance?: number | string;
  Currency?: string;
  Unit?: string;
  LastUpdate?: string;
  Symbol?: string;
  Ticker?: string;
}

// Central-bank rate decisions are de-facto CRITICAL even though TE marks them
// importance 3 (high). Promote so downstream "no-trade window" logic can fire.
const CRITICAL_TITLE_RE =
  /(fed interest rate|fomc|ecb interest rate|ecb rate|boe interest rate|bank of england.*rate|boj.*rate|interest rate decision|rate decision)/i;

function impactOf(importance: number, title: string): EconomicCalendarImpact {
  if (CRITICAL_TITLE_RE.test(title)) return "critical";
  if (importance >= 3) return "high";
  if (importance === 2) return "medium";
  return "low";
}

function str(v: string | number | null | undefined): string | null {
  if (v === null || v === undefined) return null;
  const s = String(v).trim();
  return s.length > 0 ? s : null;
}

function toIsoUtc(date: string | undefined): string | null {
  if (!date) return null;
  // TE returns "2026-06-19T12:30:00" (UTC, no zone) or with offset. Normalize.
  const hasZone = /[zZ]|[+-]\d{2}:?\d{2}$/.test(date);
  const parsed = Date.parse(hasZone ? date : `${date}Z`);
  if (!Number.isFinite(parsed)) return null;
  return new Date(parsed).toISOString();
}

/** Pure raw→normalized mapping. Drops rows without a usable time/title. */
export function normalizeTradingEconomicsEvents(
  raw: RawTradingEconomicsEvent[],
  opts: { nowMs: number; freshness: CalendarEvent["freshness"] },
): CalendarEvent[] {
  const lastUpdatedAt = new Date(opts.nowMs).toISOString();
  const out: CalendarEvent[] = [];
  for (const r of raw) {
    const eventTimeUtc = toIsoUtc(r.Date);
    const title = str(r.Event);
    if (!eventTimeUtc || !title) continue;
    const importanceNum = Number(r.Importance);
    const importance = Number.isFinite(importanceNum) ? importanceNum : null;
    const currency = str(r.Currency) ?? "";
    const country = str(r.Country) ?? "";
    const impact = impactOf(importance ?? 0, title);
    const id = str(r.CalendarId) ?? `${title}_${eventTimeUtc}`.replace(/\s+/g, "_");
    out.push({
      id,
      provider: TRADING_ECONOMICS_PROVIDER,
      source: str(r.Source) ?? "Trading Economics",
      country,
      currency,
      category: str(r.Category),
      title,
      impact,
      eventTimeUtc,
      eventTimeLocal: null,
      actual: str(r.Actual),
      forecast: str(r.Forecast) ?? str(r.TEForecast),
      previous: str(r.Previous),
      revised: str(r.Revised),
      unit: str(r.Unit),
      importance,
      lastUpdatedAt,
      freshness: opts.freshness,
      affectedSymbols: affectedSymbolsFor(currency, country),
      riskNote: riskNoteFor(impact, currency),
    });
  }
  out.sort((a, b) => Date.parse(a.eventTimeUtc) - Date.parse(b.eventTimeUtc));
  return out;
}

/**
 * Fetch + normalize the TE calendar. Throws on network/parse/HTTP error so the
 * service can map it to an honest "provider error" (never a silent empty).
 */
export async function fetchTradingEconomicsCalendar(
  cfg: TradingEconomicsConfig,
  opts: { daysAhead: number; nowMs: number; fetcher: CalendarHttpFetcher },
): Promise<CalendarEvent[]> {
  const url = buildTradingEconomicsUrl(cfg, opts);
  const res = await opts.fetcher(url);
  if (!res.ok) {
    throw new Error(`Trading Economics HTTP ${res.status}`);
  }
  const body = await res.text();
  let parsed: unknown;
  try {
    parsed = JSON.parse(body);
  } catch {
    throw new Error("Trading Economics returned non-JSON body");
  }
  if (!Array.isArray(parsed)) {
    // TE returns a string message on auth failure / quota.
    throw new Error("Trading Economics returned an unexpected (non-array) payload");
  }
  return normalizeTradingEconomicsEvents(parsed as RawTradingEconomicsEvent[], {
    nowMs: opts.nowMs,
    freshness: "LIVE",
  });
}

/** Redact any occurrence of the key/secret from an error message. */
export function redactError(err: unknown, cfg: TradingEconomicsConfig | null): string {
  let msg = err instanceof Error ? err.message : String(err);
  if (cfg) {
    const tokens = [cfg.key, cfg.secret, credential(cfg)].filter(Boolean) as string[];
    for (const t of tokens) {
      if (t) msg = msg.split(t).join("***");
    }
  }
  return msg.slice(0, 280);
}
