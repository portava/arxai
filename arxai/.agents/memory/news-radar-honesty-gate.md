---
name: News radar honesty gate
description: Why a Market Impact Radar must gate events on a connected REAL calendar, not surface an "honestly-labeled" mock schedule.
---

# News radar / economic-calendar honesty

An "honestly-labeled" mock economic calendar is STILL mock-as-real the moment its
events are surfaced as actionable (severity badges, Critical/High toast alerts,
behavior that colors the read). Provider notes saying "built-in schedule" are not
enough — a trader can act on a fabricated "FOMC in 10 min" alert.

**Rule:** the radar emits events ONLY from a connected, real economic-calendar
provider. With none wired, return `events: []` + an honest provider.note (e.g.
"no live economic-calendar provider configured — none are fabricated") and
`NO_PROVIDER` behavior. Mirror the reserved `mt5_broker` market-data slot: feed
`rawEvents` + `calendarConnected:true` the moment a real provider (Trading
Economics / FRED) is connected, zero other changes.

**Why:** `getMockEvents` in `calendar/economicEvents.ts` fabricates forecast
numbers, schedules FOMC every few days (impossible), and back-fills `actual` from
forecast for past events. The canonical `newsIntelligenceService` already labels
its calendar `connected:false, provider:"mock_economic_calendar"` — so read THAT
flag (`pack.dataSources.calendar.connected`), not the headlines connection, to
decide whether the radar may show events. Tying provider.connected to headlines
let mock events through.

**How to apply:** enforce the gate in a PURE builder (`buildRadarEvents` in
`lib/domain/src/smart-chart/smartChartLayers.ts`) that hard-returns `[]` when
`calendarConnected` is false regardless of `rawEvents`, so a CI guard test can
prove "disconnected ⇒ zero events ⇒ no actionable alert". Synthetic instruments
(Volatility/Crash/Boom/R_n/1s) always `affectsSymbol:false`.

**Honest-empty must still be WIRED, not hardcoded.** A reviewer will REJECT a
feature whose honest-empty state is a hardcoded inline literal (empty events, age
0, "mapped:true", empty reserved slots) — it reads as "can never function even
when the real source connects." Route every honest-empty value through a real
source/seam that returns the empty value TODAY and lights up automatically when
the real source connects:
- Events: a provider seam that returns connected:false + provider:"none" +
  empty events as a SINGLE source of both connected and events (so they can't
  drift); flipping to a real feed (Trading Economics/FRED) lights the radar with
  zero other changes.
- Reserved overlay slots: derive from the user's REAL open positions (scoped by
  userId); empty list ⇒ no slots, never a hardcoded empty.
- Handshake facts: derive overlay age from the signal's generated-at (absent ⇒
  freshness NOT_AVAILABLE) and news-mapped from the radar's provider.connected
  (false ⇒ NOT_AVAILABLE) — never optimistic constants.

**A "news layer on the chart" requirement = markers + preference-gated alerts,
not just a radar strip.** A radar strip plus an unconditional Critical/High toast
is a partial implementation that review rejects. The full surface is:
- Time-positioned **chart event markers** on the candle series (clamp the event
  time into the loaded candle range so far-future/pre-history events still show at
  the nearest edge); symbol-affecting events colour-coded by severity, unrelated
  events muted grey (context, not a call to action).
- Alert routing **gated by the user's own alert preferences**: CRITICAL always
  interrupts (cannot be silenced), HIGH only when the relevant category is on AND
  outside quiet hours, MEDIUM/LOW stay visual-only. Mirror the Alert Preferences
  page semantics exactly rather than inventing a parallel rule.

**Why:** the radar strip alone leaves the chart blind to event timing, and an
unconditional toast ignores the user's explicit notification choices — both read
as incomplete against a "smart chart layer + alert routing" task.

**Every news-risk surface (not just the radar) must share the connected-calendar
seam.** Review will REJECT a scanner/Ruby/ticket news-risk that scores its BASE
level off the mock schedule while reporting `calendar.connected:false` — that is
the same mock-as-real violation as a fabricated radar event, because the mock
schedule fabricates forecast/actual numbers and impossible cadences. Score base
risk ONLY from the connected real-calendar snapshot (disconnected/synthetic ⇒ no
events ⇒ "none"); reflect the radar's top severity escalate-only from the SAME
snapshot so scanner and chart can never disagree. Map provider events with
forecast/actual/previous left null — never synthesise them.
**Why:** a non-zero base risk with no real calendar lets a trader act on invented
"FOMC in 10 min" pressure even when the chart radar correctly shows nothing.
