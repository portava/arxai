import { Router } from "express";
import { GetEconomicCalendarQueryParams } from "@workspace/api-zod";
import { getMockEvents } from "../lib/news/calendar/economicEvents.js";
import {
  getEconomicCalendarResult,
  isEconomicCalendarProviderSelected,
} from "../lib/news/calendar/economicCalendarService.js";
import { toMockShapeEvents } from "../lib/news/calendar/calendarAdapters.js";

const router = Router();

// NOTE (Theme G-CUT): the sweep listed BOTH legacy /news routes as "no frontend
// consumer". That is true of /news/risk, which is deleted here — but NOT of
// /news/calendar, which backs two live surfaces via useGetEconomicCalendar:
// the Economic Calendar page (pages/calendar.tsx) and the cockpit's critical
// events card (CockpitCards.tsx). Theme H5 also names the Economic Calendar as
// the calendar surface to KEEP, so cutting this route would have broken the
// very page the consolidation preserves. It stays.
//
// Its remaining mock fallback (the `else` branch below) is fixed separately on
// the Theme A branch, which makes this route honest-or-empty unconditionally.
router.get("/news/calendar", async (req, res) => {
  try {
    const q = GetEconomicCalendarQueryParams.parse({
      currency: req.query["currency"],
      impact: req.query["impact"],
      days: req.query["days"] ? Number(req.query["days"]) : 7,
    });
    const days = q.days ?? 7;
    // When Trading Economics is the SELECTED provider, serve the real shared
    // calendar service (honest-or-empty: missing/error ⇒ [] — NEVER mock). The
    // mock generator is back-compat ONLY when no provider is selected (true
    // legacy default), so a selected-but-unconfigured TE never fabricates events.
    let events;
    if (isEconomicCalendarProviderSelected()) {
      const result = await getEconomicCalendarResult({ daysAhead: days });
      events = result.connected ? toMockShapeEvents(result.events) : [];
    } else {
      events = getMockEvents(days);
    }
    if (q.currency) events = events.filter((e) => e.currency === q.currency);
    if (q.impact) events = events.filter((e) => e.impact === q.impact);
    res.json(events);
  } catch (err) {
    req.log.error(err);
    res.status(400).json({ error: "Invalid calendar request" });
  }
});

export default router;
