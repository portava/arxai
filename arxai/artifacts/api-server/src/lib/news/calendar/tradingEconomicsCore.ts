// Pure, logger-free core functions for the Trading Economics adapter.
// No side-effects, no network, no logger — safe to import in test context.

export type TeLowMediumHigh = "low" | "medium" | "high";

/** Map TE Importance (1|2|3) to ARX impact level. */
export function teImportanceToImpact(n: number | undefined): TeLowMediumHigh {
  if (n === 3) return "high";
  if (n === 2) return "medium";
  return "low";
}

/** Map ARX impact level to DB impactLevel enum. */
export function impactToLevel(i: TeLowMediumHigh): "LOW" | "MEDIUM" | "HIGH" | "CRITICAL" {
  if (i === "high")   return "HIGH";
  if (i === "medium") return "MEDIUM";
  return "LOW";
}

/**
 * Derive affected index/market symbols from a currency code.
 *
 * The domain `eventAffectsSymbol` checks if the event currency appears in
 * the symbol string (e.g. "USD" in "EURUSD"). For indices that DON'T contain
 * the currency code in their symbol name (e.g. "US30"), we include them in
 * `affectedMarkets` so the radar can match them.
 */
export function currencyToIndexMarkets(currency: string): string[] {
  const c = currency.trim().toUpperCase();
  switch (c) {
    case "USD": return ["US30", "SPX500", "NAS100", "DXY", "XAUUSD", "XAGUSD"];
    case "EUR": return ["GER40", "EUSTX50"];
    case "GBP": return ["UK100"];
    case "JPY": return ["JP225"];
    case "AUD": return ["AUS200"];
    case "CAD": return [];
    case "CHF": return [];
    case "NZD": return [];
    default:    return [];
  }
}

/**
 * Normalize a TE date string to a valid ISO-8601 string with a UTC marker.
 * TE sends dates as "YYYY-MM-DDTHH:MM:SS" without a timezone suffix.
 * We append "Z" to treat them as UTC (TE publishes in UTC by default).
 * Returns null when the date is invalid.
 */
export function normalizeTeDate(raw: string | undefined): string | null {
  if (!raw) return null;
  // Already has timezone marker — leave as-is.
  if (/[Zz]$/.test(raw) || /[+-]\d{2}:\d{2}$/.test(raw)) {
    const t = new Date(raw).getTime();
    return Number.isNaN(t) ? null : raw;
  }
  // Replace space separator (some TE formats) then append Z.
  const withZ = raw.replace(" ", "T").replace(/(\d{2}:\d{2}:\d{2})$/, "$1Z");
  const t = new Date(withZ).getTime();
  return Number.isNaN(t) ? null : withZ;
}

/**
 * Map a raw TE API event object to the `RawCalendarEvent` shape used by
 * the radar + Ruby.  Returns null when mandatory fields are absent/invalid.
 */
export interface MinimalTeEvent {
  CalendarId?: string;
  Date?: string;
  Category?: string;
  Event?: string;
  Country?: string;
  Currency?: string;
  Importance?: number;
  Ticker?: string;
  Actual?: string | null;
  Previous?: string | null;
  Forecast?: string | null;
  TEForecast?: string | null;
}

export interface MappedRawEvent {
  id: string;
  title: string;
  currency: string;
  impact: TeLowMediumHigh;
  eventTimeIso: string;
  affectedMarkets: string[];
}

export function teEventToRaw(e: MinimalTeEvent): MappedRawEvent | null {
  const id = e.CalendarId ?? e.Ticker ?? [e.Country, e.Category, e.Date].join("_");
  const title = e.Event ?? e.Category ?? "Unknown Event";
  const currency = (e.Currency ?? "").trim().toUpperCase();
  const impact = teImportanceToImpact(e.Importance);
  const eventTimeIso = normalizeTeDate(e.Date);
  if (!eventTimeIso) return null;
  return { id: String(id), title, currency, impact, eventTimeIso, affectedMarkets: currencyToIndexMarkets(currency) };
}

/**
 * Classify calendar provider state into an explicit discriminant.
 * Pure function — no network, no logger — safe to import in any test context.
 *
 * States:
 *   "not_configured" — no key is set; user action required to enable the provider.
 *   "fetch_error"    — key is present but the last fetch attempt failed (network /
 *                      non-2xx / parse error). Prior cached events (if any) are stale.
 *   "connected"      — fetch succeeded; events are real and fresh.
 */
export type CalendarProviderStateValue = "not_configured" | "fetch_error" | "connected";

export function computeProviderState(
  isEnabled: boolean,
  fetchSucceeded: boolean,
): CalendarProviderStateValue {
  if (!isEnabled) return "not_configured";
  return fetchSucceeded ? "connected" : "fetch_error";
}

/**
 * Canonical human-readable note per provider state. Centralized so every
 * surface (radar, news intelligence, sync response, frontend) renders the SAME
 * honest copy and the three states never collapse into one another.
 * Pure — no network, no logger.
 */
export function providerStateNote(state: CalendarProviderStateValue): string {
  switch (state) {
    case "connected":
      return "Live economic-calendar provider connected — scheduled events are real.";
    case "fetch_error":
      return "Economic-calendar provider is configured but the last fetch failed — events are temporarily unavailable until the next successful refresh.";
    case "not_configured":
      return "No live economic-calendar provider is configured — no scheduled events are shown (the absence of an event is not an all-clear).";
  }
}

// ── Strict date-range validation for the live calendar endpoint ──────────────
//
// Accepts ONLY a calendar date (YYYY-MM-DD) or an ISO-8601 datetime. Malformed
// strings are rejected outright (never silently coerced) so the route can return
// 400 BEFORE ever calling the provider.

const ISO_DATE_ONLY = /^\d{4}-\d{2}-\d{2}$/;
const ISO_DATETIME = /^\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}(:\d{2})?(\.\d+)?(Z|[+-]\d{2}:\d{2})?$/;

/**
 * True only when `raw` is a strictly-formatted, real calendar date or ISO
 * datetime. Guards against JS rollover quirks (e.g. "2025-02-30" → Mar 2) for
 * the date-only form by round-tripping the UTC components.
 */
export function isValidIsoDateParam(raw: string): boolean {
  const dateOnly = ISO_DATE_ONLY.test(raw);
  const dateTime = ISO_DATETIME.test(raw);
  if (!dateOnly && !dateTime) return false;
  const t = new Date(raw).getTime();
  if (Number.isNaN(t)) return false;
  if (dateOnly) {
    // Date-only ISO parses as UTC midnight; reject any rollover (Feb 30 etc.).
    const [y, m, d] = raw.split("-").map(Number);
    const dt = new Date(t);
    if (dt.getUTCFullYear() !== y || dt.getUTCMonth() + 1 !== m || dt.getUTCDate() !== d) {
      return false;
    }
  }
  return true;
}

export type DateRangeValidation =
  | { ok: true; fromMs: number | null; toMs: number | null }
  | { ok: false; error: string };

/**
 * Validate the optional `from`/`to` query params for the live calendar endpoint.
 * Returns an explicit error (for a 400) instead of silently coercing or ignoring
 * a malformed value.
 */
export function validateCalendarDateRange(
  from: string | undefined,
  to: string | undefined,
): DateRangeValidation {
  let fromMs: number | null = null;
  let toMs: number | null = null;
  if (from !== undefined && from !== "") {
    if (!isValidIsoDateParam(from)) {
      return { ok: false, error: "Invalid 'from' date — expected an ISO date (YYYY-MM-DD) or ISO datetime." };
    }
    fromMs = new Date(from).getTime();
  }
  if (to !== undefined && to !== "") {
    if (!isValidIsoDateParam(to)) {
      return { ok: false, error: "Invalid 'to' date — expected an ISO date (YYYY-MM-DD) or ISO datetime." };
    }
    toMs = new Date(to).getTime();
  }
  if (fromMs !== null && toMs !== null && fromMs > toMs) {
    return { ok: false, error: "'from' date must not be after 'to' date." };
  }
  return { ok: true, fromMs, toMs };
}

// ── Economic-events sync orchestration ──────────────────────────────────────
//
// Pure orchestrator: side-effects (provider fetch + DB upsert) are injected via
// `syncFromProvider` and only invoked when a provider is actually configured.
// This guarantees — and lets a test prove — that no external fetch is attempted
// when the provider is not configured.

export interface EconomicEventsSyncResult {
  provider: string;
  providerState: CalendarProviderStateValue;
  configured: boolean;
  connected: boolean;
  eventsSynced: number;
  /** Back-compat alias for `eventsSynced` (legacy clients read `upserted`). */
  upserted: number;
  daysAhead: number;
  message: string;
}

export async function runEconomicEventsSync(opts: {
  enabled: boolean;
  daysAhead: number;
  syncFromProvider: () => Promise<{ provider: string; upserted: number }>;
  onError?: (err: unknown) => void;
}): Promise<{ status: number; body: EconomicEventsSyncResult }> {
  if (!opts.enabled) {
    return {
      status: 200,
      body: {
        provider: "none",
        providerState: "not_configured",
        configured: false,
        connected: false,
        eventsSynced: 0,
        upserted: 0,
        daysAhead: opts.daysAhead,
        message: "Economic calendar provider is not configured",
      },
    };
  }
  try {
    const { provider, upserted } = await opts.syncFromProvider();
    return {
      status: 200,
      body: {
        provider,
        providerState: "connected",
        configured: true,
        connected: true,
        eventsSynced: upserted,
        upserted,
        daysAhead: opts.daysAhead,
        message: `Synced ${upserted} event${upserted === 1 ? "" : "s"} from ${provider}.`,
      },
    };
  } catch (err) {
    opts.onError?.(err);
    return {
      status: 500,
      body: {
        provider: "trading_economics",
        providerState: "fetch_error",
        configured: true,
        connected: false,
        eventsSynced: 0,
        upserted: 0,
        daysAhead: opts.daysAhead,
        message: "Economic calendar provider is configured but the sync fetch failed.",
      },
    };
  }
}

/** Is an event within the fetch window? (not >2h in the past, not beyond cutoff) */
export function isInFetchWindow(eventTimeIso: string, nowMs: number, windowMs: number): boolean {
  const t = new Date(eventTimeIso).getTime();
  if (Number.isNaN(t)) return false;
  return t >= nowMs - 2 * 3600 * 1000 && t <= nowMs + windowMs;
}

/**
 * Pure, logger-free liveness freshness computation.
 *
 * Rules (in priority order):
 *   1. Never fetched → "unavailable"
 *   2. Last operation was an error (errorAt > lastFetchAt) → "unavailable"
 *      (error-after-success must not allow a prior fetch's age to override)
 *   3. Last success is within FRESH_TTL_MS → "fresh"
 *   4. Otherwise → "stale"
 */
export function computeFreshnessStatus(
  state: { lastFetchAt: string | null; lastErrorAt: string | null },
  freshTtlMs: number,
  nowMs: number = Date.now(),
): "fresh" | "stale" | "unavailable" {
  if (state.lastFetchAt == null) return "unavailable";
  if (
    state.lastErrorAt != null &&
    new Date(state.lastErrorAt).getTime() > new Date(state.lastFetchAt).getTime()
  ) {
    return "unavailable";
  }
  const ageMs = nowMs - new Date(state.lastFetchAt).getTime();
  return ageMs < freshTtlMs ? "fresh" : "stale";
}
