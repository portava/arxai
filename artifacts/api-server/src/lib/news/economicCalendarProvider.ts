// Economic-calendar provider seam (Task #197 wired Task #620).
//
// HONESTY (inviolable): this is the single source of truth for the Market Impact
// Radar's *scheduled economic events*. It returns the real provider connection
// state AND the real event list together, so the radar can never drift into
// showing events while reporting "disconnected" (or vice-versa).
//
// It delegates to the central, provider-agnostic economic-calendar service,
// which selects the active provider from `ECONOMIC_CALENDAR_PROVIDER` + its
// matching key (Trading Economics first for back-compat, then FRED) — never a
// single hardcoded provider. When no provider key is present the service reports
// status "missing" and this returns `connected:false` with an EMPTY event list —
// we NEVER fabricate a scheduled macro event, a forecast, or an `actual` result.
// A provider *error* is distinct from *missing* (`status:"error"`) so downstream
// surfaces can say "provider error" rather than "not configured". The
// `buildRadarEvents` domain honesty gate keeps suppressing everything until
// `connected` is genuinely true.

import type { RawCalendarEvent } from "@workspace/domain/smart-chart";
import type {
  CalendarEvent,
  CalendarFreshness,
  EconomicCalendarDiagnostics,
  EconomicCalendarStatus,
} from "./calendar/calendarTypes.js";
import {
  getEconomicCalendarResult,
  isEconomicCalendarConfigured,
} from "./calendar/economicCalendarService.js";
import { toRawCalendarEvents } from "./calendar/calendarAdapters.js";
import { eventMatchesSymbol, filterEventsForSymbol } from "./calendar/calendarSymbolMap.js";

/**
 * Resolve whether a real economic-calendar provider is enabled.
 *
 * Provider-agnostic: delegates to the central calendar service, which selects
 * the active provider from `ECONOMIC_CALENDAR_PROVIDER` + its matching key
 * (Trading Economics first for back-compat, then FRED). Enabled ⇔ a real
 * provider is configured with a present key — never hardcoded to one provider.
 *
 * This is the single gate for BOTH the live calendar endpoint and the sync-DB
 * path (`pickNewsProvider` resolves the SAME selected provider, so neither path
 * can fabricate events under a configured provider).
 */
export function isCalendarProviderEnabled(): boolean {
  return isEconomicCalendarConfigured();
}

/**
 * Explicit discriminant for calendar provider state. Consumers MUST use this
 * instead of inferring state from `connected` alone — the two non-connected
 * states require distinct UX copy:
 *
 *   "not_configured" — no key is set at all; user/operator action required.
 *   "fetch_error"    — key is present but the last fetch failed; will auto-retry.
 *   "connected"      — live fetch succeeded; events are real and fresh.
 */
export type CalendarProviderState = "not_configured" | "fetch_error" | "connected";

export interface EconomicCalendarSnapshot {
  /** True ONLY when a real economic-calendar provider feed is connected. */
  connected: boolean;
  /** Provider identifier ("none"/"trading_economics"). */
  provider: string;
  /** Honest provider state — distinguishes missing vs error vs empty vs ok. */
  status: EconomicCalendarStatus;
  /** Real scheduled events for this symbol from the connected provider. */
  events: RawCalendarEvent[];
  /**
   * Explicit provider state. Always use this for UX copy — `connected:false`
   * alone cannot distinguish "not configured" from "fetch failed".
   */
  providerState: CalendarProviderState;
}

/**
 * Read the scheduled economic calendar for a symbol from the connected provider.
 * Honest real-or-absent: when no live provider is configured this reports
 * `connected:false`, `status:"missing"` and an empty event list (never
 * fabricated). Events are filtered to those that actually map to `symbol`
 * (synthetics map to none).
 */
export async function getEconomicCalendar(
  symbol: string,
  nowMs: number = Date.now(),
): Promise<EconomicCalendarSnapshot> {
  const result = await getEconomicCalendarResult({ nowMs });
  // Only trust events when the provider is genuinely connected (ok/empty).
  const symbolEvents = result.connected
    ? filterEventsForSymbol(result.events, symbol)
    : [];
  // Derive the explicit provider-state discriminant from the honest service
  // result: unconfigured ⇒ not_configured, connected ⇒ connected, otherwise
  // (configured but the fetch failed) ⇒ fetch_error.
  const providerState: CalendarProviderState = !result.configured
    ? "not_configured"
    : result.connected
      ? "connected"
      : "fetch_error";
  return {
    connected: result.connected,
    // Report "none" when unconfigured so downstream `configured` checks stay honest.
    provider: result.configured ? result.provider : "none",
    status: result.status,
    events: toRawCalendarEvents(symbolEvents),
    providerState,
  };
}

// ── Live calendar endpoint (provider-agnostic enriched events) ───────────────

/**
 * Enriched calendar event for the live calendar endpoint. Provider-agnostic:
 * carries every display field the page needs, sourced from the shared
 * normalized `CalendarEvent` regardless of which provider produced it. `source`
 * is a free-form string (e.g. "FRED", "trading_economics") — never hardcoded.
 */
export interface EnrichedCalendarEvent {
  id: string;
  title: string;
  currency: string;
  impact: "low" | "medium" | "high";
  /** ISO-8601 UTC event time (alias of `eventTimeUtc` for back-compat). */
  eventTimeIso: string;
  eventTimeUtc: string;
  /** Localized time when the provider supplies one; null otherwise (never guessed). */
  eventTimeLocal: string | null;
  affectedMarkets: string[];
  affectedSymbols: string[];
  country: string;
  source: string;
  forecast: string | null;
  previous: string | null;
  actual: string | null;
  riskNote: string | null;
}

/** Optional filters applied to the enriched event list. All optional. */
export interface EnrichedCalendarFilters {
  /** Inclusive lower bound ISO date. Defaults to `nowMs`. */
  from?: string;
  /** Inclusive upper bound ISO date. Defaults to the daysAhead window. */
  to?: string;
  /** Only return events for these ISO currency codes. */
  currencies?: string[];
  /** Minimum impact level. */
  impact?: "low" | "medium" | "high";
  /** Additional ARX symbols to scope (in addition to the primary `symbol`). */
  symbols?: string[];
}

/**
 * Provider-agnostic liveness snapshot in the legacy route/health shape, derived
 * from the shared service diagnostics. Keeps the existing response contract.
 */
export interface CalendarLivenessSnapshot {
  lastFetchAt: string | null;
  lastErrorAt: string | null;
  lastErrorMessage: string | null;
  eventCount: number;
  freshnessStatus: "fresh" | "stale" | "unavailable";
}

const IMPACT_RANK: Record<string, number> = { low: 1, medium: 2, high: 3, critical: 3 };

function toThreeLevel(impact: CalendarEvent["impact"]): "low" | "medium" | "high" {
  return impact === "critical" ? "high" : impact;
}

function freshnessToStatus(f: CalendarFreshness): "fresh" | "stale" | "unavailable" {
  if (f === "LIVE" || f === "DELAYED") return "fresh";
  if (f === "STALE") return "stale";
  return "unavailable";
}

function livenessFromDiagnostics(d: EconomicCalendarDiagnostics): CalendarLivenessSnapshot {
  return {
    lastFetchAt: d.lastFetchAt,
    // The shared diagnostics carries a single `lastFetchAt` (attempt time) plus a
    // redacted `lastError`. When the last attempt failed, that attempt time IS
    // the error time; otherwise there is no error timestamp.
    lastErrorAt: d.lastError ? d.lastFetchAt : null,
    lastErrorMessage: d.lastError,
    eventCount: d.eventCount,
    freshnessStatus: freshnessToStatus(d.freshness),
  };
}

function toEnriched(e: CalendarEvent): EnrichedCalendarEvent {
  return {
    id: e.id,
    title: e.title,
    currency: e.currency,
    impact: toThreeLevel(e.impact),
    eventTimeIso: e.eventTimeUtc,
    eventTimeUtc: e.eventTimeUtc,
    eventTimeLocal: e.eventTimeLocal,
    affectedMarkets: e.affectedSymbols,
    affectedSymbols: e.affectedSymbols,
    country: e.country,
    source: e.source,
    forecast: e.forecast,
    previous: e.previous,
    actual: e.actual,
    riskNote: e.riskNote,
  };
}

/**
 * Enriched, filtered events for the live calendar endpoint — provider-agnostic.
 * Sources the shared service (TE or FRED) and returns the SAME response contract
 * the route always had (connected/provider/events) PLUS a liveness snapshot, in
 * a single fetch so the status and the events can never drift.
 *
 * Honesty: when the provider is not connected (missing key OR fetch failure) the
 * event list is empty and `connected:false` — the caller surfaces the honest
 * not_configured / fetch_error state, never a fabricated "no events".
 *
 * The shared service already windows events to `daysAhead`; this layer only
 * applies symbol scope and the optional date/currency/impact/symbols filters.
 */
export async function getEnrichedCalendarEvents(
  symbol: string,
  nowMs: number = Date.now(),
  windowMs = 72 * 60 * 60 * 1000,
  filters: EnrichedCalendarFilters = {},
): Promise<{
  connected: boolean;
  provider: string;
  events: EnrichedCalendarEvent[];
  liveness: CalendarLivenessSnapshot;
}> {
  const daysAhead = Math.max(1, Math.ceil(windowMs / 86_400_000));
  const result = await getEconomicCalendarResult({ daysAhead, nowMs });
  const liveness = livenessFromDiagnostics(result.diagnostics);

  if (!result.connected) {
    return {
      connected: false,
      provider: result.configured ? result.provider : "none",
      events: [],
      liveness,
    };
  }

  const fromMs = filters.from ? new Date(filters.from).getTime() : null;
  const toMs = filters.to ? new Date(filters.to).getTime() : null;
  const minImpactRank = filters.impact ? (IMPACT_RANK[filters.impact] ?? 1) : 0;

  const out: EnrichedCalendarEvent[] = [];
  for (const e of result.events) {
    // Explicit date-range filter (only when supplied — otherwise the service's
    // own daysAhead window stands, so date-granularity FRED events dated "today"
    // are never dropped by an intraday lower bound).
    if (fromMs !== null || toMs !== null) {
      const evMs = new Date(e.eventTimeUtc).getTime();
      if (fromMs !== null && evMs < fromMs) continue;
      if (toMs !== null && evMs > toMs) continue;
    }
    // Primary symbol scope.
    if (symbol.length > 0 && !eventMatchesSymbol(e, symbol)) continue;
    // Additional symbols filter (match any).
    if (filters.symbols && filters.symbols.length > 0) {
      if (!filters.symbols.some((s) => eventMatchesSymbol(e, s))) continue;
    }
    // Currency filter.
    if (filters.currencies && filters.currencies.length > 0) {
      if (!filters.currencies.includes(e.currency)) continue;
    }
    // Minimum-impact filter.
    if (minImpactRank > 0 && (IMPACT_RANK[e.impact] ?? 0) < minImpactRank) continue;
    out.push(toEnriched(e));
  }

  return { connected: true, provider: result.provider, events: out, liveness };
}

/**
 * Provider-agnostic calendar health snapshot for operator diagnostics. Reports
 * the SELECTED provider, configured/connected truth, and liveness derived from
 * the shared service — never a single hardcoded provider.
 */
export async function getCalendarHealthSnapshot(): Promise<
  { connected: boolean; provider: string; configured: boolean } & CalendarLivenessSnapshot
> {
  const result = await getEconomicCalendarResult();
  return {
    connected: result.connected,
    provider: result.configured ? result.provider : "none",
    configured: result.configured,
    ...livenessFromDiagnostics(result.diagnostics),
  };
}
