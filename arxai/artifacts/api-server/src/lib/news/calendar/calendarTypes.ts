// Trading Economics economic-calendar — shared normalized shape + honest status.
//
// HONESTY (inviolable): every consumer surface distinguishes the four states
// below. A missing API key is NEVER "no events"/"low risk"; a provider error is
// NEVER silently "no events"; a genuine empty success IS "no relevant events".
// Stale data is only ever shown when explicitly labelled STALE.
//
// This module is PURE TYPES ONLY. It imports nothing from the execution path,
// MT5 bridge, broker dispatch, or any safety gate — the economic calendar is
// read/risk-context only and can never influence a trade decision.

export type EconomicCalendarImpact = "low" | "medium" | "high" | "critical";

/**
 * The four honest provider states:
 *  - `missing` — no API key / provider not configured. Surface "provider missing".
 *  - `error`   — provider configured but the fetch failed. Surface "provider error".
 *  - `empty`   — provider reachable, returned zero relevant events. "No relevant events".
 *  - `ok`      — provider reachable, returned one or more events.
 */
export type EconomicCalendarStatus = "ok" | "empty" | "missing" | "error";

export type CalendarFreshness = "LIVE" | "DELAYED" | "STALE" | "UNAVAILABLE";

/** Rich, normalized economic-calendar event — the single shared shape. */
export interface CalendarEvent {
  /** Stable provider-scoped id (e.g. Trading Economics CalendarId). */
  id: string;
  /** Provider identifier, e.g. "trading_economics". */
  provider: string;
  /** Upstream source label (provider's `Source` field or the provider name). */
  source: string;
  /** Country name as reported by the provider, e.g. "United States". */
  country: string;
  /** ISO currency code, e.g. "USD". May be "" when the provider omits it. */
  currency: string;
  /** Provider category, e.g. "Inflation Rate". Null when absent. */
  category: string | null;
  /** Human event title, e.g. "Inflation Rate YoY". */
  title: string;
  /** Normalized impact bucket. */
  impact: EconomicCalendarImpact;
  /** Scheduled time in UTC, ISO 8601. */
  eventTimeUtc: string;
  /** Localized time when a timezone is supplied; null otherwise (never guessed). */
  eventTimeLocal: string | null;
  /** Released actual value (string to preserve units/percent). Null if unreleased. */
  actual: string | null;
  /** Consensus forecast. Null when none. */
  forecast: string | null;
  /** Previous period value. Null when none. */
  previous: string | null;
  /** Revised previous value. Null when none. */
  revised: string | null;
  /** Unit, e.g. "%", "K", "Billion". Null when none. */
  unit: string | null;
  /** Raw provider importance (1..3 for Trading Economics). Null when absent. */
  importance: number | null;
  /** When this event was fetched/normalized (ISO). */
  lastUpdatedAt: string;
  /** Freshness of the underlying fetch. */
  freshness: CalendarFreshness;
  /** ARX symbols this event maps to (derived from currency/country). */
  affectedSymbols: string[];
  /** Short risk note for high/critical events; null for low-impact. */
  riskNote: string | null;
}

/**
 * Operator diagnostics. NEVER contains the raw key or secret — only a boolean
 * presence flag and a redacted error string.
 */
export interface EconomicCalendarDiagnostics {
  provider: string;
  configured: boolean;
  /** Presence ONLY — never the key value. */
  apiKeyPresent: boolean;
  status: EconomicCalendarStatus;
  lastFetchAt: string | null;
  lastSuccessAt: string | null;
  /** Redacted error message (key/secret never included). */
  lastError: string | null;
  eventCount: number;
  freshness: CalendarFreshness;
  cacheAgeMs: number | null;
}

/** The canonical service result every adapter is derived from. */
export interface EconomicCalendarResult {
  status: EconomicCalendarStatus;
  /** True only when the provider is reachable now (status ok|empty). */
  connected: boolean;
  /** True when an API key + provider are configured. */
  configured: boolean;
  provider: string;
  /** Fresh events for ok; [] for empty/missing; last-good (STALE) only labelled on error. */
  events: CalendarEvent[];
  diagnostics: EconomicCalendarDiagnostics;
  /** Honest human-readable status line. */
  message: string;
}
