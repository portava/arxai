// Task #638 — regression safety-net for the legacy Economic Calendar page route
// `GET /api/economic-calendar/events`. Run via:
//   pnpm --filter @workspace/api-server run test:economic-calendar-route
//
// This drives the REAL newsCalendar router over HTTP and locks the page-level
// contract that a future refactor must never silently break:
//
//   (1) The route resolves the provider CENTRALLY through the provider-agnostic
//       `getEnrichedCalendarEvents` → `getEconomicCalendarResult` seam — it
//       reports `provider:"fred"` when FRED is the selected provider, and
//       `provider:"trading_economics"` when TE is selected. It is NOT hardcoded
//       to one provider (the TE-first / FRED-fallback resolution path is live).
//   (2) Honest states, never fabricated:
//         - FRED connected + real rows  ⇒ connected:true, eventCount>0, real events
//         - FRED connected + zero rows  ⇒ connected:true, eventCount:0 (NOT "not configured")
//         - FRED configured + fetch err ⇒ connected:false, error surfaced, zero events
//         - no provider configured      ⇒ configured:false, provider:"none", zero events
//       In every non-connected case the event list is empty — the page never
//       shows a fabricated macro event, forecast, or actual.
//
// The HTTP fetch is injected (`__setEconomicCalendarFetcherForTests`) so nothing
// touches the network; the shared service cache/telemetry is reset around every
// test. The economic calendar is read/risk-context only — the final test proves
// the route module imports no execution gate / MT5 bridge / broker dispatch /
// kill switch. This test imports `@workspace/db` (via the router) so it runs in
// the integration lane; it issues NO database query of its own.

import { test, before, after, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import express from "express";
import { readFileSync } from "node:fs";
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import {
  __setEconomicCalendarFetcherForTests,
  __resetEconomicCalendarStateForTests,
} from "../../lib/news/calendar/economicCalendarService.js";

const calendarRouter = (await import("../newsCalendar.js")).default;

// ── Response shape returned by GET /economic-calendar/events ────────────────
interface CalendarRouteResponse {
  connected: boolean;
  provider: string;
  configured: boolean;
  eventCount: number;
  lastFetchAt: string | null;
  lastErrorAt: string | null;
  lastErrorMessage: string | null;
  freshnessStatus: "fresh" | "stale" | "unavailable";
  events: Array<{
    currency: string;
    impact: string;
    source: string;
    forecast: string | null;
    actual: string | null;
    eventTimeUtc: string;
  }>;
}

// ── Env helpers ──────────────────────────────────────────────────────────────
const ENV_KEYS = [
  "ECONOMIC_CALENDAR_PROVIDER",
  "FRED_API_KEY",
  "TRADING_ECONOMICS_KEY",
  "TRADING_ECONOMICS_SECRET",
] as const;

let envSnapshot: Record<string, string | undefined> = {};

function configureFred(key = "fred-key-route-test"): void {
  process.env["ECONOMIC_CALENDAR_PROVIDER"] = "fred";
  process.env["FRED_API_KEY"] = key;
  delete process.env["TRADING_ECONOMICS_KEY"];
  delete process.env["TRADING_ECONOMICS_SECRET"];
}

function configureTradingEconomics(key = "te-key-route-test"): void {
  process.env["ECONOMIC_CALENDAR_PROVIDER"] = "trading_economics";
  process.env["TRADING_ECONOMICS_KEY"] = key;
  delete process.env["FRED_API_KEY"];
  delete process.env["TRADING_ECONOMICS_SECRET"];
}

function configureNoProvider(): void {
  delete process.env["ECONOMIC_CALENDAR_PROVIDER"];
  delete process.env["FRED_API_KEY"];
  delete process.env["TRADING_ECONOMICS_KEY"];
  delete process.env["TRADING_ECONOMICS_SECRET"];
}

// ── Fetcher helpers ──────────────────────────────────────────────────────────
/** Wrap rows in the FRED `{ release_dates: [...] }` envelope. */
function fredFetcherReturning(rows: unknown): void {
  __setEconomicCalendarFetcherForTests(async () => ({
    ok: true,
    status: 200,
    text: async () => JSON.stringify({ release_dates: rows }),
  }));
}

function fetcherHttpError(status = 503): void {
  __setEconomicCalendarFetcherForTests(async () => ({
    ok: false,
    status,
    text: async () => "upstream unavailable",
  }));
}

/** YYYY-MM-DD offset days from now (FRED is date-granularity only). */
function ymd(offsetDays: number): string {
  return new Date(Date.now() + offsetDays * 86_400_000).toISOString().slice(0, 10);
}

function fredRelease(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    release_id: "10",
    release_name: "Employment Situation", // USD high-impact in the classifier.
    date: ymd(2),
    ...over,
  };
}

// ── Server lifecycle ─────────────────────────────────────────────────────────
let server: Server;
let base: string;

before(async () => {
  const app = express();
  app.use(express.json());
  app.use("/api", calendarRouter);
  await new Promise<void>((resolve) => {
    server = app.listen(0, () => resolve());
  });
  const { port } = server.address() as AddressInfo;
  base = `http://127.0.0.1:${port}`;
});

after(async () => {
  await new Promise<void>((resolve, reject) =>
    server.close((e) => (e ? reject(e) : resolve())),
  );
});

beforeEach(() => {
  envSnapshot = {};
  for (const k of ENV_KEYS) envSnapshot[k] = process.env[k];
  __resetEconomicCalendarStateForTests();
  __setEconomicCalendarFetcherForTests(null);
});

afterEach(() => {
  for (const k of ENV_KEYS) {
    if (envSnapshot[k] === undefined) delete process.env[k];
    else process.env[k] = envSnapshot[k];
  }
  __resetEconomicCalendarStateForTests();
  __setEconomicCalendarFetcherForTests(null);
});

async function getEvents(query = ""): Promise<{ status: number; body: CalendarRouteResponse }> {
  const res = await fetch(`${base}/api/economic-calendar/events${query}`);
  const body = (await res.json()) as CalendarRouteResponse;
  return { status: res.status, body };
}

// ── 1. FRED configured + real events ⇒ provider "fred", real non-empty events ─
test("FRED configured + real events ⇒ provider 'fred', connected, real events (never fabricated)", async () => {
  configureFred();
  fredFetcherReturning([
    fredRelease({ release_id: "u1", release_name: "Employment Situation", date: ymd(1) }),
    fredRelease({ release_id: "u2", release_name: "Consumer Price Index", date: ymd(2) }),
  ]);
  const { status, body } = await getEvents();
  assert.equal(status, 200);
  // Provider resolved centrally to the SELECTED provider — never hardcoded.
  assert.equal(body.provider, "fred");
  assert.equal(body.configured, true);
  assert.equal(body.connected, true);
  assert.equal(body.freshnessStatus, "fresh");
  assert.ok(body.eventCount >= 1, "real FRED rows must surface as events");
  assert.equal(body.eventCount, body.events.length, "eventCount must match the event list");
  // The events are genuinely FRED-sourced and carry FRED's dates-only honesty.
  for (const e of body.events) {
    assert.equal(e.source, "FRED", "events must report the real FRED source, never a hardcoded provider");
    assert.equal(e.forecast, null, "FRED carries no forecast — never fabricated");
    assert.equal(e.actual, null, "FRED carries no actual — never fabricated");
    assert.ok(["low", "medium", "high"].includes(e.impact));
    assert.ok(!Number.isNaN(Date.parse(e.eventTimeUtc)));
  }
});

// ── 2. FRED configured + zero classifiable rows ⇒ honest empty, NOT not-configured ─
test("FRED configured + zero classifiable rows ⇒ connected:true, eventCount:0 (honest empty)", async () => {
  configureFred();
  // Real FRED rows the curated classifier does not recognize ⇒ all dropped.
  fredFetcherReturning([
    fredRelease({ release_id: "x1", release_name: "Commercial Paper Outstanding", date: ymd(1) }),
  ]);
  const { status, body } = await getEvents();
  assert.equal(status, 200);
  assert.equal(body.provider, "fred");
  assert.equal(body.configured, true, "a reachable provider with zero events is still CONFIGURED");
  assert.equal(body.connected, true, "provider reachable ⇒ connected, even with no relevant events");
  assert.equal(body.eventCount, 0);
  assert.equal(body.events.length, 0, "honest empty — never a fabricated event");
});

// ── 3. FRED configured + fetch error ⇒ honest fetch_error, never all-clear ────
test("FRED configured + fetch error ⇒ connected:false, error surfaced, zero events", async () => {
  configureFred();
  fetcherHttpError(503);
  const { status, body } = await getEvents();
  assert.equal(status, 200);
  // The SELECTED provider is still reported (configured) — honest fetch_error.
  assert.equal(body.provider, "fred");
  assert.equal(body.configured, true);
  assert.equal(body.connected, false);
  assert.equal(body.eventCount, 0);
  assert.equal(body.events.length, 0, "a failed fetch must never fabricate events");
  assert.equal(body.freshnessStatus, "unavailable");
  assert.ok(body.lastErrorAt !== null, "an error timestamp must be present");
  assert.ok(body.lastErrorMessage !== null, "an error message must be present");
});

// ── 4. No provider configured ⇒ honest not-configured (provider "none") ───────
test("no provider configured ⇒ configured:false, provider 'none', zero events", async () => {
  configureNoProvider();
  const { status, body } = await getEvents();
  assert.equal(status, 200);
  assert.equal(body.configured, false);
  assert.equal(body.connected, false);
  assert.equal(body.provider, "none");
  assert.equal(body.eventCount, 0);
  assert.equal(body.events.length, 0, "not-configured must show an honest empty state, never fabricated events");
  assert.equal(body.freshnessStatus, "unavailable");
});

// ── 5. Provider-agnostic: TE selected ⇒ provider "trading_economics" ──────────
// Proves the route does NOT hardcode FRED — when Trading Economics is the
// selected provider, the SAME central resolution path reports it. A failing
// fetcher keeps this hermetic (TE payload internals are covered separately) while
// still proving the selected provider is surfaced honestly under a fetch error.
test("Trading Economics selected ⇒ provider 'trading_economics' (resolution not hardcoded to FRED)", async () => {
  configureTradingEconomics();
  fetcherHttpError(503);
  const { status, body } = await getEvents();
  assert.equal(status, 200);
  assert.equal(body.provider, "trading_economics");
  assert.equal(body.configured, true);
  assert.equal(body.connected, false);
  assert.equal(body.events.length, 0);
});

// ── 6. Filters narrow the event list without fabricating ─────────────────────
test("currency + impact filters narrow the FRED event list (no fabrication)", async () => {
  configureFred();
  fredFetcherReturning([
    fredRelease({ release_id: "f1", release_name: "Employment Situation", date: ymd(1) }), // USD high
    fredRelease({ release_id: "f2", release_name: "Euro Short-Term Rate", date: ymd(2) }), // EUR low
  ]);
  const usdOnly = await getEvents("?currencies=USD&daysAhead=14");
  assert.equal(usdOnly.body.connected, true);
  assert.ok(usdOnly.body.eventCount >= 1);
  assert.ok(usdOnly.body.events.every((e) => e.currency === "USD"), "currency filter must scope to USD");

  __resetEconomicCalendarStateForTests();
  fredFetcherReturning([
    fredRelease({ release_id: "h1", release_name: "Employment Situation", date: ymd(1) }), // USD high
    fredRelease({ release_id: "h2", release_name: "Euro Short-Term Rate", date: ymd(2) }), // EUR low
  ]);
  const highOnly = await getEvents("?impact=high&daysAhead=14");
  assert.ok(highOnly.body.events.every((e) => e.impact === "high"), "impact filter must scope to high");
});

// ── 7. Malformed date range ⇒ 400 BEFORE any provider call ───────────────────
test("inverted from/to range ⇒ 400, rejected before any provider fetch", async () => {
  configureFred();
  let fetchCalls = 0;
  __setEconomicCalendarFetcherForTests(async () => {
    fetchCalls += 1;
    return { ok: true, status: 200, text: async () => JSON.stringify({ release_dates: [fredRelease()] }) };
  });
  const res = await fetch(`${base}/api/economic-calendar/events?from=2025-02-01&to=2025-01-01`);
  assert.equal(res.status, 400);
  assert.equal(fetchCalls, 0, "an invalid date range must short-circuit before the provider is ever called");
});

// ── 8. The route module touches no execution path (read/risk-context only) ────
test("newsCalendar.ts imports no execution gate / bridge / dispatch / kill switch", () => {
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
  const src = readFileSync(new URL("../newsCalendar.ts", import.meta.url), "utf8");
  const importLines = src
    .split("\n")
    .filter((l) => /^\s*import\b/.test(l) || /\bfrom\s+["']/.test(l));
  for (const bad of FORBIDDEN) {
    assert.ok(
      !importLines.some((l) => l.includes(bad)),
      `newsCalendar.ts must not import "${bad}" (economic calendar is read/risk-context only)`,
    );
  }
});
