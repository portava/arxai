// Deterministic, offline tests for the Trading Economics economic-calendar
// provider + the four consumer seams. Run via:
//   pnpm --filter @workspace/api-server run test:trading-economics-calendar
//
// NON-NEGOTIABLE HONESTY (every case below locks one rule):
//   - missing key            ⇒ "provider missing"  (NEVER "no events" / "low risk")
//   - provider error         ⇒ "provider error"    (NEVER fake empty / neutral)
//   - success + zero events  ⇒ "No relevant events" (and ONLY then)
//   - synthetics             ⇒ macro not applicable (NEVER fake country events)
// The HTTP fetch is injected so nothing touches the network. The economic
// calendar is read/risk-context only — the final test proves no calendar module
// imports any execution gate / MT5 bridge / broker dispatch / kill switch.

import { test, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import {
  getEconomicCalendarResult,
  getEconomicCalendarDiagnostics,
  isEconomicCalendarConfigured,
  isEconomicCalendarProviderSelected,
  __setEconomicCalendarFetcherForTests,
  __resetEconomicCalendarStateForTests,
} from "../economicCalendarService.js";
import { pickNewsProvider } from "../newsProvider.js";
import {
  isSyntheticSymbol,
  macroApplies,
  currenciesForSymbol,
  filterEventsForSymbol,
} from "../calendarSymbolMap.js";
import type { RawTradingEconomicsEvent } from "../tradingEconomicsProvider.js";
import { getEconomicCalendar } from "../../economicCalendarProvider.js";
import { readCalendarProvider } from "../../../heat/marketHeatProviderStatus.js";
import {
  getMarketProvider,
  _resetMarketProviderForTests,
} from "../../../assistant/marketProvider.js";

// ── Env + fetcher helpers ────────────────────────────────────────────────────

const ENV_KEYS = [
  "ECONOMIC_CALENDAR_PROVIDER",
  "TRADING_ECONOMICS_KEY",
  "TRADING_ECONOMICS_SECRET",
  "FRED_API_KEY",
] as const;

let envSnapshot: Record<string, string | undefined> = {};

function configure(key = "te-key-abc", secret?: string): void {
  process.env["ECONOMIC_CALENDAR_PROVIDER"] = "trading_economics";
  process.env["TRADING_ECONOMICS_KEY"] = key;
  if (secret) process.env["TRADING_ECONOMICS_SECRET"] = secret;
  else delete process.env["TRADING_ECONOMICS_SECRET"];
}

function unconfigureNoKey(): void {
  // Provider selected but NO key ⇒ "missing" (the honest unconfigured state).
  process.env["ECONOMIC_CALENDAR_PROVIDER"] = "trading_economics";
  delete process.env["TRADING_ECONOMICS_KEY"];
  delete process.env["TRADING_ECONOMICS_SECRET"];
}

function fetcherReturning(rows: unknown): void {
  __setEconomicCalendarFetcherForTests(async () => ({
    ok: true,
    status: 200,
    text: async () => JSON.stringify(rows),
  }));
}

function fetcherHttpError(status = 503): void {
  __setEconomicCalendarFetcherForTests(async () => ({
    ok: false,
    status,
    text: async () => "upstream unavailable",
  }));
}

function fetcherThrowing(message: string): void {
  __setEconomicCalendarFetcherForTests(async () => {
    throw new Error(message);
  });
}

const FUTURE = "2030-01-15T12:30:00"; // TE shape (UTC, no zone) — always upcoming.

function rawEvent(over: Partial<RawTradingEconomicsEvent>): RawTradingEconomicsEvent {
  return {
    CalendarId: "1",
    Date: FUTURE,
    Country: "United States",
    Currency: "USD",
    Category: "Labour",
    Event: "Non Farm Payrolls",
    Importance: 3,
    Forecast: "180K",
    Previous: "175K",
    Actual: null,
    ...over,
  };
}

beforeEach(() => {
  envSnapshot = {};
  for (const k of ENV_KEYS) envSnapshot[k] = process.env[k];
  __resetEconomicCalendarStateForTests();
  __setEconomicCalendarFetcherForTests(null);
  _resetMarketProviderForTests();
});

afterEach(() => {
  for (const k of ENV_KEYS) {
    if (envSnapshot[k] === undefined) delete process.env[k];
    else process.env[k] = envSnapshot[k];
  }
  __resetEconomicCalendarStateForTests();
  __setEconomicCalendarFetcherForTests(null);
  _resetMarketProviderForTests();
});

// ── 1. Missing key shows provider missing, not no events ─────────────────────

test("1. missing key ⇒ status missing, message says provider missing (not 'no events')", async () => {
  unconfigureNoKey();
  const r = await getEconomicCalendarResult({ forceRefresh: true });
  assert.equal(r.status, "missing");
  assert.equal(r.connected, false);
  assert.equal(r.configured, false);
  assert.match(r.message.toLowerCase(), /provider missing/);
  // Must NOT claim there are no events, and must NOT imply low/neutral risk.
  assert.doesNotMatch(r.message.toLowerCase(), /no relevant events|no events|low risk/);
  assert.equal(r.events.length, 0);
});

// ── 2. Provider error shows provider error, not low risk ─────────────────────

test("2. provider error ⇒ status error, message says provider error (not 'low risk')", async () => {
  configure();
  fetcherHttpError(503);
  const r = await getEconomicCalendarResult({ forceRefresh: true });
  assert.equal(r.status, "error");
  assert.equal(r.connected, false); // live surfaces still suppress
  assert.equal(r.configured, true);
  assert.match(r.message.toLowerCase(), /provider error/);
  assert.doesNotMatch(r.message.toLowerCase(), /no relevant events|low risk/);
});

// ── 3. Successful empty response shows "No relevant events" ───────────────────

test("3. success + zero events ⇒ status empty, message 'No relevant events'", async () => {
  configure();
  fetcherReturning([]);
  const r = await getEconomicCalendarResult({ forceRefresh: true });
  assert.equal(r.status, "empty");
  assert.equal(r.connected, true); // provider reachable
  assert.match(r.message.toLowerCase(), /no relevant (economic )?events/);
  assert.equal(r.events.length, 0);
});

// ── 4. EURUSD pulls EUR + USD events (not JPY) ───────────────────────────────

test("4. EURUSD pulls EUR + USD events only", async () => {
  configure();
  fetcherReturning([
    rawEvent({ CalendarId: "e1", Country: "Euro Area", Currency: "EUR", Event: "ECB Economic Bulletin", Importance: 2 }),
    rawEvent({ CalendarId: "u1", Country: "United States", Currency: "USD", Event: "Initial Jobless Claims", Importance: 2 }),
    rawEvent({ CalendarId: "j1", Country: "Japan", Currency: "JPY", Event: "Machine Tool Orders", Importance: 2 }),
  ]);
  const snap = await getEconomicCalendar("EURUSD");
  assert.equal(snap.connected, true);
  const ccys = new Set(snap.events.map((e) => e.currency));
  assert.ok(ccys.has("EUR"), "expected an EUR event");
  assert.ok(ccys.has("USD"), "expected a USD event");
  assert.ok(!ccys.has("JPY"), "JPY event must not map to EURUSD");

  // Pure mapping sanity.
  assert.deepEqual(currenciesForSymbol("EURUSD").sort(), ["EUR", "USD"]);
});

// ── 5. XAUUSD pulls USD high-impact macro events ─────────────────────────────

test("5. XAUUSD pulls USD high-impact macro events", async () => {
  configure();
  fetcherReturning([
    rawEvent({ CalendarId: "u2", Country: "United States", Currency: "USD", Event: "Non Farm Payrolls", Importance: 3 }),
    rawEvent({ CalendarId: "e2", Country: "Euro Area", Currency: "EUR", Event: "ECB Economic Bulletin", Importance: 2 }),
  ]);
  const snap = await getEconomicCalendar("XAUUSD");
  assert.equal(snap.connected, true);
  assert.ok(snap.events.length >= 1);
  // Gold trades on USD macro only — no EUR event should map.
  assert.ok(snap.events.every((e) => e.currency === "USD"));
  assert.ok(snap.events.some((e) => e.impact === "high"));
  assert.deepEqual(currenciesForSymbol("XAUUSD"), ["USD"]);
});

// ── 6. Deriv synthetics do not receive fake country events ───────────────────

test("6. Deriv synthetics ⇒ no fabricated country events (macro not applicable)", async () => {
  configure();
  fetcherReturning([
    rawEvent({ CalendarId: "u3", Country: "United States", Currency: "USD", Event: "Non Farm Payrolls", Importance: 3 }),
  ]);
  for (const sym of ["R_75", "Volatility 75 Index", "BOOM1000", "CRASH500"]) {
    assert.equal(isSyntheticSymbol(sym), true, `${sym} should be synthetic`);
    assert.equal(macroApplies(sym), false, `${sym} macro should not apply`);
    const snap = await getEconomicCalendar(sym);
    assert.equal(snap.events.length, 0, `${sym} must receive zero events`);
  }
  // Pure filter never leaks events onto a synthetic even with a fat event list.
  const all = await getEconomicCalendarResult({ forceRefresh: true });
  assert.equal(filterEventsForSymbol(all.events, "R_75").length, 0);
});

// ── 7. Eleanor says calendar unavailable when provider missing ──────────────────

test("7. Eleanor market-provider calendar is unavailable when provider missing", async () => {
  unconfigureNoKey();
  assert.equal(isEconomicCalendarConfigured(), false);
  const mp = getMarketProvider();
  const cal = await mp.getEconomicCalendar();
  assert.equal(cal.connected, false);
  assert.equal(cal.events.length, 0); // never fabricates a schedule
});

// ── 8. Eleanor can cite an upcoming high-impact event when provider returns one ──

test("8. Eleanor market-provider surfaces an upcoming high-impact event when configured", async () => {
  configure();
  fetcherReturning([
    rawEvent({ CalendarId: "u4", Country: "United States", Currency: "USD", Event: "Non Farm Payrolls", Importance: 3 }),
  ]);
  const mp = getMarketProvider();
  const cal = await mp.getEconomicCalendar();
  assert.equal(cal.connected, true);
  assert.ok(cal.events.length >= 1);
  const ev = cal.events[0]!;
  assert.equal(ev.importance, "high");
  assert.ok(ev.title.length > 0);
  assert.ok(ev.whenIso.length > 0);
});

// ── 9. Chart Impact Radar renders real upcoming events (RawCalendarEvent) ─────

test("9. Impact-radar seam returns real upcoming events in RawCalendarEvent shape", async () => {
  configure();
  fetcherReturning([
    rawEvent({ CalendarId: "u5", Country: "United States", Currency: "USD", Event: "CPI YoY", Importance: 3 }),
  ]);
  const snap = await getEconomicCalendar("EURUSD");
  assert.equal(snap.connected, true);
  assert.ok(snap.events.length >= 1);
  const e = snap.events[0]!;
  // Exact RawCalendarEvent contract the radar consumes.
  assert.equal(typeof e.id, "string");
  assert.equal(typeof e.title, "string");
  assert.equal(typeof e.currency, "string");
  assert.ok(["low", "medium", "high"].includes(e.impact));
  assert.ok(!Number.isNaN(Date.parse(e.eventTimeIso)));
  assert.ok(Array.isArray(e.affectedMarkets));
});

// ── 10. Global Market Heat uses calendar events only when connected ──────────

test("10. heat readCalendarProvider surfaces events only when connected", async () => {
  // Connected ⇒ events present, status live.
  configure();
  fetcherReturning([
    rawEvent({ CalendarId: "u6", Country: "United States", Currency: "USD", Event: "Non Farm Payrolls", Importance: 3 }),
  ]);
  const live = await readCalendarProvider("EURUSD");
  assert.equal(live.connected, true);
  assert.equal(live.source.status, "live");
  assert.ok(live.events.length >= 1);

  // Error ⇒ NO events, status error (never fabricated, never "unavailable").
  __resetEconomicCalendarStateForTests();
  fetcherHttpError(500);
  const errored = await readCalendarProvider("EURUSD");
  assert.equal(errored.connected, false);
  assert.equal(errored.source.status, "error");
  assert.equal(errored.events.length, 0);

  // Missing ⇒ NO events, status missing.
  __resetEconomicCalendarStateForTests();
  __setEconomicCalendarFetcherForTests(null);
  unconfigureNoKey();
  const missing = await readCalendarProvider("EURUSD");
  assert.equal(missing.connected, false);
  assert.equal(missing.source.status, "missing");
  assert.equal(missing.events.length, 0);
});

// ── 11. Diagnostics never expose secrets ─────────────────────────────────────

test("11. diagnostics never leak the key/secret (presence boolean + redacted error)", async () => {
  const KEY = "SUPER_SECRET_KEY_9Z";
  const SECRET = "TOP_SECRET_TOKEN_4Q";
  configure(KEY, SECRET);
  // Error message intentionally embeds the credential to prove redaction.
  fetcherThrowing(`fetch failed for c=${KEY}:${SECRET}`);
  const diag = await getEconomicCalendarDiagnostics();
  const blob = JSON.stringify(diag);
  assert.ok(!blob.includes(KEY), "raw key must never appear in diagnostics");
  assert.ok(!blob.includes(SECRET), "raw secret must never appear in diagnostics");
  assert.equal(diag.apiKeyPresent, true); // boolean presence only
  assert.equal(typeof diag.apiKeyPresent, "boolean");
  assert.ok(diag.lastError && diag.lastError.includes("***"), "error should be redacted");
});

// ── 12. No live execution gates are touched ──────────────────────────────────

test("12. no calendar module imports any execution gate / bridge / dispatch / kill switch", () => {
  const files = [
    "calendarTypes.ts",
    "calendarSymbolMap.ts",
    "tradingEconomicsProvider.ts",
    "economicCalendarService.ts",
    "calendarAdapters.ts",
    "newsProvider.ts",
  ];
  // Substrings that would indicate a forbidden execution-path dependency.
  const FORBIDDEN = [
    "livePhaseBDispatchGate",
    "liveCommandPipeline",
    "lib/live/",
    "lib/liveTrading/",
    "placeLiveOrderGuarded",
    "executeInstantTrade",
    "killSwitch",
    "kill-switch",
    "safety-contracts",
    "mt5Live",
    "brokerDispatch",
  ];
  for (const f of files) {
    const src = readFileSync(new URL(`../${f}`, import.meta.url), "utf8");
    // Only scan import/from lines so an explanatory comment never trips it.
    const importLines = src
      .split("\n")
      .filter((l) => /^\s*import\b/.test(l) || /\bfrom\s+["']/.test(l));
    for (const bad of FORBIDDEN) {
      assert.ok(
        !importLines.some((l) => l.includes(bad)),
        `${f} must not import "${bad}" (economic calendar is read/risk-context only)`,
      );
    }
  }
});

// ── 13. Seam honesty: TE selected but no key ⇒ honest-empty, NEVER mock ───────

test("13. pickNewsProvider returns honest-empty TE provider when selected but key missing (no fabricated mock rows)", async () => {
  // Provider SELECTED but unconfigured (no key) — the live state in this env.
  unconfigureNoKey();
  assert.equal(isEconomicCalendarProviderSelected(), true);
  assert.equal(isEconomicCalendarConfigured(), false);

  const provider = pickNewsProvider();
  // Must be the real TE provider — NOT the mock generator.
  assert.equal(provider.name, "trading_economics");
  const events = await provider.fetchEvents(7);
  // Honest-empty: a selected-but-unconfigured provider syncs ZERO rows; it must
  // never silently emit fabricated mock events.
  assert.equal(events.length, 0);
});

test("14. default provider uses the real public weekly schedule, never mock events", async () => {
  // True legacy default: no provider selected at all.
  delete process.env["ECONOMIC_CALENDAR_PROVIDER"];
  delete process.env["TRADING_ECONOMICS_KEY"];
  delete process.env["TRADING_ECONOMICS_SECRET"];
  assert.equal(isEconomicCalendarProviderSelected(), true);

  const provider = pickNewsProvider();
  assert.equal(provider.name, "forex_factory");
});

// ── 15. Cache is keyed by horizon — no cross-window contamination ─────────────

test("15. cache is keyed by daysAhead — a different horizon never reuses another window's cache", async () => {
  configure();
  let fetchCount = 0;
  __setEconomicCalendarFetcherForTests(async () => {
    fetchCount += 1;
    return {
      ok: true,
      status: 200,
      text: async () => JSON.stringify([rawEvent({ CalendarId: `c${fetchCount}` })]),
    };
  });
  const t = Date.UTC(2030, 0, 1); // fixed "now" — well within the 5-min TTL.

  await getEconomicCalendarResult({ daysAhead: 7, nowMs: t });
  assert.equal(fetchCount, 1, "first fetch for days=7");

  // Same horizon within TTL ⇒ cache hit, NO new fetch.
  await getEconomicCalendarResult({ daysAhead: 7, nowMs: t + 1_000 });
  assert.equal(fetchCount, 1, "same horizon within TTL must be served from cache");

  // Different horizon within TTL ⇒ MUST refetch (no cross-window reuse).
  await getEconomicCalendarResult({ daysAhead: 14, nowMs: t + 2_000 });
  assert.equal(fetchCount, 2, "a different horizon must NOT reuse the days=7 cache");
});


// Owner screenshot 2026-10-27: the heat list printed "Calendar never" because
// the calendar time was hard-coded null even when a calendar was connected.
test("11. heat readCalendarProvider reports the last SUCCESSFUL fetch time, never a failed attempt", async () => {
  const t1 = Date.parse("2030-01-10T09:00:00.000Z");
  configure();
  fetcherReturning([rawEvent({ CalendarId: "u7" })]);
  const live = await readCalendarProvider("EURUSD", t1);
  assert.equal(live.connected, true);
  assert.equal(live.updatedAt, new Date(t1).toISOString());
  assert.equal(live.source.updatedAt, new Date(t1).toISOString());

  // A later failed attempt (past the cache window) is not a check.
  fetcherHttpError(503);
  const failed = await readCalendarProvider("EURUSD", t1 + 24 * 3_600_000);
  assert.equal(failed.connected, false);
  assert.equal(failed.updatedAt, null);
  assert.equal(failed.source.updatedAt, null);

  // Not configured ⇒ no time.
  __resetEconomicCalendarStateForTests();
  __setEconomicCalendarFetcherForTests(null);
  unconfigureNoKey();
  const missing = await readCalendarProvider("EURUSD", t1);
  assert.equal(missing.updatedAt, null);
});


// Cache provenance adversaries: no provider request leaves this process.
test("cache identity includes provider and credentials; a failed replacement cannot borrow old events", async () => {
  configure();
  const nowMs = Date.UTC(2030, 0, 15, 10);
  let calls = 0;
  __setEconomicCalendarFetcherForTests(async () => {
    calls++;
    return { ok: true, status: 200, text: async () => JSON.stringify([rawEvent({})]) };
  });
  const first = await getEconomicCalendarResult({ nowMs });
  const cached = await getEconomicCalendarResult({ nowMs: nowMs + 1000 });
  assert.equal(calls, 1);
  assert.equal(cached.events[0]?.lastUpdatedAt, first.events[0]?.lastUpdatedAt);
  configure("rotated-test-key");
  await getEconomicCalendarResult({ nowMs: nowMs + 2000 });
  assert.equal(calls, 2, "credential rotation refetches even the same provider/horizon");
  process.env.ECONOMIC_CALENDAR_PROVIDER = "fred";
  process.env.FRED_API_KEY = "fixture-fred-key";
  __setEconomicCalendarFetcherForTests(async () => {
    calls++;
    return { ok: false, status: 503, text: async () => "unavailable" };
  });
  const replacement = await getEconomicCalendarResult({ nowMs: nowMs + 3000 });
  assert.equal(calls, 3);
  assert.equal(replacement.provider, "fred");
  assert.equal(replacement.connected, false);
  assert.equal(replacement.diagnostics.lastSuccessAt, null);
  assert.deepEqual(replacement.events, [], "TE rows never become FRED stale evidence");
});

test("calendar cache cannot cross UTC request windows or a clock rollback", async () => {
  configure();
  let calls = 0;
  __setEconomicCalendarFetcherForTests(async () => {
    calls++;
    return { ok: true, status: 200, text: async () => "[]" };
  });
  const midnight = Date.UTC(2030, 0, 16);
  await getEconomicCalendarResult({ nowMs: midnight - 1000 });
  await getEconomicCalendarResult({ nowMs: midnight + 1000 });
  assert.equal(calls, 2, "new UTC day extends the provider date range");
  await getEconomicCalendarResult({ nowMs: midnight });
  assert.equal(calls, 3, "future fetchedAt is never fresh");
});

test("a delayed old request cannot replace a newer calendar result or its diagnostics", async () => {
  configure();
  const nowMs = Date.UTC(2030, 0, 15, 10);
  let release!: (value: { ok: boolean; status: number; text(): Promise<string> }) => void;
  __setEconomicCalendarFetcherForTests(() => new Promise(resolve => { release = resolve; }));
  const older = getEconomicCalendarResult({ nowMs });
  fetcherReturning([rawEvent({ CalendarId: "newer" })]);
  const newer = await getEconomicCalendarResult({ nowMs: nowMs + 1000, forceRefresh: true });
  release({ ok: true, status: 200, text: async () => JSON.stringify([rawEvent({ CalendarId: "older" })]) });
  assert.equal((await older).connected, false);
  const cached = await getEconomicCalendarResult({ nowMs: nowMs + 2000 });
  assert.deepEqual(cached.events, newer.events);
  assert.equal(cached.diagnostics.lastError, null);
  assert.equal(cached.diagnostics.lastSuccessAt, new Date(nowMs + 1000).toISOString());
});

test("configuration changes invalidate requests already in flight", async () => {
  configure("old-test-key");
  const nowMs = Date.UTC(2030, 0, 15, 10);
  let release!: (value: { ok: boolean; status: number; text(): Promise<string> }) => void;
  __setEconomicCalendarFetcherForTests(() => new Promise(resolve => { release = resolve; }));
  const older = getEconomicCalendarResult({ nowMs });
  configure("new-test-key");
  fetcherReturning([rawEvent({ CalendarId: "new-key" })]);
  const fresh = await getEconomicCalendarResult({ nowMs: nowMs + 1000 });
  release({ ok: true, status: 200, text: async () => JSON.stringify([rawEvent({ CalendarId: "old-key" })]) });
  const obsolete = await older;
  assert.equal(obsolete.connected, false);
  assert.deepEqual(obsolete.events, []);
  assert.deepEqual((await getEconomicCalendarResult({ nowMs: nowMs + 2000 })).events, fresh.events);
});


test("concurrent equivalent calendar reads share one fetch and preserve its original evidence time", async () => {
  configure();
  const nowMs = Date.UTC(2030, 0, 15, 10);
  let calls = 0;
  let release!: (value: { ok: boolean; status: number; text(): Promise<string> }) => void;
  __setEconomicCalendarFetcherForTests(() => { calls++; return new Promise(resolve => { release = resolve; }); });
  const reads = Array.from({ length: 8 }, (_, i) => getEconomicCalendarResult({ nowMs: nowMs + i }));
  assert.equal(calls, 1);
  release({ ok: true, status: 200, text: async () => JSON.stringify([rawEvent({})]) });
  for (const result of await Promise.all(reads)) {
    assert.equal(result.connected, true);
    assert.equal(result.events[0]?.lastUpdatedAt, new Date(nowMs).toISOString());
    assert.equal(result.diagnostics.lastSuccessAt, new Date(nowMs).toISOString());
  }
});

test("an in-flight provider result is refused if credentials change before another read", async () => {
  configure();
  let release!: (value: { ok: boolean; status: number; text(): Promise<string> }) => void;
  __setEconomicCalendarFetcherForTests(() => new Promise(resolve => { release = resolve; }));
  const result = getEconomicCalendarResult({ nowMs: Date.UTC(2030, 0, 15, 10) });
  configure("changed-with-no-new-read");
  release({ ok: true, status: 200, text: async () => JSON.stringify([rawEvent({})]) });
  assert.equal((await result).connected, false);
});

test("concurrent different calendar horizons retain their own evidence without overwriting newer cache", async () => {
  configure();
  const nowMs = Date.UTC(2030, 0, 15, 10);
  let release!: (value: { ok: boolean; status: number; text(): Promise<string> }) => void;
  __setEconomicCalendarFetcherForTests(() => new Promise(resolve => { release = resolve; }));
  const short = getEconomicCalendarResult({ nowMs, daysAhead: 1 });
  fetcherReturning([rawEvent({ CalendarId: "wide-window" })]);
  const wide = await getEconomicCalendarResult({ nowMs: nowMs + 1000, daysAhead: 7 });
  release({ ok: true, status: 200, text: async () => JSON.stringify([rawEvent({ CalendarId: "short-window" })]) });
  const shortResult = await short;
  assert.equal(shortResult.connected, true);
  assert.match(shortResult.events[0]!.id, /short-window/);
  const cached = await getEconomicCalendarResult({ nowMs: nowMs + 2000, daysAhead: 7 });
  assert.deepEqual(cached.events, wide.events);
  assert.equal(cached.diagnostics.lastSuccessAt, new Date(nowMs + 1000).toISOString());
});

test("a hung calendar request cannot monopolize its single-flight slot beyond the request timeout", async () => {
  configure();
  const nowMs = Date.UTC(2030, 0, 15, 10);
  let release!: (value: { ok: boolean; status: number; text(): Promise<string> }) => void;
  __setEconomicCalendarFetcherForTests(() => new Promise(resolve => { release = resolve; }));
  const hung = getEconomicCalendarResult({ nowMs });
  fetcherReturning([rawEvent({ CalendarId: "after-timeout" })]);
  const recovered = await getEconomicCalendarResult({ nowMs: nowMs + 8000 });
  assert.equal(recovered.connected, true);
  release({ ok: true, status: 200, text: async () => JSON.stringify([rawEvent({ CalendarId: "timed-out" })]) });
  assert.equal((await hung).connected, false);
  assert.deepEqual((await getEconomicCalendarResult({ nowMs: nowMs + 9000 })).events, recovered.events);
});
