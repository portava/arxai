// Trading Economics calendar adapter.
//
// Implements:
//   - NewsProvider (fetchEvents) — for the /economic-events/sync path
//   - getCalendarSnapshot(symbol?) → EconomicCalendarSnapshot — for the radar/Ruby seam
//
// Honesty rules (inviolable):
//   - `connected` is true ONLY when a real fetch succeeded from TE API.
//   - Events are real TE data or nothing — never mock/fabricated.
//   - API key is NEVER logged or returned in any response field.
//   - `lastErrorMessage` is pre-scrubbed of the key before storage.
//   - Liveness state (lastFetchAt, lastErrorAt) is module-level so admin
//     diagnostics can read the same source without a second fetch.
//
// Rate-limit strategy: one shared cache (5 min TTL) for the full upcoming
// calendar, shared across all symbol queries. TE free tier: ~20–100 req/day.

import { logger } from "../../logger.js";
import type { ProviderEvent } from "./newsProvider.js";
import type { EconomicCalendarSnapshot } from "../economicCalendarProvider.js";
import { type RawCalendarEvent, eventAffectsSymbol } from "@workspace/domain/smart-chart";

// ── Pure mapping functions (imported from logger-free core) ────────────────
import {
  impactToLevel,
  teEventToRaw,
  isInFetchWindow,
  computeFreshnessStatus,
  computeProviderState,
  type MinimalTeEvent,
} from "./tradingEconomicsCore.js";

/**
 * Enriched calendar event — the base `RawCalendarEvent` fields plus
 * provider-specific metadata and display helpers.
 * Returned by `getCalendarEventsEnriched` for the live calendar endpoint.
 * Structurally a subtype of `RawCalendarEvent` (all base fields are present).
 */
export interface CalendarEventFull extends RawCalendarEvent {
  country: string;
  source: "trading_economics";
  forecast: string | null;
  previous: string | null;
  actual: string | null;
  /** ISO-8601 event time in UTC — same as `eventTimeIso`, explicit name for contract clarity. */
  eventTimeUtc: string;
  /**
   * Event time suitable for local-time rendering. TE reports all times in UTC;
   * this field carries the same UTC ISO string — the frontend should format it
   * using `Intl.DateTimeFormat` with the user's browser locale.
   */
  eventTimeLocal: string;
  /** Explicit alias for `affectedMarkets` — for consumers that prefer this name. */
  affectedSymbols: string[];
  /** Brief human-readable risk note derived from impact level; null for low-impact events. */
  riskNote: string | null;
}

/** Minimum impact rank for filtering (low=1, medium=2, high=3). */
const IMPACT_RANK: Record<string, number> = { low: 1, medium: 2, high: 3 };

function deriveRiskNote(impact: string): string | null {
  if (impact === "high") return "High-impact release — consider reduced size or sitting out.";
  if (impact === "medium") return "Medium-impact release — monitor for increased volatility.";
  return null;
}

/** Filters to apply when returning enriched events. All optional. */
export interface CalendarEventFilters {
  /** Inclusive lower bound ISO date (e.g. "2025-01-15"). Defaults to now. */
  from?: string;
  /** Inclusive upper bound ISO date. Defaults to daysAhead from now. */
  to?: string;
  /** Only return events for these currency codes (e.g. ["USD","EUR"]). */
  currencies?: string[];
  /** Minimum impact level ("low" | "medium" | "high"). */
  impact?: "low" | "medium" | "high";
  /** ARX symbols to scope (in addition to the `symbol` param). */
  symbols?: string[];
}

// ── TE API response shape ───────────────────────────────────────────────────
interface TeEvent extends MinimalTeEvent {
  Reference?: string;
  Source?: string;
  LastUpdate?: string;
  revised?: string | null;
  Unit?: string;
  Symbol?: string;
}

// ── Liveness tracking ──────────────────────────────────────────────────────
export interface CalendarProviderLiveness {
  lastFetchAt: string | null;
  lastErrorAt: string | null;
  lastErrorMessage: string | null;
  eventCount: number;
  freshnessStatus: "fresh" | "stale" | "unavailable";
}

const FRESH_TTL_MS = 5 * 60 * 1000;  // 5 min

const liveness: CalendarProviderLiveness = {
  lastFetchAt: null,
  lastErrorAt: null,
  lastErrorMessage: null,
  eventCount: 0,
  freshnessStatus: "unavailable",
};

export function getCalendarLiveness(): Readonly<CalendarProviderLiveness> {
  return {
    ...liveness,
    freshnessStatus: computeFreshnessStatus(liveness, FRESH_TTL_MS),
  };
}

// ── In-memory cache ────────────────────────────────────────────────────────
let cachedEvents: TeEvent[] | null = null;
let cacheAt = 0;

// ── HTTP helper ───────────────────────────────────────────────────────────
async function fetchTeCalendar(apiKey: string, daysAhead = 7): Promise<TeEvent[]> {
  const now = new Date();
  const d1 = now.toISOString().slice(0, 10);
  const d2 = new Date(now.getTime() + daysAhead * 86400_000).toISOString().slice(0, 10);
  const url = `https://api.tradingeconomics.com/calendar?c=${encodeURIComponent(apiKey)}&d1=${d1}&d2=${d2}`;
  const safeUrl = url.replace(encodeURIComponent(apiKey), "<KEY_REDACTED>");

  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), 8000);
  try {
    const r = await fetch(url, { signal: ctrl.signal });
    if (!r.ok) {
      const msg = `TE API returned HTTP ${r.status}`;
      logger.warn({ url: safeUrl, status: r.status }, "tradingEconomicsAdapter: non-2xx");
      throw new Error(msg);
    }
    const json = await r.json() as unknown;
    if (!Array.isArray(json)) {
      throw new Error(`TE API response is not an array (got ${typeof json})`);
    }
    return json as TeEvent[];
  } finally {
    clearTimeout(t);
  }
}

// ── Cached fetch (shared across all callers) ──────────────────────────────
async function getCachedTeEvents(apiKey: string, daysAhead = 7): Promise<TeEvent[]> {
  const ageMs = Date.now() - cacheAt;
  if (cachedEvents && ageMs < FRESH_TTL_MS) return cachedEvents;

  try {
    const events = await fetchTeCalendar(apiKey, daysAhead);
    cachedEvents = events;
    cacheAt = Date.now();
    liveness.lastFetchAt = new Date().toISOString();
    liveness.eventCount = events.length;
    liveness.lastErrorAt = null;
    liveness.lastErrorMessage = null;
    liveness.freshnessStatus = "fresh";
    return events;
  } catch (e) {
    // Scrub key from error message before storing
    let msg = String((e as Error).message ?? e).slice(0, 280);
    // Remove any occurrence of the API key from the error message
    const keyRe = new RegExp(escapeRegex(apiKey), "g");
    msg = msg.replace(keyRe, "<KEY_REDACTED>");
    liveness.lastErrorAt = new Date().toISOString();
    liveness.lastErrorMessage = msg;
    liveness.freshnessStatus = "unavailable";
    logger.warn({ err: msg }, "tradingEconomicsAdapter: fetch failed");
    throw e;
  }
}

function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

// ── Normalize a TE event → ProviderEvent ─────────────────────────────────
function teToProvider(e: TeEvent): ProviderEvent | null {
  const raw = teEventToRaw(e);
  if (!raw) return null;
  return {
    externalId: raw.id,
    eventName: raw.title,
    country: e.Country ?? "",
    currency: raw.currency,
    impactLevel: impactToLevel(raw.impact),
    forecast: e.Forecast ?? e.TEForecast ?? null,
    previous: e.Previous ?? null,
    actual: e.Actual ?? null,
    eventTime: new Date(raw.eventTimeIso),
    source: "trading_economics",
    affectedSymbols: raw.affectedMarkets.length > 0 ? raw.affectedMarkets : null,
  };
}

// ── Public API ─────────────────────────────────────────────────────────────

/**
 * Returns the CONFIGURED state and the auth credential (if set). Callers use
 * this to decide whether to instantiate an adapter — never to expose the key.
 *
 * TE auth: plans that need key-only use `TRADING_ECONOMICS_KEY`.
 * Plans that need key+secret use both `TRADING_ECONOMICS_KEY` and
 * `TRADING_ECONOMICS_SECRET`; the combined credential is "key:secret".
 */
export function getTradingEconomicsConfig(): { configured: boolean; apiKey: string | null } {
  const key    = process.env["TRADING_ECONOMICS_KEY"]?.trim() ?? "";
  const secret = process.env["TRADING_ECONOMICS_SECRET"]?.trim() ?? "";
  if (!key) return { configured: false, apiKey: null };
  // When a secret is provided, TE expects "key:secret" as the `c` param.
  const credential = secret ? `${key}:${secret}` : key;
  return { configured: true, apiKey: credential };
}

/**
 * Fetch upcoming events as `ProviderEvent[]` (for the /economic-events/sync path).
 * Returns [] when not configured (no key set).
 * Propagates errors on fetch failure — callers must NOT treat an error as
 * "connected but empty". The sync route catches and surfaces a proper failure.
 */
export async function fetchTEEvents(daysAhead = 7): Promise<{ provider: string; events: ProviderEvent[] }> {
  const { configured, apiKey } = getTradingEconomicsConfig();
  if (!configured || !apiKey) return { provider: "trading_economics", events: [] };

  // Do NOT catch here — let fetch errors propagate so the sync route can
  // report a real failure instead of a misleading "upserted: 0 / success".
  const raw = await getCachedTeEvents(apiKey, daysAhead);
  const events: ProviderEvent[] = [];
  for (const e of raw) {
    const p = teToProvider(e);
    if (p) events.push(p);
  }
  return { provider: "trading_economics", events };
}

// ── Internal enriched mapping ─────────────────────────────────────────────
function teToFull(e: TeEvent): CalendarEventFull | null {
  const raw = teEventToRaw(e);
  if (!raw) return null;
  return {
    ...raw,
    country: e.Country ?? "",
    source: "trading_economics",
    forecast: e.Forecast ?? e.TEForecast ?? null,
    previous: e.Previous ?? null,
    actual: e.Actual ?? null,
    eventTimeUtc: raw.eventTimeIso,
    // TE reports times in UTC; the frontend formats this via Intl.DateTimeFormat.
    eventTimeLocal: raw.eventTimeIso,
    affectedSymbols: raw.affectedMarkets,
    riskNote: deriveRiskNote(raw.impact),
  };
}

/**
 * Build an `EconomicCalendarSnapshot` for the given symbol (for the radar/Ruby seam).
 * `connected` is true ONLY when the API key is set and the fetch succeeded.
 * Events are filtered to the upcoming window AND to the requested symbol via
 * `eventAffectsSymbol` — empty symbol ("") returns all events in window.
 */
export async function getCalendarSnapshot(
  symbol: string,
  nowMs: number = Date.now(),
  windowMs = 72 * 60 * 60 * 1000, // 72-hour look-ahead
): Promise<EconomicCalendarSnapshot> {
  const { configured, apiKey } = getTradingEconomicsConfig();
  if (!configured || !apiKey) {
    return {
      connected: false,
      provider: "trading_economics",
      status: "missing",
      events: [],
      providerState: "not_configured",
    };
  }

  try {
    const raw = await getCachedTeEvents(apiKey, 7);
    const events: RawCalendarEvent[] = [];
    for (const e of raw) {
      const mapped = teEventToRaw(e);
      if (!mapped) continue;
      if (!isInFetchWindow(mapped.eventTimeIso, nowMs, windowMs)) continue;
      // Symbol scoping: skip events that don't affect the requested symbol.
      // An empty/wildcard symbol ("") returns all events in the window.
      if (symbol.length > 0 && !eventAffectsSymbol(symbol, mapped.currency, mapped.affectedMarkets)) continue;
      events.push(mapped);
    }
    return {
      connected: true,
      provider: "trading_economics",
      status: events.length > 0 ? "ok" : "empty",
      events,
      providerState: computeProviderState(true, true),
    };
  } catch {
    return {
      connected: false,
      provider: "trading_economics",
      status: "error",
      events: [],
      providerState: computeProviderState(true, false),
    };
  }
}

/**
 * Enriched version of `getCalendarSnapshot` for the live calendar endpoint.
 * Returns `CalendarEventFull[]` with all enriched fields.
 * Symbol scoping: same `eventAffectsSymbol` filter as `getCalendarSnapshot`.
 * Empty symbol → return all events in window (useful for the calendar page).
 * Optional `filters` can further scope by date range, currency, impact, or symbols.
 */
export async function getCalendarEventsEnriched(
  symbol: string,
  nowMs: number = Date.now(),
  windowMs = 72 * 60 * 60 * 1000,
  filters: CalendarEventFilters = {},
): Promise<{ connected: boolean; provider: string; events: CalendarEventFull[] }> {
  const { configured, apiKey } = getTradingEconomicsConfig();
  if (!configured || !apiKey) {
    return { connected: false, provider: "trading_economics", events: [] };
  }

  const fromMs = filters.from ? new Date(filters.from).getTime() : nowMs;
  const toMs   = filters.to   ? new Date(filters.to).getTime()   : nowMs + windowMs;
  const minImpactRank = filters.impact ? (IMPACT_RANK[filters.impact] ?? 1) : 0;

  try {
    const raw = await getCachedTeEvents(apiKey, 7);
    const events: CalendarEventFull[] = [];
    for (const e of raw) {
      const full = teToFull(e);
      if (!full) continue;

      // Date-range filter (from/to override the legacy windowMs when provided)
      const evMs = new Date(full.eventTimeIso).getTime();
      if (filters.from || filters.to) {
        if (evMs < fromMs || evMs > toMs) continue;
      } else {
        if (!isInFetchWindow(full.eventTimeIso, nowMs, windowMs)) continue;
      }

      // Symbol scope (primary `symbol` param)
      if (symbol.length > 0 && !eventAffectsSymbol(symbol, full.currency, full.affectedMarkets)) continue;

      // Additional symbols filter
      if (filters.symbols && filters.symbols.length > 0) {
        const matchesAny = filters.symbols.some((s) =>
          eventAffectsSymbol(s, full.currency, full.affectedMarkets),
        );
        if (!matchesAny) continue;
      }

      // Currency filter
      if (filters.currencies && filters.currencies.length > 0) {
        if (!filters.currencies.includes(full.currency)) continue;
      }

      // Impact filter
      if (minImpactRank > 0) {
        if ((IMPACT_RANK[full.impact] ?? 0) < minImpactRank) continue;
      }

      events.push(full);
    }
    return { connected: true, provider: "trading_economics", events };
  } catch {
    return { connected: false, provider: "trading_economics", events: [] };
  }
}
