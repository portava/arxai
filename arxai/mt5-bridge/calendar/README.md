# MT5 economic-calendar telemetry

The user subsequently approved retaining a dedicated SSH key and continuous calendar-only delivery after testing. The Mac relay is now supervised by the user LaunchAgent `com.arx.calendar-relay`; the independently managed tunnel uses `com.arx.calendar-tunnel`. Operational instructions and stop/restart commands are in `/Users/areyouok/arx-tier1-release/mt5-calendar-service/RELAY_SERVICE.md`. Credentials remain in their existing private files and are never committed to the repository.

`ArxEconomicCalendar.mqh` queries the terminal's real built-in calendar every 60 seconds over the existing transport. It reads a one-day history plus fourteen-day future window, capped at 2,000 rows, and reports query errors/omissions. It never imports trading helpers, changes settings, or submits commands. Existing account and read-only gates must remain in the caller.

## Application wiring

- Mount `routes/mt5Calendar.ts` in the API router. It reuses `bridgeAuthPerUserOnly`, rejects mismatching account/server, and accepts only the operator-selected connection.
- Before the global JSON parser, mount a 2 MB JSON parser on `/api/mt5/calendar/ingest`. Multi-day real snapshots exceed Express's default 100 KB.
- Set `MT5_CALENDAR_CONNECTION_ID` to the authenticated registered connection ID. A payload's account/connection fields cannot select the shared source.
- Set `MT5_CALENDAR_SERVER_TIMEZONE` only after verification against real server/GMT clock evidence and independently timed events. The initial local observations show UTC and match independently checked BoE/NFP timestamps; this is measured evidence, not a claimed permanent Deriv timezone policy.
- Prefer `getMt5CalendarResult()` only when `connected` is true. If MT5 is unavailable, central service may use a real alternate provider while retaining the MT5 failure reason. Explicit `mt5_calendar` selection must preserve missing/error status.
- Without a timezone, authenticated ingestion still captures raw clock evidence but cannot publish normalized UTC events. The source expires after two minutes, rejects duplicate/out-of-order observations, rejects insufficient or over-fourteen-day horizons, and does not survive API restart as falsely fresh data.

## Time and value truth

MQL5 calendar times are **broker wall time**, not Unix UTC. The configured IANA timezone converts each event independently so future DST is not extrapolated from today's offset. Every snapshot must also match observed terminal UTC/server time within five seconds and a fresh broker quote within two minutes. Ambiguous/nonexistent local times and nonexact event time modes are omitted. Unknown importance is omitted rather than fabricated as low impact. Omissions remain visible in the provider message.

MQL5 long values are transmitted as strings; missing LONG_MIN becomes null. The receiver divides exact integers by 1,000,000 without JavaScript floating-point loss. Provider units and multipliers remain attached (for example, millions barrels). Actual/forecast/previous/revised fields are never substituted for one another.

Official references:
- https://www.mql5.com/en/docs/calendar/calendarvaluehistory
- https://www.mql5.com/en/docs/constants/structures/mqlcalendar
- https://www.mql5.com/en/docs/dateandtime/timegmt
- https://www.mql5.com/en/docs/dateandtime/timetradeserver

## Local Mac integration and validation, 5 November 2026

`stage_local_calendar.py EA_SOURCE RELAY_SOURCE OUTPUT_DIRECTORY` creates a reviewable variant without installing it. It requires the existing constant read-only/false execution gates and no command polling. The only allowlist extension is the calendar POST. It preserves existing inputs. The existing Mac file-spool transport does not need WebRequest permissions or a token in the EA.

The staged variant was compiled with the installed official MetaEditor under bundled Wine, in an isolated prefix: **0 errors, 0 warnings**. Operational evidence lives outside this repository at `/Users/areyouok/arx-tier1-release/macro-repair-20261105/mt5-calendar-staged`.

With root authorization, the compiled source/include/binary were installed to the existing `MQL5/Experts/ARX_ReadOnly_LocalTransport` folder, after backing up the prior source/binary. The existing terminal was reloaded with `C:\arx-readonly-62249354.ini`, which retains `Enabled=0`, `AllowLiveTrading=0`, and `AllowDllImport=0`. The original `ARX_62249354_LocalReadOnly.set` SHA-256 was unchanged. No accounts, credentials, presets, trades or execution arms were changed.

Three offline observations at 14:18:34, 14:19:30 and 14:20:29 UTC each contained 582 real rows; 528 normalized, 54 omitted nonexact-time/unknown-impact events, 60 actuals, 303 forecasts and 386 previous values. All three server/GMT offsets and quote lags were zero. Twenty-three heartbeats passed the existing read-only/Algo-Off validators. These are **local observations**, not proof of continuous API delivery. The bounded offline capture responder has exited.

The staged `calendar_only_relay.py` can run for thirty minutes after the already-authorized loopback tunnel is restored. It reads the existing private bridge preset internally, forwards only the calendar POST, refuses redirects/proxies, never polls commands, returns the real API response, and emits 503 for all unforwarded telemetry. It was started over the explicitly authorized temporary loopback tunnel, and three independent snapshots were accepted by the API at 14:35:50.451Z, 14:36:50.003Z and 14:37:51.202Z (HTTP 200, accepted=true, 528 normalized rows each). At the third acceptance, 114 separate read-only/Algo-Off heartbeats had passed local validation and the transport had zero errors. That bounded test relay was subsequently replaced, with explicit user approval, by the supervised persistent calendar-only service described above. Its existing sibling `relay.py` supports all previously allowed read-only telemetry plus calendar if root elects to restore the broader verified feed.

## Persistent local delivery

The launchd relay survives ordinary process exits/restarts and has no test-session expiry. It forwards only calendar observations, never commands, orders, heartbeats, or other telemetry. A fresh local read-only heartbeat (all execution arms and Algo Trading off) is required before calendar forwarding. Logs rotate at 1 MB with three backups, status writes are atomic, and SIGTERM produces a graceful restart under launchd. Nine additional boundary/lifecycle tests cover this durable variant.

Availability still depends on the Mac being awake, the user logged in, MT5/its read-only collector running, and Replit/the tunnel reachable. The service does not launch MT5 or Replit and does not prevent sleep. When observations age beyond two minutes, ARX rejects them as stale and reports the actual fallback provider and failure reason. Supervision does not fabricate uptime or data freshness.

## Observed provider conflict

The November 5 BoE event (MT5 value ID `269638`, event ID `826020009`) repeatedly reported actual `4.25` and previous `4.0`. The [Bank of England release](https://www.bankofengland.co.uk/monetary-policy-summary-and-minutes/2026/november-2026) states a 0.25 percentage-point increase to 4%, implying previous 3.75%. Collector field mapping was verified directly against `actual_value` and `prev_value`; this conflict is upstream, not an ARX scaling/substitution error. Raw evidence is preserved. The central calendar service must withhold conflicting fields with provenance, rather than silently correct them or claim all provider values have been independently verified.

## Tests

Run from `artifacts/api-server` with repository dependencies:

```sh
node --import tsx --test src/lib/news/calendar/__qa__/mt5CalendarWire.test.ts src/lib/news/calendar/__qa__/mt5CalendarProvider.test.ts
```

Thirteen wire/provider tests pass locally using Node 24 native TS stripping and a resolution-only loader (real domain focus-market export, no stubbed values). Six existing relay safety tests also pass against the staged relay. Real snapshot normalization was independently executed for all three observations. Runtime availability on Wine was established by the successful collector calls, rather than assumed from installation alone.
