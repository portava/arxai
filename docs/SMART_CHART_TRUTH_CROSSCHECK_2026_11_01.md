# Scanner chart / Truth cross-check — 1 November 2026

Status: development-only. Architecture and release remain incomplete. This extends the existing chart, selected-market snapshot and shared calendar owners.

## What was inspected

An independent agent inspected the actual Scanner chart fixture, the displayed Truth labels and their source contract. The chart used generated EURUSD M15 candles through the real dashboard and chart renderer, with all external calls intercepted. It was explicitly historical/stale, not a live broker read. Generated EURUSD data does not make EURUSD a synthetic-market instrument.

The prior selected-market panel called unavailable calendar data “News risk none” and showed an empty event list as a checked absence of events. It also displayed default “Very Low confidence”, “Calm” volatility and “neutral” trend despite UNAVAILABLE analysis. Both were reproduced against the producer/consumer contract and locked by failing-before tests.

## Corrections

Selected-market reads now use the existing connected-calendar resolver. Availability and macro applicability survive the response and cache path. Legacy snapshots without evidence are unverified. Unavailable prices withhold confidence, volatility and trend grades without discarding independently verified calendar information. Valid historical price analysis survives calendar failure. Confirmed synthetic instruments use explicit macro-news nonapplicability. The trading ticket, order permissions and execution gates are unchanged.

Root review caught another issue in the first implementation: filtering the upcoming-events list before scoring removed recent releases. The shared scorer now receives the complete resolved event set; only the displayed upcoming list is filtered. A real-loader regression covers a high-impact event five minutes ago, an empty future list and a retained risk warning. No scorer thresholds changed.

## ChatGPT second opinion

The owner requested a separate ChatGPT cross-check. [The completed review](https://chatgpt.com/c/6ae734b8-4634-83ec-ac21-5c96378342ed) supports both semantic inaccuracies. It independently calculated the last candle's body (0.0001), upper shadow (0.0003), lower shadow (0.0002), and range (0.0006): the body is about 16.67% of the range, consistent with the stated spinning-top geometry. That is not a reversal prediction. The M15 open/close UTC-to-EST conversion is also consistent, without establishing live freshness.

The image upload was blocked by the browser extension's file-URL permission. No browser security setting was changed. ChatGPT received sanitized numbers and label text, not the screenshot, source code, full 175-bar series or test suite. It did not independently verify the developing double-top pattern or the complete-series statistics. Agreement from a model is not the Truth authority; source review and reproducible checks are separate evidence.

## Chart readability

Application `def4025124864e843e4cc7b96b4c4aa19df04dae` removes floating study titles below 600px of actual chart width, preserving full channel names in the existing data window. Numeric axes, settings, calculations and series identities remain unchanged. Initial sizing, explicit resize and observed resize use the same policy. Independent source review found no actionable issue.

On that exact source: five new regressions failed before; 290 focused tests,3,395 frontend tests (11 skipped),87 guards,7 bindings, dashboard typecheck and ordinary build passed. Actual Scanner checks passed 40 desktop / 41 phone. The first phone attempt passed 30 then failed one assertion because the harness compared the requested pointer candle with an adjacent candle actually selected at compressed spacing. The retained corrected run compares all named values at the actual selected candle, bounded to one M15 interval; application code did not change.

## Combined application evidence and limits

Application `47cbb89a77f4d3dc1d9d63c7893969b23eb9aa7c`, frozen dashboard build `2403398ecd2d1cee`: 3,403 frontend tests pass,11 skipped;18 selected-market backend tests pass; API/dashboard typechecks and builds pass. The root API typecheck initially lacked generated local declarations; those were generated without connecting to a database and the check passed. The agent's earlier API typecheck used cross-worktree dependency symlinks and is not substituted for this root result.

Nineteen actual Scanner browser assertions pass, covering missing/legacy calendar evidence, unavailable data, independently checked empty calendar, recent-release risk, retained measured historical analysis, unchanged canonical candles and desktop/phone labels. All provider/model/broker calls are intercepted. Synthetic-instrument nonapplicability is covered by unit/backend checks, not the EURUSD browser fixture. Phone screenshots retain sticky navigation/fixture overlays; this is label acceptance, not a complete mobile visual signoff.

Guard follow-up `8bbf5e3d54231d485cf7ca5cefc5357d70105a8a` changes only the guard tooling. Application/library trees are identical to47cbb89a. It enforces the shared calendar authority, explicit availability, complete scorer event set and both response envelopes;14 negative mutations are caught and7 binding assertions pass. The original package-cwd guard run had86/87 because it required direct database access. A stronger repository-root run now gives84/87: three pre-existing wording guards fail. All41 reported files and the three guard implementations are byte-identical todef40251 and47cbb89a. Some matches are tests/comments, so these are unresolved guard findings, not78 proven product defects. Running these guards from scripts/ can silently skip their cwd-relative scan paths and report false passes. That validation coverage gap remains open; this checkpoint is not globally green. No full root CI, live API suite, real calendar/provider, broker, physical-device or deployed-app acceptance is claimed. No new latency or competitor benchmark was run.

Open: the Smart Chart reader's unconfirmed/failed-read-to-stale mapping needs its own reproduction and correction; the captured fixture was explicitly stale, so it does not prove a false stale label. Broader pattern coverage, automatic drawing methods, chart simplify/restore, historical capital/sizing/equity/benchmark and slower-device latency remain unfinished. No TradingView/MT5 parity claim.

## Replit distinction

The previous source-only 0e95a162 import completed with validated application e4bbba1e, checkpoint 08ea8e71, current metadata head debf81f3. Replit reports 3,331 frontend passes/11 skippeds,521 targeted backend,87 guards/7 bindings and isolated builds/typechecks. Its browser acceptance is incomplete: retained witness/locator failures, a 50% versus 50.0% assertion, and unstarted mobile/ownership/withdrawal journeys. Saved records say the API and original build outputs remained unchanged. This does not mean these newer corrections are imported or visible in the running app.

Raw evidence: `/Users/areyouok/arx-tier1-release/selected-market-evidence-truth-20261101/` and `/Users/areyouok/arx-tier1-release/chart-compact-study-labels-20261101/`. No main merge, deployment, runtime restart/activation, existing database change, workers, emails or broker tests.
