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

// ── 7. Ruby says calendar unavailable when provider missing ──────────────────

test("7. Ruby market-provider calendar is unavailable when provider missing", async () => {
  unconfigureNoKey();
  assert.equal(isEconomicCalendarConfigured(), false);
  const mp = getMarketProvider();
  const cal = await mp.getEconomicCalendar();
  assert.equal(cal.connected, false);
  assert.equal(cal.events.length, 0); // never fabricates a schedule
});

// ── 8. Ruby can cite an upcoming high-impact event when provider returns one ──

test("8. Ruby market-provider surfaces an upcoming high-impact event when configured", async () => {
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

test("14. pickNewsProvider falls back to mock ONLY when no provider is selected (legacy default)", async () => {
  // True legacy default: no provider selected at all.
  delete process.env["ECONOMIC_CALENDAR_PROVIDER"];
  delete process.env["TRADING_ECONOMICS_KEY"];
  delete process.env["TRADING_ECONOMICS_SECRET"];
  assert.equal(isEconomicCalendarProviderSelected(), false);

  const provider = pickNewsProvider();
  assert.equal(provider.name, "mock");
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
