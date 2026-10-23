// Deterministic, offline tests for the FRED (St. Louis Fed) economic-calendar
// provider + the shared consumer seams under provider=fred. Run via:
//   pnpm --filter @workspace/api-server run test:fred-calendar
//
// NON-NEGOTIABLE HONESTY (every case below locks one rule):
//   - missing key            ⇒ "provider missing"  (NEVER "no events" / "low risk")
//   - provider error         ⇒ "provider error"    (NEVER fake empty / neutral)
//   - success + zero events  ⇒ "No relevant events" (and ONLY then)
//   - unrecognized release    ⇒ dropped (honest curation, never a fabricated event)
//   - FRED has no clock time / forecast / actual ⇒ those fields stay null
//   - synthetics             ⇒ macro not applicable (NEVER fake country events)
// The HTTP fetch is injected so nothing touches the network. Release dates are
// generated RELATIVE to now so the default 7-day horizon always includes them
// regardless of when the suite runs. The economic calendar is read/risk-context
// only — the final test proves the FRED module imports no execution gate / MT5
// bridge / broker dispatch / kill switch.

import { test, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import {
  getEconomicCalendarResult,
  getEconomicCalendarDiagnostics,
  isEconomicCalendarConfigured,
  isEconomicCalendarProviderSelected,
  selectedEconomicCalendarProvider,
  __setEconomicCalendarFetcherForTests,
  __resetEconomicCalendarStateForTests,
} from "../economicCalendarService.js";
import { pickNewsProvider } from "../newsProvider.js";
import {
  normalizeFredReleaseDates,
  type RawFredReleaseDate,
} from "../fredCalendarProvider.js";
import {
  isSyntheticSymbol,
  macroApplies,
  currenciesForSymbol,
  filterEventsForSymbol,
} from "../calendarSymbolMap.js";
import {
  getEconomicCalendar,
  getEnrichedCalendarEvents,
  getCalendarHealthSnapshot,
} from "../../economicCalendarProvider.js";
import { readCalendarProvider } from "../../../heat/marketHeatProviderStatus.js";
import {
  getMarketProvider,
  _resetMarketProviderForTests,
} from "../../../assistant/marketProvider.js";

// ── Env + fetcher helpers ────────────────────────────────────────────────────

const ENV_KEYS = [
  "ECONOMIC_CALENDAR_PROVIDER",
  "FRED_API_KEY",
  // Cleared so FRED (lower precedence than TE) is actually the active provider.
  "TRADING_ECONOMICS_KEY",
  "TRADING_ECONOMICS_SECRET",
] as const;

let envSnapshot: Record<string, string | undefined> = {};

function configure(key = "fred-key-abc"): void {
  process.env["ECONOMIC_CALENDAR_PROVIDER"] = "fred";
  process.env["FRED_API_KEY"] = key;
  // FRED must win — TE takes precedence when its key is present.
  delete process.env["TRADING_ECONOMICS_KEY"];
  delete process.env["TRADING_ECONOMICS_SECRET"];
}

function unconfigureNoKey(): void {
  // Provider selected but NO key ⇒ "missing" (the honest unconfigured state).
  process.env["ECONOMIC_CALENDAR_PROVIDER"] = "fred";
  delete process.env["FRED_API_KEY"];
  delete process.env["TRADING_ECONOMICS_KEY"];
  delete process.env["TRADING_ECONOMICS_SECRET"];
}

/** Wrap rows in the FRED `{ release_dates: [...] }` envelope. */
function fetcherReturning(rows: unknown): void {
  __setEconomicCalendarFetcherForTests(async () => ({
    ok: true,
    status: 200,
    text: async () => JSON.stringify({ release_dates: rows }),
  }));
}

/** Return an arbitrary body verbatim (for the unexpected-payload case). */
function fetcherReturningRaw(body: string): void {
  __setEconomicCalendarFetcherForTests(async () => ({
    ok: true,
    status: 200,
    text: async () => body,
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

/** YYYY-MM-DD offset days from now (FRED is date-granularity only). */
function ymd(offsetDays: number): string {
  return new Date(Date.now() + offsetDays * 86_400_000).toISOString().slice(0, 10);
}

function rawRelease(over: Partial<RawFredReleaseDate>): RawFredReleaseDate {
  return {
    release_id: "10",
    release_name: "Employment Situation", // USD high-impact in the classifier.
    date: ymd(2),
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

test("1. missing key ⇒ status missing, provider fred, message says provider missing", async () => {
  unconfigureNoKey();
  const r = await getEconomicCalendarResult({ forceRefresh: true });
  assert.equal(r.status, "missing");
  assert.equal(r.connected, false);
  assert.equal(r.configured, false);
  assert.equal(r.provider, "fred"); // honest: reports the SELECTED provider.
  assert.match(r.message.toLowerCase(), /provider missing/);
  assert.doesNotMatch(r.message.toLowerCase(), /no relevant events|no events|low risk/);
  assert.equal(r.events.length, 0);
});

// ── 2. Provider error shows provider error, not low risk ─────────────────────

test("2. provider error ⇒ status error, message says provider error (not 'low risk')", async () => {
  configure();
  fetcherHttpError(503);
  const r = await getEconomicCalendarResult({ forceRefresh: true });
  assert.equal(r.status, "error");
  assert.equal(r.connected, false);
  assert.equal(r.configured, true);
  assert.equal(r.provider, "fred");
  assert.match(r.message.toLowerCase(), /provider error/);
  assert.doesNotMatch(r.message.toLowerCase(), /no relevant events|low risk/);
});

// ── 3. Successful empty response shows "No relevant events" ───────────────────

test("3. success + zero classifiable events ⇒ status empty, 'No relevant events'", async () => {
  configure();
  // Real FRED rows the curated classifier does NOT recognize ⇒ all dropped.
  fetcherReturning([
    rawRelease({ release_id: "1", release_name: "Commercial Paper Outstanding", date: ymd(1) }),
    rawRelease({ release_id: "2", release_name: "Senior Loan Officer Opinion Survey", date: ymd(2) }),
  ]);
  const r = await getEconomicCalendarResult({ forceRefresh: true });
  assert.equal(r.status, "empty");
  assert.equal(r.connected, true); // provider reachable
  assert.match(r.message.toLowerCase(), /no relevant (economic )?events/);
  assert.equal(r.events.length, 0);
});

// ── 4. EURUSD pulls EUR + USD events (not unrelated currencies) ───────────────

test("4. EURUSD pulls EUR + USD events only", async () => {
  configure();
  fetcherReturning([
    rawRelease({ release_id: "e1", release_name: "Euro Short-Term Rate", date: ymd(1) }),
    rawRelease({ release_id: "u1", release_name: "Consumer Price Index", date: ymd(2) }),
    // Unclassified row (no JPY in classifier) ⇒ dropped, never mapped to EURUSD.
    rawRelease({ release_id: "j1", release_name: "Japan Tankan Survey", date: ymd(3) }),
  ]);
  const snap = await getEconomicCalendar("EURUSD");
  assert.equal(snap.connected, true);
  const ccys = new Set(snap.events.map((e) => e.currency));
  assert.ok(ccys.has("EUR"), "expected an EUR event");
  assert.ok(ccys.has("USD"), "expected a USD event");
  assert.ok(!ccys.has("JPY"), "no JPY event should exist (unclassified ⇒ dropped)");
  assert.deepEqual(currenciesForSymbol("EURUSD").sort(), ["EUR", "USD"]);
});

// ── 5. XAUUSD pulls USD high-impact macro events ─────────────────────────────

test("5. XAUUSD pulls USD high-impact macro events", async () => {
  configure();
  fetcherReturning([
    rawRelease({ release_id: "u2", release_name: "Employment Situation", date: ymd(1) }),
    rawRelease({ release_id: "e2", release_name: "Euro Short-Term Rate", date: ymd(2) }),
  ]);
  const snap = await getEconomicCalendar("XAUUSD");
  assert.equal(snap.connected, true);
  assert.ok(snap.events.length >= 1);
  assert.ok(snap.events.every((e) => e.currency === "USD"));
  assert.ok(snap.events.some((e) => e.impact === "high"));
  assert.deepEqual(currenciesForSymbol("XAUUSD"), ["USD"]);
});

// ── 6. Deriv synthetics do not receive fake country events ───────────────────

test("6. Deriv synthetics ⇒ no fabricated country events (macro not applicable)", async () => {
  configure();
  fetcherReturning([rawRelease({ release_id: "u3", release_name: "Employment Situation", date: ymd(1) })]);
  for (const sym of ["R_75", "Volatility 75 Index", "BOOM1000", "CRASH500"]) {
    assert.equal(isSyntheticSymbol(sym), true, `${sym} should be synthetic`);
    assert.equal(macroApplies(sym), false, `${sym} macro should not apply`);
    const snap = await getEconomicCalendar(sym);
    assert.equal(snap.events.length, 0, `${sym} must receive zero events`);
  }
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

// ── 8. Ruby cites an upcoming high-impact event when configured ──────────────

test("8. Ruby market-provider surfaces an upcoming high-impact event when configured", async () => {
  configure();
  fetcherReturning([rawRelease({ release_id: "u4", release_name: "Employment Situation", date: ymd(2) })]);
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
  fetcherReturning([rawRelease({ release_id: "u5", release_name: "Consumer Price Index", date: ymd(2) })]);
  const snap = await getEconomicCalendar("EURUSD");
  assert.equal(snap.connected, true);
  assert.ok(snap.events.length >= 1);
  const e = snap.events[0]!;
  assert.equal(typeof e.id, "string");
  assert.equal(typeof e.title, "string");
  assert.equal(typeof e.currency, "string");
  assert.ok(["low", "medium", "high"].includes(e.impact));
  assert.ok(!Number.isNaN(Date.parse(e.eventTimeIso)));
  assert.ok(Array.isArray(e.affectedMarkets));
});

// ── 10. Global Market Heat uses calendar events only when connected ──────────

test("10. heat readCalendarProvider surfaces events only when connected", async () => {
  configure();
  fetcherReturning([rawRelease({ release_id: "u6", release_name: "Employment Situation", date: ymd(2) })]);
  const live = await readCalendarProvider("EURUSD");
  assert.equal(live.connected, true);
  assert.equal(live.source.status, "live");
  assert.ok(live.events.length >= 1);

  __resetEconomicCalendarStateForTests();
  fetcherHttpError(500);
  const errored = await readCalendarProvider("EURUSD");
  assert.equal(errored.connected, false);
  assert.equal(errored.source.status, "error");
  assert.equal(errored.events.length, 0);

  __resetEconomicCalendarStateForTests();
  __setEconomicCalendarFetcherForTests(null);
  unconfigureNoKey();
  const missing = await readCalendarProvider("EURUSD");
  assert.equal(missing.connected, false);
  assert.equal(missing.source.status, "missing");
  assert.equal(missing.events.length, 0);
});

// ── 11. Diagnostics never expose the key ──────────────────────────────────────

test("11. diagnostics never leak the key (presence boolean + redacted error)", async () => {
  const KEY = "SUPER_SECRET_FRED_KEY_9Z";
  configure(KEY);
  fetcherThrowing(`fetch failed for api_key=${KEY}`);
  const diag = await getEconomicCalendarDiagnostics();
  const blob = JSON.stringify(diag);
  assert.ok(!blob.includes(KEY), "raw key must never appear in diagnostics");
  assert.equal(diag.apiKeyPresent, true);
  assert.equal(typeof diag.apiKeyPresent, "boolean");
  assert.ok(diag.lastError && diag.lastError.includes("***"), "error should be redacted");
});

// ── 12. No live execution gates are touched (FRED module) ─────────────────────

test("12. fredCalendarProvider imports no execution gate / bridge / dispatch / kill switch", () => {
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
  const src = readFileSync(new URL("../fredCalendarProvider.ts", import.meta.url), "utf8");
  const importLines = src
    .split("\n")
    .filter((l) => /^\s*import\b/.test(l) || /\bfrom\s+["']/.test(l));
  for (const bad of FORBIDDEN) {
    assert.ok(
      !importLines.some((l) => l.includes(bad)),
      `fredCalendarProvider.ts must not import "${bad}" (economic calendar is read/risk-context only)`,
    );
  }
});

// ── 13. Seam honesty: FRED selected but no key ⇒ honest-empty, NEVER mock ─────

test("13. pickNewsProvider returns honest-empty FRED provider when selected but key missing", async () => {
  unconfigureNoKey();
  assert.equal(selectedEconomicCalendarProvider(), "fred");
  assert.equal(isEconomicCalendarProviderSelected(), true);
  assert.equal(isEconomicCalendarConfigured(), false);

  const provider = pickNewsProvider();
  assert.equal(provider.name, "fred"); // honest: reports FRED, not the mock.
  const events = await provider.fetchEvents(7);
  assert.equal(events.length, 0); // selected-but-unconfigured ⇒ zero fabricated rows.
});

// ── 14. pickNewsProvider returns the real FRED provider when configured ───────

test("14. pickNewsProvider returns the FRED provider and syncs real events when configured", async () => {
  configure();
  fetcherReturning([rawRelease({ release_id: "u7", release_name: "Gross Domestic Product", date: ymd(2) })]);
  const provider = pickNewsProvider();
  assert.equal(provider.name, "fred");
  const events = await provider.fetchEvents(7);
  assert.ok(events.length >= 1, "configured FRED provider should sync the real event");
});

// ── 15. Legacy default: no provider selected ⇒ mock back-compat ───────────────

test("15. pickNewsProvider falls back to mock ONLY when no provider is selected", async () => {
  delete process.env["ECONOMIC_CALENDAR_PROVIDER"];
  delete process.env["FRED_API_KEY"];
  delete process.env["TRADING_ECONOMICS_KEY"];
  delete process.env["TRADING_ECONOMICS_SECRET"];
  assert.equal(selectedEconomicCalendarProvider(), null);
  assert.equal(isEconomicCalendarProviderSelected(), false);
  const provider = pickNewsProvider();
  assert.equal(provider.name, "mock");
});

// ── 16. FRED honesty: no clock time / forecast / actual is ever fabricated ────

test("16. normalize emits null forecast/actual/previous/importance + null local time + date sentinel", () => {
  const now = Date.UTC(2030, 0, 1);
  const events = normalizeFredReleaseDates(
    [{ release_id: "9", release_name: "Consumer Price Index", date: "2030-01-03" }],
    { nowMs: now, daysAhead: 7, freshness: "LIVE" },
  );
  assert.equal(events.length, 1);
  const e = events[0]!;
  assert.equal(e.provider, "fred");
  assert.equal(e.source, "FRED");
  assert.equal(e.currency, "USD");
  assert.equal(e.impact, "high");
  assert.equal(e.eventTimeUtc, "2030-01-03T00:00:00.000Z"); // date-granularity sentinel
  assert.equal(e.eventTimeLocal, null); // never a guessed clock time
  assert.equal(e.forecast, null); // FRED carries no forecast
  assert.equal(e.actual, null); // never fabricated
  assert.equal(e.previous, null);
  assert.equal(e.importance, null); // FRED carries no numeric importance
});

// ── 17. Curation drops unrecognized series; window drops out-of-range dates ────

test("17. normalize drops unclassified releases and out-of-window dates", () => {
  const now = Date.UTC(2030, 0, 1);
  const events = normalizeFredReleaseDates(
    [
      { release_id: "1", release_name: "Consumer Price Index", date: "2030-01-03" }, // classified, in window
      { release_id: "2", release_name: "Commercial Paper Outstanding", date: "2030-01-03" }, // unclassified ⇒ drop
      { release_id: "3", release_name: "Employment Situation", date: "2030-03-01" }, // classified but far out of 7-day window ⇒ drop
      { release_id: "4", release_name: "Producer Price Index", date: "not-a-date" }, // malformed ⇒ drop
    ],
    { nowMs: now, daysAhead: 7, freshness: "LIVE" },
  );
  assert.equal(events.length, 1);
  assert.equal(events[0]!.title, "Consumer Price Index");
});

// ── 18. Unexpected payload (FRED error object, no array) ⇒ honest error ────────

test("18. unexpected payload (no release_dates array) ⇒ status error, never silent empty", async () => {
  configure();
  fetcherReturningRaw(JSON.stringify({ error_code: 400, error_message: "Bad Request. Variable api_key is invalid." }));
  const r = await getEconomicCalendarResult({ forceRefresh: true });
  assert.equal(r.status, "error");
  assert.equal(r.connected, false);
  assert.equal(r.configured, true);
  assert.match(r.message.toLowerCase(), /provider error/);
});

// ── 19. Enriched events: missing key ⇒ honest empty, provider "none" ──────────

test("19. enriched events: missing key ⇒ connected=false, provider 'none', zero events", async () => {
  unconfigureNoKey();
  const r = await getEnrichedCalendarEvents("EURUSD");
  assert.equal(r.connected, false);
  // Provider-agnostic honesty: unconfigured ⇒ "none", never a fabricated schedule.
  assert.equal(r.provider, "none");
  assert.equal(r.events.length, 0);
  assert.equal(r.liveness.freshnessStatus, "unavailable");
});

// ── 20. Enriched events: provider error ⇒ honest empty, NOT all-clear ─────────

test("20. enriched events: provider error ⇒ connected=false, zero events, error surfaced", async () => {
  configure();
  fetcherHttpError(503);
  const r = await getEnrichedCalendarEvents("EURUSD");
  assert.equal(r.connected, false);
  // The SELECTED provider is still reported (configured) — honest fetch_error.
  assert.equal(r.provider, "fred");
  assert.equal(r.events.length, 0);
  assert.equal(r.liveness.freshnessStatus, "unavailable");
  assert.ok(r.liveness.lastErrorAt !== null, "an error timestamp must be present");
  assert.ok(r.liveness.lastErrorMessage !== null, "an error message must be present");
});

// ── 21. Enriched events: connected + real events, provider-agnostic mapping ───

test("21. enriched events: connected ⇒ provider 'fred', mapped FE shape, FRED honesty preserved", async () => {
  configure();
  fetcherReturning([rawRelease({ release_id: "u8", release_name: "Consumer Price Index", date: ymd(2) })]);
  const r = await getEnrichedCalendarEvents("EURUSD");
  assert.equal(r.connected, true);
  assert.equal(r.provider, "fred");
  assert.ok(r.events.length >= 1);
  const e = r.events[0]!;
  assert.equal(e.currency, "USD");
  assert.ok(["low", "medium", "high"].includes(e.impact)); // critical collapses to high
  assert.equal(e.source, "FRED"); // free-form provider source, never hardcoded TE
  assert.equal(e.forecast, null); // FRED dates-only honesty preserved end to end
  assert.equal(e.previous, null);
  assert.equal(e.actual, null);
  assert.equal(e.eventTimeLocal, null); // never a guessed clock time
  assert.equal(e.eventTimeIso, e.eventTimeUtc);
  assert.ok(!Number.isNaN(Date.parse(e.eventTimeUtc)));
  assert.ok(Array.isArray(e.affectedMarkets));
  assert.equal(r.liveness.freshnessStatus, "fresh");
});

// ── 22. Enriched events: connected + zero classifiable ⇒ empty (never faked) ──

test("22. enriched events: connected + zero classifiable ⇒ connected=true, zero events", async () => {
  configure();
  fetcherReturning([
    rawRelease({ release_id: "x1", release_name: "Commercial Paper Outstanding", date: ymd(1) }),
  ]);
  const r = await getEnrichedCalendarEvents("EURUSD");
  assert.equal(r.connected, true); // reachable
  assert.equal(r.events.length, 0); // honest "no relevant events"
});

// ── 23. Enriched filters: currency + impact + synthetic scope ────────────────

test("23. enriched filters: currency / impact narrow the list; synthetics get zero", async () => {
  configure();
  fetcherReturning([
    rawRelease({ release_id: "f1", release_name: "Employment Situation", date: ymd(1) }), // USD high
    rawRelease({ release_id: "f2", release_name: "Euro Short-Term Rate", date: ymd(2) }), // EUR low
  ]);
  const usdOnly = await getEnrichedCalendarEvents("EURUSD", Date.now(), 14 * 86400_000, {
    currencies: ["USD"],
  });
  assert.ok(usdOnly.events.length >= 1);
  assert.ok(usdOnly.events.every((e) => e.currency === "USD"));

  const highOnly = await getEnrichedCalendarEvents("EURUSD", Date.now(), 14 * 86400_000, {
    impact: "high",
  });
  assert.ok(highOnly.events.every((e) => e.impact === "high"));

  // Synthetic symbol ⇒ macro N/A ⇒ zero, even with real rows present.
  const synth = await getEnrichedCalendarEvents("R_75", Date.now(), 14 * 86400_000, {});
  assert.equal(synth.events.length, 0);
});

// ── 24. Health snapshot: provider-agnostic, honest across all states ──────────

test("24. health snapshot reports SELECTED provider + honest liveness across states", async () => {
  // Missing key ⇒ not configured, provider "none".
  unconfigureNoKey();
  const missing = await getCalendarHealthSnapshot();
  assert.equal(missing.configured, false);
  assert.equal(missing.connected, false);
  assert.equal(missing.provider, "none");
  assert.equal(missing.freshnessStatus, "unavailable");

  // Fetch error ⇒ configured but not connected, error surfaced, NOT all-clear.
  __resetEconomicCalendarStateForTests();
  configure();
  fetcherHttpError(500);
  const errored = await getCalendarHealthSnapshot();
  assert.equal(errored.configured, true);
  assert.equal(errored.connected, false);
  assert.equal(errored.provider, "fred");
  assert.ok(errored.lastErrorAt !== null);
  assert.equal(errored.freshnessStatus, "unavailable");

  // Connected ⇒ provider reported, fresh, eventCount tracked.
  __resetEconomicCalendarStateForTests();
  fetcherReturning([rawRelease({ release_id: "h1", release_name: "Consumer Price Index", date: ymd(2) })]);
  const ok = await getCalendarHealthSnapshot();
  assert.equal(ok.configured, true);
  assert.equal(ok.connected, true);
  assert.equal(ok.provider, "fred");
  assert.equal(ok.freshnessStatus, "fresh");
  assert.ok(ok.eventCount >= 1);
  assert.equal(ok.lastErrorAt, null);
  assert.equal(ok.lastErrorMessage, null);
});
