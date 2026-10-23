---
name: FRED economic-calendar provider wiring
description: How FRED is wired behind the provider-agnostic economic-calendar seam, and why its normalize/test shape differs from Trading Economics.
---

# FRED behind the central economic-calendar seam

The economic calendar is provider-agnostic behind one central service
(`getEconomicCalendarResult`). Provider selection: **Trading Economics takes
precedence** (when its key resolves) **then FRED**. FRED is active when
`ECONOMIC_CALENDAR_PROVIDER="fred"` AND `FRED_API_KEY` is present. All consumer
seams (Market Heat `readCalendarProvider`, impact-radar `getEconomicCalendar`,
Ruby `withTradingEconomicsCalendar` which gates on the now-provider-aware
`isEconomicCalendarConfigured`) flow through this one service, so wiring a new
provider there lights up every surface at once.

## FRED is dates-only — the honesty consequences
**Rule:** FRED `releases/dates` returns a release NAME + a release DATE and
nothing else — no clock time, no forecast, no actual, no previous, no numeric
importance. Normalize MUST leave all of those `null`, set `eventTimeLocal:null`,
and stamp the date at a `T00:00:00.000Z` sentinel. Currency/country/impact come
ONLY from a curated `release_name` regex classifier; **unrecognized releases are
dropped** (honest curation, never a fabricated event).
**Why:** fabricating a forecast/clock-time to match the richer TE shape would be
a safety-honesty violation in this app.

## FRED MUST client-window-filter; TE must NOT
**Rule:** TE bounds its window server-side via URL date params, so its
`normalize` keeps every returned row (TE tests use fixed far-future dates like
`2030-01-15` and they survive). FRED's `releases/dates` cannot bound release-date
server-side (realtime params filter the realtime period, not the release date),
so FRED `normalize` applies a client-side `[now, now+daysAhead]` YMD window
filter.
**How to apply:** in FRED tests, generate release dates **relative to now**
(e.g. `now + 1..3 days`) so the seams called with the real `now` + default
7-day horizon include them. Copying TE's fixed-2030 fixture dates makes every
"shows events" FRED test silently return empty.

## Test-fixture gotchas
- The empty/"no relevant events" case needs release names that match **no**
  classifier regex (e.g. "Commercial Paper Outstanding"). "Sticky Price
  Consumer Price Index Diffusion" looks unclassified but contains "Consumer
  Price Index" and matches → row survives → status `ok` not `empty`.
- Selecting FRED in a test requires clearing `TRADING_ECONOMICS_KEY`/`_SECRET`
  (TE precedence) in addition to setting `ECONOMIC_CALENDAR_PROVIDER=fred`.

## Scope left open (Path B)
The legacy calendar **page** route (`/economic-calendar/events`) + its
TE-specific adapter in `economicCalendarProvider.ts` (`getCalendarEventsEnriched`
/ `isCalendarProviderEnabled`) were NOT made FRED-aware; under FRED they honestly
report not-configured. Tracked as a follow-up.
