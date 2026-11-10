// News/calendar A+ bar: every shown event has a source, a fetch time and a
// freshness state; stale data is labelled; times are UTC-correct across DST;
// impact is a category with a stated basis, never a forecast number. Offline.
//
//   pnpm --filter @workspace/api-server run test:news-calendar-provenance
//
// The host time zone is forced to one far from both UTC and US Eastern so any
// accidental local-time arithmetic would shift results and fail.
process.env["TZ"] = "Asia/Tokyo";

import { test, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import {
  zonedWallTimeToUtcIso,
  zoneOffsetMs,
  scheduledFredReleaseTime,
  US_EASTERN,
  DATE_ONLY_SENTINEL_SUFFIX,
  isDateOnlyCalendarTime as isDateOnlyEventSource,
} from "../releaseSchedule.js";
import { normalizeFredReleaseDates } from "../fredCalendarProvider.js";
import { normalizeTradingEconomicsEvents } from "../tradingEconomicsProvider.js";
import {
  getEconomicCalendarResult,
  __setEconomicCalendarFetcherForTests,
  __resetEconomicCalendarStateForTests,
} from "../economicCalendarService.js";
import { toMockShapeEvents, toProviderEvents } from "../calendarAdapters.js";
import { getEnrichedCalendarEvents, calendarEventProvenance } from "../../economicCalendarProvider.js";
import { pickNewsProvider } from "../newsProvider.js";
import { scoreNewsRisk } from "../newsRiskScorer.js";
import {
  storedEventFreshness,
  STORED_EVENT_DELAYED_MAX_AGE_MS,
  STORED_EVENT_LIVE_MAX_AGE_MS,
} from "../storedEventProvenance.js";

const src = (rel: string) => readFileSync(new URL(rel, import.meta.url), "utf8");
const ENV = ["ECONOMIC_CALENDAR_PROVIDER", "FRED_API_KEY", "TRADING_ECONOMICS_KEY", "TRADING_ECONOMICS_SECRET"] as const;
let snap: Record<string, string | undefined> = {};
beforeEach(() => {
  snap = Object.fromEntries(ENV.map((k) => [k, process.env[k]]));
  __resetEconomicCalendarStateForTests();
});
afterEach(() => {
  for (const k of ENV) { if (snap[k] === undefined) delete process.env[k]; else process.env[k] = snap[k]; }
  __setEconomicCalendarFetcherForTests(null);
  __resetEconomicCalendarStateForTests();
});
function useFred(rows: Array<{ release_id: string; release_name: string; date: string }>, ok = true) {
  process.env["ECONOMIC_CALENDAR_PROVIDER"] = "fred";
  process.env["FRED_API_KEY"] = "k";
  delete process.env["TRADING_ECONOMICS_KEY"];
  delete process.env["TRADING_ECONOMICS_SECRET"];
  __setEconomicCalendarFetcherForTests(async () => ({ ok, status: ok ? 200 : 503, text: async () => JSON.stringify({ release_dates: rows }) }));
}
const ymd = (ms: number) => new Date(ms).toISOString().slice(0, 10);

// ── DST: US Eastern release times → UTC ─────────────────────────────────────
// 2026: DST starts Sun 8 Mar, ends Sun 1 Nov.
const DST_CASES: Array<[string, string, string, string]> = [
  ["CPI before spring-forward (EST)", "2026-03-06", "08:30", "2026-03-06T13:30:00.000Z"],
  ["CPI after spring-forward (EDT)", "2026-03-09", "08:30", "2026-03-09T12:30:00.000Z"],
  ["NFP before fall-back (EDT)", "2026-10-30", "08:30", "2026-10-30T12:30:00.000Z"],
  ["NFP after fall-back (EST)", "2026-11-06", "08:30", "2026-11-06T13:30:00.000Z"],
  ["FOMC summer (EDT)", "2026-06-17", "14:00", "2026-06-17T18:00:00.000Z"],
  ["FOMC winter (EST)", "2026-12-09", "14:00", "2026-12-09T19:00:00.000Z"],
  ["Industrial production 09:15 (EDT)", "2026-07-16", "09:15", "2026-07-16T13:15:00.000Z"],
  ["Day of spring-forward, after 03:00", "2026-03-08", "08:30", "2026-03-08T12:30:00.000Z"],
  ["Day of fall-back, after 02:00", "2026-11-01", "08:30", "2026-11-01T13:30:00.000Z"],
];
for (const [name, d, t, want] of DST_CASES) {
  test(`DST: ${name} → ${want}`, () => {
    assert.equal(zonedWallTimeToUtcIso(d, t, US_EASTERN), want);
  });
}

test("DST: offsets are -5h in winter and -4h in summer regardless of host TZ", () => {
  assert.equal(zoneOffsetMs(Date.parse("2026-01-15T12:00:00Z"), US_EASTERN), -5 * 3600_000);
  assert.equal(zoneOffsetMs(Date.parse("2026-07-15T12:00:00Z"), US_EASTERN), -4 * 3600_000);
  assert.equal(new Date().getTimezoneOffset(), -540, "test really runs with a non-UTC host zone");
});

test("FRED: classified releases get the published ET time in UTC; unknown times stay date-only", () => {
  const now = Date.parse("2026-03-05T00:00:00Z");
  const ev = normalizeFredReleaseDates([
    { release_id: "10", release_name: "Consumer Price Index", date: "2026-03-06" },
    { release_id: "10", release_name: "Consumer Price Index", date: "2026-03-10" },
    { release_id: "99", release_name: "Euro Short-Term Rate", date: "2026-03-06" },
  ], { nowMs: now, daysAhead: 7, freshness: "LIVE" });
  const cpi = ev.filter((e) => e.title === "Consumer Price Index").map((e) => e.eventTimeUtc);
  assert.deepEqual(cpi, ["2026-03-06T13:30:00.000Z", "2026-03-10T12:30:00.000Z"]);
  const estr = ev.find((e) => /Euro/.test(e.title))!;
  assert.equal(estr.timePrecision, "date");
  assert.equal(estr.timeSource, "date_only");
  assert.ok(estr.eventTimeUtc.endsWith(DATE_ONLY_SENTINEL_SUFFIX));
  assert.equal(scheduledFredReleaseTime("Something Unlisted", "2026-03-06").timePrecision, "date");
});

test("FRED: a timed release counts as timed downstream; only the midnight sentinel is date-only", () => {
  // selectedMarket.isDateOnlyEventSource delegates to this helper (checked below).
  assert.match(src("../../../scannerSelected/selectedMarket.ts"), /return isDateOnlyCalendarTime\(source, eventTime\);/);
  assert.equal(isDateOnlyEventSource("FRED", "2026-03-10T12:30:00.000Z"), false);
  assert.equal(isDateOnlyEventSource("FRED", "2026-03-10T00:00:00.000Z"), true);
  assert.equal(isDateOnlyEventSource("trading_economics", "2026-03-10T00:00:00.000Z"), false);
});

test("TE: zone-less provider timestamps are UTC regardless of host TZ", () => {
  const [e] = normalizeTradingEconomicsEvents(
    [{ CalendarId: "1", Event: "CPI YoY", Date: "2026-03-10T12:30:00", Country: "United States", Currency: "USD", Importance: 3 }],
    { nowMs: Date.parse("2026-03-09T00:00:00Z"), freshness: "LIVE" },
  );
  assert.equal(e!.eventTimeUtc, "2026-03-10T12:30:00.000Z");
  assert.equal(e!.timePrecision, "exact");
  assert.equal(e!.timeSource, "provider");
  assert.equal(e!.impactBasis, "provider_importance");
});

test("news risk never counts down to a date-only sentinel", () => {
  const now = Date.now();
  const midnightSoon = new Date(now + 10 * 60_000).toISOString();
  const r = scoreNewsRisk("EURUSD", [{
    id: "x", title: "Euro Short-Term Rate", country: "Euro Area", currency: "EUR", impact: "high",
    actual: null, forecast: null, previous: null, eventTime: midnightSoon, affectedMarkets: [], source: "FRED",
    timePrecision: "date",
  }]);
  assert.equal(r.minutesUntilEvent, null);
  assert.equal(r.blockTrading, false);
});

// ── Freshness + source attribution on every served shape ────────────────────
const FRESHNESS = new Set(["LIVE", "DELAYED", "STALE", "UNAVAILABLE"]);
function assertProvenance(e: Record<string, unknown>, label: string) {
  assert.ok(typeof e["source"] === "string" && (e["source"] as string).trim(), `${label}: source`);
  assert.ok(typeof e["provider"] === "string" && (e["provider"] as string).trim(), `${label}: provider`);
  assert.ok(typeof e["fetchedAt"] === "string" && Number.isFinite(Date.parse(e["fetchedAt"] as string)), `${label}: fetchedAt`);
  assert.ok(FRESHNESS.has(e["freshness"] as string), `${label}: freshness`);
  assert.equal(e["stale"], e["freshness"] === "STALE" || e["freshness"] === "UNAVAILABLE", `${label}: stale flag matches freshness`);
}

test("freshness: LIVE on fetch, DELAYED from cache, STALE + labelled on provider error; fetch time is the real fetch time", async () => {
  const t0 = Date.parse("2026-03-05T10:00:00Z");
  useFred([{ release_id: "10", release_name: "Consumer Price Index", date: ymd(t0 + 86400_000) }]);
  const live = await getEconomicCalendarResult({ nowMs: t0 });
  assert.equal(live.events[0]!.freshness, "LIVE");
  assert.equal(live.events[0]!.lastUpdatedAt, new Date(t0).toISOString());

  const cached = await getEconomicCalendarResult({ nowMs: t0 + 3 * 60_000 });
  assert.equal(cached.events[0]!.freshness, "DELAYED");
  assert.equal(cached.events[0]!.lastUpdatedAt, new Date(t0).toISOString(), "cache keeps the original fetch time");

  useFred([], false);
  const failed = await getEconomicCalendarResult({ nowMs: t0 + 10 * 60_000, forceRefresh: true });
  assert.equal(failed.status, "error");
  assert.equal(failed.connected, false);
  const stale = toMockShapeEvents(failed.events);
  assert.equal(stale.length, 1);
  assert.equal(stale[0]!.freshness, "STALE");
  assert.equal(stale[0]!.stale, true);
  assert.equal(stale[0]!.fetchedAt, new Date(t0).toISOString());
});

test("source attribution: /news/calendar, live-calendar and DB-sync shapes all carry provenance", async () => {
  const now = Date.now();
  useFred([
    { release_id: "10", release_name: "Consumer Price Index", date: ymd(now + 2 * 86400_000) },
    { release_id: "50", release_name: "Employment Situation", date: ymd(now + 3 * 86400_000) },
  ]);
  const result = await getEconomicCalendarResult({ nowMs: now });
  assert.ok(result.events.length >= 2);
  toMockShapeEvents(result.events).forEach((e, i) => assertProvenance(e as unknown as Record<string, unknown>, `news/calendar[${i}]`));
  const enriched = await getEnrichedCalendarEvents("", now, 7 * 86400_000);
  assert.ok(enriched.events.length >= 2);
  enriched.events.forEach((e, i) => assertProvenance(e as unknown as Record<string, unknown>, `economic-calendar/events[${i}]`));
  for (const p of toProviderEvents(result.events)) {
    assert.ok(p.source && p.fetchedAt instanceof Date && Number.isFinite(p.fetchedAt.getTime()), "sync rows carry source + fetchedAt");
  }
});

test("stored (DB) events: freshness from the recorded fetch time; unknown fetch time is STALE", () => {
  const now = Date.parse("2026-03-05T12:00:00Z");
  assert.equal(storedEventFreshness(null, now), "STALE");
  assert.equal(storedEventFreshness(new Date(now - 60_000), now), "LIVE");
  assert.equal(storedEventFreshness(new Date(now - STORED_EVENT_LIVE_MAX_AGE_MS - 1), now), "DELAYED");
  assert.equal(storedEventFreshness(new Date(now - STORED_EVENT_DELAYED_MAX_AGE_MS - 1), now), "STALE");
  assert.equal(storedEventFreshness(new Date(now + 10 * 60_000), now), "STALE", "future-stamped is not fresh");
});

test("stored-event routes serve fetchedAt/freshness and never serve legacy mock rows", () => {
  const route = src("../../../../routes/newsCalendar.ts");
  assert.match(route, /fetchedAt: r\.fetchedAt \? r\.fetchedAt\.toISOString\(\) : null/);
  assert.match(route, /stale: freshness === "STALE"/);
  const selects = route.match(/\.from\(economicEventsTable\)[\s\S]{0,260}/g) ?? [];
  assert.ok(selects.length >= 4);
  assert.match(route, /const conds = \[[^\]]*NOT_MOCK,[^\]]*\];/, "the filtered list query includes NOT_MOCK in its conditions");
  for (const s of selects) assert.match(s, /NOT_MOCK|and\(\.\.\.conds\)/, `every economic_events read excludes mock rows: ${s.slice(0, 80)}`);
  assert.match(route, /fetchedAt: e\.fetchedAt,\n\s+\}\)\.onConflictDoUpdate/, "sync stamps fetchedAt on insert");
  assert.match(route, /volatilityFlag: volatility, fetchedAt: e\.fetchedAt,/, "and on re-sync");
  const readiness = src("../../../../routes/tradingReadiness.ts");
  assert.match(readiness, /ne\(economicEventsTable\.source, "mock"\)/);
});

test("the mock generator is gone: no provider selected ⇒ honest-empty 'none'", async () => {
  for (const k of ENV) delete process.env[k];
  const p = pickNewsProvider();
  assert.equal(p.name, "none");
  assert.deepEqual(await p.fetchEvents(7), []);
  const ev = src("../economicEvents.ts");
  assert.ok(!/getMockEvents|TEMPLATES|source: "Mock"/.test(ev));
});

// ── Impact provenance ────────────────────────────────────────────────────────
test("impact is a category with a stated basis; no shape carries an expected-move or impact number", async () => {
  const now = Date.now();
  useFred([{ release_id: "10", release_name: "Consumer Price Index", date: ymd(now + 2 * 86400_000) }]);
  const enriched = await getEnrichedCalendarEvents("", now, 7 * 86400_000);
  const legacy = toMockShapeEvents((await getEconomicCalendarResult({ nowMs: now })).events);
  const FORECAST_KEY = /expected.?move|expectedPips|pips|move(?:Pct|Percent)|impactScore|volatilityForecast|predicted/i;
  for (const e of [...enriched.events, ...legacy] as unknown as Array<Record<string, unknown>>) {
    for (const k of Object.keys(e)) assert.ok(!FORECAST_KEY.test(k), `no forecast field "${k}" on a calendar event`);
    assert.ok(["low", "medium", "high", "critical"].includes(String(e["impactTier"] ?? e["impact"])));
  }
  for (const e of enriched.events) assert.equal(e.impactBasis, "arx_release_classifier");
  // A legacy event without an explicit basis gets its provider's basis.
  assert.equal(calendarEventProvenance({ provider: "trading_economics", lastUpdatedAt: new Date(now).toISOString(), freshness: "LIVE" } as never).impactBasis, "provider_importance");
  assert.equal(calendarEventProvenance({ provider: "fred", lastUpdatedAt: new Date(now).toISOString(), freshness: "STALE" } as never).stale, true);
  // Source files of the calendar stack declare no expected-move numbers either.
  for (const f of ["../calendarTypes.ts", "../../economicCalendarProvider.ts", "../calendarAdapters.ts", "../economicEvents.ts"]) {
    assert.ok(!/expectedMove|expected_move|expectedPips/.test(src(f)), f);
  }
});
