import { readFileSync, writeFileSync, renameSync } from "node:fs";
// Public weekly schedule, linked from https://www.forexfactory.com/calendar/.
// No credentials, no scraped actuals, no invented release values. Explicitly
// limited to the current source week; failures never become an empty success.
import { createHash } from "node:crypto";
import type { CalendarEvent } from "./calendarTypes.js";
import type { CalendarHttpFetcher } from "./tradingEconomicsProvider.js";
import { affectedSymbolsFor, riskNoteFor } from "./calendarSymbolMap.js";

export const FOREX_FACTORY_PROVIDER = "forex_factory";
export const FOREX_FACTORY_URL = "https://nfs.faireconomy.media/ff_calendar_thisweek.json";
export const FOREX_FACTORY_COVERAGE = "Current-week schedule from Forex Factory. Future weeks, released actuals and revisions are not supplied; a missing event is not an all-clear outside this coverage.";
export function isForexFactorySelected(env: NodeJS.ProcessEnv = process.env): boolean {
  const selected = (env.ECONOMIC_CALENDAR_PROVIDER ?? "").trim().toLowerCase();
  return selected === "" || selected === FOREX_FACTORY_PROVIDER;
}
const countries: Record<string, string> = { USD: "United States", GBP: "United Kingdom", EUR: "Euro Area", JPY: "Japan", CHF: "Switzerland", CAD: "Canada", AUD: "Australia", NZD: "New Zealand", CNY: "China" };
const text = (v: unknown): string | null => typeof v === "string" && v.trim() ? v.trim() : null;
function weekStart(date: string): string {
  const d = new Date(date + "T12:00:00Z");
  d.setUTCDate(d.getUTCDate() - d.getUTCDay());
  return d.toISOString().slice(0, 10);
}
export function normalizeForexFactoryCalendar(payload: unknown, nowMs: number, daysAhead = 7): CalendarEvent[] {
  if (!Array.isArray(payload) || payload.length === 0) throw new Error("Calendar export is empty or invalid; coverage unconfirmed.");
  const localToday = new Intl.DateTimeFormat("en-CA", { timeZone: "America/New_York", year: "numeric", month: "2-digit", day: "2-digit" }).format(nowMs);
  const week = weekStart(localToday);
  const seen = new Set<string>();
  const events: CalendarEvent[] = [];
  for (const row of payload) {
    if (!row || typeof row !== "object") throw new Error("Invalid calendar row.");
    const r = row as Record<string, unknown>;
    const title = text(r.title), currency = text(r.country), date = text(r.date), rawImpact = text(r.impact);
    if (!title || !currency || !date || !rawImpact || !/T.*(?:Z|[+-]\d{2}:\d{2})$/.test(date) || !Number.isFinite(Date.parse(date))) throw new Error("Incomplete calendar row or unconfirmed release time.");
    if (weekStart(date.slice(0,10)) !== week) throw new Error("Calendar export does not cover the current week.");
    if (!["High", "Medium", "Low", "Holiday"].includes(rawImpact)) throw new Error("Unknown calendar impact.");
    // Holiday/all-day records are not timed economic releases.
    if (rawImpact === "Holiday" || date.slice(0, 10) < localToday) continue;
    const at = Date.parse(date);
    if (at > nowMs + Math.max(1,daysAhead)*86400000) continue;
    const impact = rawImpact === "High" ? "high" : rawImpact === "Medium" ? "medium" : "low";
    const country = countries[currency] ?? currency;
    const eventTimeUtc = new Date(at).toISOString();
    const id = "ff:" + createHash("sha256").update(currency + "|" + title + "|" + eventTimeUtc).digest("hex").slice(0,24);
    if (seen.has(id)) continue;
    seen.add(id);
    events.push({ id, provider: FOREX_FACTORY_PROVIDER, source: "Forex Factory weekly schedule", country, currency,
      category: null, title, impact, eventTimeUtc, eventTimeLocal: null,
      actual: null, forecast: text(r.forecast), previous: text(r.previous), revised: null,
      unit: null, importance: rawImpact === "High" ? 3 : rawImpact === "Medium" ? 2 : 1,
      lastUpdatedAt: new Date(nowMs).toISOString(), freshness: "LIVE",
      affectedSymbols: affectedSymbolsFor(currency, country), riskNote: riskNoteFor(impact, currency),
    });
  }
  return events.sort((a,b) => a.eventTimeUtc.localeCompare(b.eventTimeUtc));
}
// The source is a weekly schedule, not a tick feed. Refresh at most once per
// ten minutes; honor a failed refresh with backoff. A previously fetched current-
// week schedule is usable for at most one hour, always with its ORIGINAL time.
export const FOREX_FACTORY_CACHE_PATH = "/tmp/arx-forex-factory-weekly-cache.json";
const REFRESH_MS = 10 * 60_000;
const MAX_CACHE_MS = 60 * 60_000;
type Cached = { source: string; at: number; payload: unknown };
let cached: Cached | null = null;
let inflight: Promise<CalendarEvent[]> | null = null;
let retryAt = 0;
let lastError: string | null = null;
export function __resetForexFactoryForTests(): void { cached=null;inflight=null;retryAt=0;lastError=null; }
export function forexFactoryRefreshNote(): string | null { return lastError; }
export function forexFactoryObservedAt(): number | null { return cached?.at ?? null; }

export async function fetchForexFactoryCalendar(opts: { daysAhead: number; nowMs: number; fetcher: CalendarHttpFetcher; persistCache?: boolean }): Promise<CalendarEvent[]> {
  const usable = (candidate: Cached | null): candidate is Cached => {
    if (!candidate || candidate.source !== FOREX_FACTORY_URL || !Number.isFinite(candidate.at) || candidate.at > opts.nowMs || opts.nowMs-candidate.at > MAX_CACHE_MS) return false;
    try { normalizeForexFactoryCalendar(candidate.payload, opts.nowMs, opts.daysAhead); return true; } catch { return false; }
  };
  if (!cached && opts.persistCache) {
    try { const disk=JSON.parse(readFileSync(FOREX_FACTORY_CACHE_PATH,"utf8")); if(usable(disk)) cached=disk; } catch { /* no usable previous observation */ }
  }
  const fromCache = (): CalendarEvent[] => normalizeForexFactoryCalendar(cached!.payload, opts.nowMs, opts.daysAhead).map(e=>({
    ...e,lastUpdatedAt:new Date(cached!.at).toISOString(),freshness:opts.nowMs-cached!.at<=2*60000?"LIVE":"DELAYED",
  }));
  if (usable(cached) && opts.nowMs-cached.at < REFRESH_MS) return fromCache();
  if (opts.nowMs < retryAt) {
    if(usable(cached)) return fromCache();
    throw new Error(lastError ?? "Calendar source retry is delayed after a failed request.");
  }
  if (!inflight) inflight=(async()=>{
    try {
      const response=await opts.fetcher(FOREX_FACTORY_URL);
      if(!response.ok) {
        retryAt=opts.nowMs+Math.max(response.retryAfterMs??0,response.status===429?10*60000:60000);
        throw new Error(`Forex Factory calendar HTTP ${response.status}; retry backed off.`);
      }
      const payload:unknown=JSON.parse(await response.text());
      normalizeForexFactoryCalendar(payload,opts.nowMs,opts.daysAhead);
      cached={source:FOREX_FACTORY_URL,at:opts.nowMs,payload};lastError=null;retryAt=0;
      if(opts.persistCache) {
        try { const tmp=FOREX_FACTORY_CACHE_PATH+"."+process.pid;writeFileSync(tmp,JSON.stringify(cached),{mode:0o600});renameSync(tmp,FOREX_FACTORY_CACHE_PATH); } catch { /* cache I/O cannot create data or break a real fetch */ }
      }
      return fromCache();
    } catch(err) {
      lastError=err instanceof Error?err.message.slice(0,280):"Calendar refresh failed.";
      if(retryAt<=opts.nowMs) retryAt=opts.nowMs+60000;
      if(usable(cached)) return fromCache();
      throw err;
    }
  })().finally(()=>{inflight=null;});
  await inflight;
  // Each caller keeps its own requested horizon after sharing the one fetch.
  return fromCache();
}
