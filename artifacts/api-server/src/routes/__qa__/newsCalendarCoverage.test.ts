// GET /news/calendar — an empty list must say whether the calendar was read.
//
// The route returns a bare array, and returns [] both when the provider
// listed nothing and when it could not be read at all (no provider
// configured, or a failing fetch). Every consumer except the one dashboard
// page that cross-checks a second endpoint read [] as "no events".
//
// The array body is kept for existing consumers; the provider/coverage state
// rides along additively as response headers, and GET /news/calendar/envelope
// returns the same events with that state in one read.
//
// Only the shared calendar service is stubbed; the real router runs. No network.
//
// Run: node --import tsx --experimental-test-module-mocks --test --test-force-exit \
//        src/routes/__qa__/newsCalendarCoverage.test.ts

import { mock, test } from "node:test";
import assert from "node:assert/strict";
import type { Request, Response } from "express";

type Result = {
  status: "ok" | "empty" | "missing" | "error";
  connected: boolean; configured: boolean; provider: string;
  events: unknown[];
  diagnostics: { cacheAgeMs: number | null; lastSuccessAt: string | null };
  message: string;
};
let result: Result;
const service = await import("../../lib/news/calendar/economicCalendarService.js");
mock.module("../../lib/news/calendar/economicCalendarService.js", {
  namedExports: { ...service, getEconomicCalendarResult: async () => result },
});

const { default: router } = await import("../news.js");

async function invoke(path: string, query: Record<string, string> = {}): Promise<{ status: number; body: any; headers: Record<string, string> }> {
  const layer = (router as any).stack.find((l: any) => l.route?.path === path);
  assert.ok(layer, `missing route ${path}`);
  let status = 200;
  let body: any;
  const headers: Record<string, string> = {};
  const response = {
    status(n: number) { status = n; return this; },
    json(data: unknown) { body = data; return this; },
    setHeader(k: string, v: string) { headers[k.toLowerCase()] = String(v); return this; },
    set(k: string, v: string) { headers[k.toLowerCase()] = String(v); return this; },
  };
  const request = { query, params: {}, log: { error: () => {} } };
  const handlers = layer.route.stack;
  await handlers[handlers.length - 1].handle(request as unknown as Request, response as unknown as Response, () => {});
  return { status, body, headers };
}

const event = {
  id: "te-1", title: "Non-Farm Payrolls", country: "United States", currency: "USD", impact: "high",
  actual: null, forecast: "180K", previous: "175K", eventTimeUtc: "2026-10-30T12:30:00.000Z",
  affectedSymbols: ["EURUSD"], source: "trading_economics", freshness: "LIVE",
};

test("no provider configured: [] body, but the headers say the calendar was not read", async () => {
  result = { status: "missing", connected: false, configured: false, provider: "none", events: [], diagnostics: { cacheAgeMs: null, lastSuccessAt: null }, message: "" };
  const { status, body, headers } = await invoke("/news/calendar");
  assert.equal(status, 200);
  assert.deepEqual(body, [], "array consumers keep their shape");
  assert.equal(headers["x-calendar-read"], "false");
  assert.equal(headers["x-calendar-status"], "missing");
  assert.equal(headers["x-calendar-provider"], "none");
});

test("a failing provider: not read, and the envelope says so in plain English", async () => {
  result = { status: "error", connected: false, configured: true, provider: "trading_economics", events: [event], diagnostics: { cacheAgeMs: 900_000, lastSuccessAt: null }, message: "" };
  const arr = await invoke("/news/calendar");
  assert.deepEqual(arr.body, [], "stale last-good events are never served as current");
  assert.equal(arr.headers["x-calendar-read"], "false");
  const env = await invoke("/news/calendar/envelope");
  assert.equal(env.status, 200);
  assert.deepEqual(env.body.events, []);
  assert.equal(env.body.read, false);
  assert.equal(env.body.status, "error");
  assert.match(env.body.note, /Trading Economics could not be read, so scheduled events were not checked/);
  assert.match(env.body.note, /not an all-clear/);
});

test("a connected provider that listed nothing: read, and empty means none listed", async () => {
  result = { status: "empty", connected: true, configured: true, provider: "fred", events: [], diagnostics: { cacheAgeMs: 0, lastSuccessAt: null }, message: "" };
  const { body, headers } = await invoke("/news/calendar");
  assert.deepEqual(body, []);
  assert.equal(headers["x-calendar-read"], "true");
  const env = await invoke("/news/calendar/envelope");
  assert.equal(env.body.read, true);
  assert.equal(env.body.note, null);
  assert.equal(typeof env.body.checkedAt, "string");
});

test("a cached read reports when the events were fetched, not the request time", async () => {
  result = { status: "ok", connected: true, configured: true, provider: "trading_economics", events: [event], diagnostics: { cacheAgeMs: 120_000, lastSuccessAt: null }, message: "" };
  const before = Date.now();
  const env = await invoke("/news/calendar/envelope");
  assert.equal(env.body.events.length, 1);
  assert.equal(env.body.events[0].title, "Non-Farm Payrolls");
  const asOf = Date.parse(env.body.eventsAsOf);
  assert.ok(asOf <= before - 119_000 && asOf >= before - 125_000, `eventsAsOf ${env.body.eventsAsOf} is the fetch time`);
  const arr = await invoke("/news/calendar");
  const headerAsOf = Date.parse(arr.headers["x-calendar-events-as-of"] ?? "");
  assert.ok(headerAsOf <= before - 119_000 && headerAsOf >= before - 125_000, "the array route's header carries the same fetch time");
  assert.equal(arr.headers["x-calendar-read"], "true");
});

test("a failing provider's note names the (redacted) error the service recorded", async () => {
  result = {
    status: "error", connected: false, configured: true, provider: "trading_economics", events: [],
    diagnostics: { cacheAgeMs: null, lastSuccessAt: null, lastError: "HTTP 503" } as Result["diagnostics"], message: "",
  };
  const env = await invoke("/news/calendar/envelope");
  assert.equal(env.body.read, false);
  assert.match(env.body.note, /Trading Economics could not be read \(HTTP 503\), so scheduled events were not checked/);
  assert.match(env.body.note, /not an all-clear/);
});
