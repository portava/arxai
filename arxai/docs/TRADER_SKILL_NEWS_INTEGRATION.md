# Trader skill: news evidence integration

Source reviewed: https://github.com/Jakeschincariol/trader-skill at
5189e79b9a480755a3733ac9713f5353981dbe18. Skills used: trader-news;
trader-analyst was reviewed for primary-source and timestamp requirements.
No upstream source code or fixtures were copied into the application.

## Existing systems and chosen scope

ARX already supplies market news through marketProvider (including GDELT),
economic-calendar checks, news risk scoring, and the shared news intelligence
pack consumed by Eleanor, scanner and the trade-ticket panel. Reuse these.
The installed pack's separate Python brokerage, risk settings and portfolio
state are not application replacements. SEC fundamentals and congressional
filings are not integrated by this change.

## Changes

- Shared headline normalization: valid HTTP(S) source links, URL deduplication
  ignoring fragments/UTM tracking, newest-first ordering, 48-hour age limit,
  60-second future-clock tolerance, and a maximum of eight items.
- Keep GDELT first-seen timestamps separate from publication dates. Each
  served headline is explicitly `headline_only`, not a verified article.
- Remove keyword-derived bullish/bearish news bias. The compatibility field
  remains `unclear`; headline words do not demonstrate instrument direction.
- The trade-ticket panel exposes source links and timestamp basis and says
  direction is not established, including when talking to an older server.
- Extend OpenAPI and generated clients with optional provenance fields.
- Preserve existing economic-calendar risk calculations and source availability.
  A connected feed with no accepted recent items means zero usable headlines,
  not proof that nothing happened.

## Upstream tool experiment

Ran the installed news.py on its offline AAPL/KO fixture, dry-run, with
`--now 2026-10-13T18:00:00Z`. Its results included 20:36/20:37/22:21 headlines,
which were future-dated relative to that check. These are upstream test data,
not independently verified news. ARX tests explicitly reject future timestamps.
No SEC request or portfolio-state write was made by this experiment.

## Validation scope

Focused server tests cover normalization, production pack behavior, calendar
unavailable states and GDELT behavior. UI tests cover source links, timestamp
labels, unsafe links and existing calendar truth states. Typecheck both apps.
These checks do not establish news-provider uptime, story verification,
forecast accuracy or trading performance. No deployment is included.

Recorded validation: 18 news/GDELT/calendar tests and 5 Eleanor news-tool tests
passed; 6 panel tests passed. The Eleanor test initially failed at startup
without DATABASE_URL, then passed with a non-routable local test placeholder
(the test mocks its data). API and library typechecks passed. Dashboard
initially saw stale built client types; rebuilding libraries resolves the
new contract before its final typecheck.

Final dashboard typecheck passed after the library rebuild.
