// FRED (Federal Reserve Economic Data, St. Louis Fed) economic-calendar provider.
//
// HONESTY (inviolable): this provider only ever returns release dates FRED
// actually published. It never fabricates an event, a forecast, or an `actual`.
// FRED's `releases/dates` feed is DATE-GRANULARITY ONLY — it carries no intraday
// clock time and no forecast/actual/previous values — so those fields are emitted
// as null and the event time is a midnight-UTC date sentinel (never a guessed
// clock time, matching the `eventTimeLocal: null` "never guessed" contract). Only
// recognized macro releases (a curated, factual classifier) are surfaced with a
// currency/country/impact; obscure data series we cannot map to a real macro
// meaning are DROPPED (conservative curation — the opposite of fabrication).
// Missing key ⇒ not configured; a fetch failure surfaces as an error (the caller
// maps it to an honest "provider error", never a silent empty). The raw→normalized
// mapping is pure and the HTTP fetch is injectable so the whole pipeline is
// testable offline.
//
// Read/risk-context only — imports nothing from the execution path, MT5 bridge,
// broker dispatch, or any safety gate.

import type { CalendarEvent, EconomicCalendarImpact } from "./calendarTypes.js";
import type { CalendarHttpFetcher } from "./tradingEconomicsProvider.js";
import { affectedSymbolsFor, riskNoteFor } from "./calendarSymbolMap.js";

export const FRED_PROVIDER = "fred";

export interface FredConfig {
  /** API key; presence only is ever logged/exposed. */
  key: string;
}

/**
 * Resolve the configured provider + key from env WITHOUT exposing the value.
 * `ECONOMIC_CALENDAR_PROVIDER` must be explicitly set to "fred" AND a
 * `FRED_API_KEY` must be present.
 */
export function resolveFredConfig(env: NodeJS.ProcessEnv = process.env): FredConfig | null {
  const provider = (env["ECONOMIC_CALENDAR_PROVIDER"] ?? "").trim().toLowerCase();
  const key = (env["FRED_API_KEY"] ?? "").trim();
  if (provider !== FRED_PROVIDER) return null;
  if (!key) return null;
  return { key };
}

/** True when FRED is the selected provider and a key is present. */
export function isFredConfigured(env: NodeJS.ProcessEnv = process.env): boolean {
  return resolveFredConfig(env) !== null;
}

/**
 * True when "fred" is the SELECTED provider, regardless of whether a key is
 * present. Used to decide honesty vs back-compat: when FRED is selected but the
 * key is missing, surfaces must serve honest-empty (never the mock generator).
 */
export function isFredSelected(env: NodeJS.ProcessEnv = process.env): boolean {
  return (env["ECONOMIC_CALENDAR_PROVIDER"] ?? "").trim().toLowerCase() === FRED_PROVIDER;
}

function ymd(d: Date): string {
  return d.toISOString().slice(0, 10);
}

/**
 * Build the FRED release-dates URL. `include_release_dates_with_no_data=true`
 * is required to return UPCOMING scheduled dates (releases that have no data
 * published yet); without it FRED only returns historical release dates.
 */
export function buildFredCalendarUrl(
  cfg: FredConfig,
  opts: { daysAhead: number; nowMs: number },
): string {
  const params = new URLSearchParams({
    api_key: cfg.key,
    file_type: "json",
    realtime_start: ymd(new Date(opts.nowMs)),
    include_release_dates_with_no_data: "true",
    sort_order: "asc",
    order_by: "release_date",
    limit: "1000",
  });
  return `https://api.stlouisfed.org/fred/releases/dates?${params.toString()}`;
}

/** Raw FRED release-date row (only the fields we consume). */
export interface RawFredReleaseDate {
  release_id?: number | string;
  release_name?: string;
  date?: string;
}

interface FredClassification {
  currency: string;
  country: string;
  impact: EconomicCalendarImpact;
}

// Curated FRED `release_name` → FACTUAL {currency, country, impact}. Only releases
// we can classify to a real macro meaning are surfaced; everything else is
// dropped (honest curation, never fabrication). The metadata is factual — e.g.
// the FOMC statement is a US/USD critical event — not invented data. FRED carries
// no numeric importance, so impact is assigned from this real-world classifier.
const FRED_RELEASE_CLASSIFIER: ReadonlyArray<{ re: RegExp } & FredClassification> = [
  // ── United States (USD) ──
  { re: /(federal open market committee|fomc)/i, currency: "USD", country: "United States", impact: "critical" },
  { re: /employment situation/i, currency: "USD", country: "United States", impact: "high" },
  { re: /consumer price index/i, currency: "USD", country: "United States", impact: "high" },
  { re: /producer price index/i, currency: "USD", country: "United States", impact: "high" },
  { re: /gross domestic product/i, currency: "USD", country: "United States", impact: "high" },
  { re: /personal income (and|&) outlays|personal consumption expenditures/i, currency: "USD", country: "United States", impact: "high" },
  { re: /retail (and food services )?(sales|trade)|advance monthly sales for retail/i, currency: "USD", country: "United States", impact: "high" },
  { re: /unemployment insurance weekly claims/i, currency: "USD", country: "United States", impact: "medium" },
  { re: /job openings and labor turnover/i, currency: "USD", country: "United States", impact: "medium" },
  { re: /durable goods/i, currency: "USD", country: "United States", impact: "medium" },
  { re: /industrial production/i, currency: "USD", country: "United States", impact: "medium" },
  { re: /new residential construction|housing starts/i, currency: "USD", country: "United States", impact: "medium" },
  { re: /new residential sales|new home sales/i, currency: "USD", country: "United States", impact: "medium" },
  { re: /consumer sentiment/i, currency: "USD", country: "United States", impact: "medium" },
  // ── Euro Area (EUR) ──
  { re: /euro short[- ]term rate|€str|\bestr\b/i, currency: "EUR", country: "Euro Area", impact: "low" },
];

function classify(releaseName: string): FredClassification | null {
  for (const c of FRED_RELEASE_CLASSIFIER) {
    if (c.re.test(releaseName)) return { currency: c.currency, country: c.country, impact: c.impact };
  }
  return null;
}

function str(v: string | number | null | undefined): string | null {
  if (v === null || v === undefined) return null;
  const s = String(v).trim();
  return s.length > 0 ? s : null;
}

const YMD_RE = /^\d{4}-\d{2}-\d{2}$/;

/**
 * Pure raw→normalized mapping. Drops rows without a usable date/name, rows
 * outside the [now, now+daysAhead] calendar-date window, and any release we
 * cannot classify to a real macro meaning. Window filtering is by calendar-date
 * STRING (inclusive) so a release dated "today" is always included regardless of
 * the intraday clock.
 */
export function normalizeFredReleaseDates(
  raw: RawFredReleaseDate[],
  opts: { nowMs: number; daysAhead: number; freshness: CalendarEvent["freshness"] },
): CalendarEvent[] {
  const lastUpdatedAt = new Date(opts.nowMs).toISOString();
  const startYmd = ymd(new Date(opts.nowMs));
  const endYmd = ymd(new Date(opts.nowMs + Math.max(1, opts.daysAhead) * 86_400_000));
  const out: CalendarEvent[] = [];
  for (const r of raw) {
    const date = str(r.date);
    const name = str(r.release_name);
    if (!date || !name || !YMD_RE.test(date)) continue;
    if (date < startYmd || date > endYmd) continue;
    const cls = classify(name);
    if (!cls) continue; // unrecognized data series → dropped (honest curation).
    const releaseId = str(r.release_id);
    const eventTimeUtc = `${date}T00:00:00.000Z`; // date-granularity sentinel.
    const id = `fred_${releaseId ?? name.replace(/\s+/g, "_")}_${date}`;
    out.push({
      id,
      provider: FRED_PROVIDER,
      source: "FRED",
      country: cls.country,
      currency: cls.currency,
      category: name,
      title: name,
      impact: cls.impact,
      eventTimeUtc,
      eventTimeLocal: null,
      actual: null,
      forecast: null,
      previous: null,
      revised: null,
      unit: null,
      importance: null,
      lastUpdatedAt,
      freshness: opts.freshness,
      affectedSymbols: affectedSymbolsFor(cls.currency, cls.country),
      riskNote: riskNoteFor(cls.impact, cls.currency),
    });
  }
  out.sort((a, b) => Date.parse(a.eventTimeUtc) - Date.parse(b.eventTimeUtc));
  return out;
}

/**
 * Fetch + normalize the FRED release calendar. Throws on network/parse/HTTP
 * error so the service can map it to an honest "provider error" (never a silent
 * empty).
 */
export async function fetchFredCalendar(
  cfg: FredConfig,
  opts: { daysAhead: number; nowMs: number; fetcher: CalendarHttpFetcher },
): Promise<CalendarEvent[]> {
  const url = buildFredCalendarUrl(cfg, opts);
  const res = await opts.fetcher(url);
  if (!res.ok) {
    throw new Error(`FRED HTTP ${res.status}`);
  }
  const body = await res.text();
  let parsed: unknown;
  try {
    parsed = JSON.parse(body);
  } catch {
    throw new Error("FRED returned non-JSON body");
  }
  const rows =
    parsed !== null && typeof parsed === "object"
      ? (parsed as { release_dates?: unknown }).release_dates
      : undefined;
  if (!Array.isArray(rows)) {
    // FRED returns an error object (e.g. invalid key / quota) instead of an array.
    throw new Error("FRED returned an unexpected payload (no release_dates array)");
  }
  return normalizeFredReleaseDates(rows as RawFredReleaseDate[], {
    nowMs: opts.nowMs,
    daysAhead: opts.daysAhead,
    freshness: "LIVE",
  });
}

/** Redact any occurrence of the key from an error message. */
export function redactFredError(err: unknown, cfg: FredConfig | null): string {
  let msg = err instanceof Error ? err.message : String(err);
  if (cfg?.key) {
    msg = msg.split(cfg.key).join("***");
  }
  return msg.slice(0, 280);
}
