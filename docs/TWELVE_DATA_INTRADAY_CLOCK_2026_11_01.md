# Twelve Data intraday clock correction

The existing Twelve Data `time_series` adapter omitted a timezone request and appended `Z` to returned wall-clock strings. It also did not check the returned instrument or interval. This could label a different source clock as UTC.

## Audited contract

Twelve Data's [timezone support documentation](https://support.twelvedata.com/en/articles/5745849-timezones) identifies the Forex default as Australia/Sydney and documents explicit timezone requests. Its [time-series API contract](https://twelvedata.com/docs#time-series) says `timezone=UTC` controls intraday output only; daily/weekly/monthly requests ignore that parameter and remain exchange-local. Response `datetime` identifies the bar open. `exchange_timezone` identifies the instrument's exchange, not an echo of the requested output timezone. Therefore a valid New York or Sydney exchange zone does not contradict explicitly requested UTC intraday output.

## Change

The same adapter now requests `timezone=UTC` and `order=desc` for its existing intraday intervals. A pure response parser requires successful status, matching exact symbol and interval, valid exchange timezone metadata, strict real-calendar bar-open timestamps, chronological descending non-overlapping observations, and valid OHLC. Any malformed row rejects the whole response; no partial repair, guessed conversion, date normalization, duplicate removal or gap filling occurs. An optional conflicting output-zone field is refused. Daily requests stop before a provider request because the UTC output contract does not cover them. Existing composite fallback selection can still choose another configured provider.

Observation timestamps remain original bar opens. Every successful historical candle response is conservatively classified DELAYED: bar-open age, even five seconds, does not establish real-time plan entitlement or a current observation. This prevents the router from converting a recent bar into delayed:false. No historical UTC or price-basis evidence is issued for research. The current chart authority gate remains unavailable for this provider. This patch does not establish historical data coverage, broker fills, actual spread, traded volume, current account access or provider availability. Missing volume retains the legacy numeric zero convention without adding volume authority. Existing symbol mappings and quote endpoint behavior are outside this change.

The exact `assistant_real:twelve_data` open-time normalization correction is coordinated in the separate Polygon evidence integration, not included in this adapter commit. Both changes must be combined to avoid the former one-interval chart shift.

## Offline validation

Nineteen original-response-shaped adapter regressions failed against the baseline before the fix. The expanded registered quote-observation lane passes 54/54; the adjacent Alpha Vantage plus Twelve Data set passes 42/42. API typechecking passes. Fetch is replaced with response fixtures; no provider API, broker, existing database, worker or external AI call occurred. Independent Truth review found no blocker in the bounded correction. No deployment or live-source acceptance is claimed.

Raw receipts: `/Users/areyouok/arx-tier1-release/twelve-data-utc-20261101/`.

Root follow-up review found that the initial age-based REALTIME classification could promote a recent bar open into a live-feed claim. Three failing-before regressions (current M1, four-hour-old H4, current H4) prove the issue; all now remain DELAYED without altering timestamps. Quote handling remains separate.
