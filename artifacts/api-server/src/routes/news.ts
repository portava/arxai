import { Router, type Response } from "express";
import { GetEconomicCalendarQueryParams } from "@workspace/api-zod";
import { getEconomicCalendarResult } from "../lib/news/calendar/economicCalendarService.js";
import { toMockShapeEvents } from "../lib/news/calendar/calendarAdapters.js";
import type { EconomicCalendarResult } from "../lib/news/calendar/calendarTypes.js";

const router = Router();

// ── Calendar read state ──────────────────────────────────────────────────
// GET /news/calendar returns [] both when the provider listed nothing and when
// it could not be read at all. An empty list is only "no events" when the
// provider was actually read (connected). The array body is kept for existing
// consumers; the read state rides along as response headers, and
// GET /news/calendar/envelope returns the same events with that state in one
// read, so no consumer has to cross-check a second endpoint.

const PROVIDER_LABELS: Record<string, string> = { fred: "FRED", trading_economics: "Trading Economics" };
function providerLabel(provider: string): string {
  if (!provider || provider === "none") return "The calendar provider";
  return PROVIDER_LABELS[provider] ?? provider;
}

export interface CalendarReadState {
  /** True only when a connected provider was read: an empty list then means none listed. */
  read: boolean;
  status: EconomicCalendarResult["status"];
  provider: string;
  configured: boolean;
  /** When the served events were fetched from the provider (ISO); null when not read. */
  eventsAsOf: string | null;
  /** When this request checked (ISO). */
  checkedAt: string;
  /** Plain-English reason the calendar was not read; null when it was. */
  note: string | null;
}

export function calendarReadState(result: EconomicCalendarResult, nowMs: number): CalendarReadState {
  const read = result.connected === true && (result.status === "ok" || result.status === "empty");
  const cacheAgeMs = result.diagnostics?.cacheAgeMs;
  const eventsAsOf = read && typeof cacheAgeMs === "number" && Number.isFinite(cacheAgeMs) && cacheAgeMs >= 0
    ? new Date(nowMs - cacheAgeMs).toISOString()
    : null;
  const notAllClear = "This is not an all-clear.";
  const note = read
    ? null
    : !result.configured || result.status === "missing"
      ? `No economic calendar provider is configured, so scheduled events were not checked. ${notAllClear}`
      : `${providerLabel(result.provider)} could not be read, so scheduled events were not checked. ${notAllClear}`;
  return {
    read,
    status: result.status,
    provider: result.provider,
    configured: result.configured,
    eventsAsOf,
    checkedAt: new Date(nowMs).toISOString(),
    note,
  };
}

function setCalendarReadHeaders(res: Response, state: CalendarReadState): void {
  // ASCII-only values; the plain-English note is in the envelope route.
  res.setHeader("X-Calendar-Read", state.read ? "true" : "false");
  res.setHeader("X-Calendar-Status", state.status);
  res.setHeader("X-Calendar-Provider", state.provider || "none");
  res.setHeader("X-Calendar-Checked-At", state.checkedAt);
  if (state.eventsAsOf) res.setHeader("X-Calendar-Events-As-Of", state.eventsAsOf);
}

async function readCalendar(query: Record<string, unknown>) {
  const q = GetEconomicCalendarQueryParams.parse({
    currency: query["currency"],
    impact: query["impact"],
    days: query["days"] ? Number(query["days"]) : 7,
  });
  const days = q.days ?? 7;
  // Honest-or-empty, unconditionally: the real shared calendar service is the
  // ONLY source. Missing/errored provider ⇒ [] (Theme A1). The former "no
  // provider selected ⇒ mock generator" back-compat branch fabricated a full
  // FOMC/CPI/NFP schedule at invented times on every unconfigured deployment,
  // so it is gone rather than narrowed.
  const result = await getEconomicCalendarResult({ daysAhead: days });
  const state = calendarReadState(result, Date.now());
  let events = state.read ? toMockShapeEvents(result.events) : [];
  if (q.currency) events = events.filter((e) => e.currency === q.currency);
  if (q.impact) events = events.filter((e) => e.impact === q.impact);
  return { events, state, days };
}

// NOTE (Theme G-CUT): the sweep listed BOTH legacy /news routes as "no frontend
// consumer". That is true of /news/risk, which is deleted here — but NOT of
// /news/calendar, which backs two live surfaces via useGetEconomicCalendar:
// the Economic Calendar page (pages/calendar.tsx) and the cockpit's critical
// events card (CockpitCards.tsx). Theme H5 also names the Economic Calendar as
// the calendar surface to KEEP, so cutting this route would have broken the
// very page the consolidation preserves. It stays.
router.get("/news/calendar", async (req, res) => {
  try {
    const { events, state } = await readCalendar(req.query as Record<string, unknown>);
    setCalendarReadHeaders(res, state);
    res.json(events);
  } catch (err) {
    req.log.error(err);
    res.status(400).json({ error: "Invalid calendar request" });
  }
});

// Same events as /news/calendar, with the calendar read state in the body.
router.get("/news/calendar/envelope", async (req, res) => {
  try {
    const { events, state, days } = await readCalendar(req.query as Record<string, unknown>);
    setCalendarReadHeaders(res, state);
    res.json({ ...state, windowDays: days, events });
  } catch (err) {
    req.log.error(err);
    res.status(400).json({ error: "Invalid calendar request" });
  }
});

export default router;
