# Position money refresh — 2 November 2026

Development improvement only. **Not deployed; not release-green; real-time MT5 equality is not established.**

## Exact sources

- Baseline: `19ac1b21b72b825bd9ef97cccfbbf94d89bd1807` (native default and mobile layout repair).
- First position refresh fix: `2572561e96f8510ca3c2f608a7f7f1a152628e8b`.
- Offline route fixture repair only: `6e0ece8714d3aa8cacaefbb1cadd2c8c69df260b`.
- Final application: `0090138ed5eb3dee1ead795d188d1261af2ec269`.
- Branch: `codex/position-money-refresh-20261102`.
- Normal production fixture: `4fde9067f94b0203`, clean exact final head, no chart-engine override. Build executed in browser must match this receipt.

## Problem and final behavior

The position picker polled separately, and the Smart Chart and Scanner each had another ten-second positions read. A price/P/L update could therefore appear in the list while the chart still displayed the old value. A stalled pending-draft response also delayed Scanner positions. Failures could leave old rows visible. Selected detail and chart P/L had different rounding.

The existing per-user endpoint now has one canonical user-keyed query shared by the picker, selected detail, chart overlays and Scanner. Existing account-change notifications trigger a reread; notification payloads never directly set amounts or renew timestamps. Refresh during an in-flight request retains a trailing reread. The existing bounded full-body reader rejects malformed values and withholds prior rows on a failed report. Polling remains a fallback; paused automatic reads can still be refreshed explicitly.

A successful empty report removes the position from all these views. A close dispatch acknowledgment does not remove a row, calculate a balance or release exposure optimistically. Identity changes, cached identity errors, missing rows and wrong demo/live scope are checked again at the affected action boundaries. Existing server execution rules remain in place; no entry-confidence rule was added to protective close.

The same finite numeric P/L is displayed without forcing two decimal places. The endpoint does not supply native decimal strings, observation time or currency, so the UI says last reported and does not invent those properties. Unsupported dollar risk calculated from a fixed forex contract multiplier is withheld. Position P/L is not substituted for native whole-account profit.

Market Scanner uses one existing shared account stream and a small refresh-control consumer. Account ticks do not force the entire scanner header/chart tree to rerender. Pending drafts remain separate and cannot hold up the money report.

## Validation

Final application `0090138e`:

- Full frontend: **4,678 pass, 0 fail, 12 skipped**; 265 passing files and 2 skipped files.
- Dashboard typecheck and production build: pass.
- Guards: **85/87**. Both failing guards and all 43 diagnostic/failure lines match the earlier baseline exactly (38 wording and 3 internal-name violations). The chained checks following the failed guard command did not run. This is not a green guard lane.
- Independent reciprocal source reviews; all recorded source hashes match the commit. Shared-position review 40/40; implementation lane 170/170. Scanner lane 74/74, including 13 actual Scanner/page cases. These overlap with the full suite and are not additive totals.
- Actual offline production browser: **16/16** shared Smart Chart/list/detail checks and **9/9** Market Scanner checks. Same unrounded P/L before fallback, one shared stream, empty-report removal, paused manual refresh and no trade action attempts. Visual snapshots inspected after removal.
- Single synthetic notification-to-readback samples: Smart Chart **36.1 ms**, Scanner **74.4 ms**. These are functional samples, not distributions or native broker latency.

The original picker regression tests failed before the fix. The corrected overlay fixture exposed six baseline failures, including stale panels, duplicate reads and forced rounding. The Scanner baseline exposed five behavior failures, then three wrong-scope action failures. Intermediate fixture mistakes remain in the raw logs and are not counted as product-defect proof.

The first browser driver on `6e0ece87` passed 13 checks but inspected only picker/detail. Visual review found the chart still showing `BUY +1.00 · LIVE` while the detail showed `-12.345`. The enhanced driver reproduced that mismatch before the canonical overlay migration. That initial pass is explicitly insufficient evidence of cross-surface consistency.

## Remaining work and evidence limits

1. **Whole MT5 account synchronization remains unproven.** These positions are per-user ARX records; another trader's positions or an account-wide balance/profit change cannot be inferred from them. The native report retains its existing unverified-currentness state.
2. The endpoint lacks a verified connection/account identity echo, currency, native precision and position observation time. Exact terminal-to-screen equality needs these facts plus ordering/sequence and age checks, not just faster polling.
3. Terminal reporting cadence, synchronous producer work, cross-process notification delivery and same-observation balance/equity/profit/margin consistency remain unfinished. Earlier account-report-priority and manual-refresh receipts remain separate; this frontend run does not revalidate the EA.
4. Portfolio, other legacy money consumers and all account-wide figures have not been proven aligned by this slice. Shared query deduplication is not proof of a single physical poll timer across arbitrarily staggered observers.
5. Scanner's existing reverse flow treats successful close dispatch as permission to request the opposite entry; terminal fill is not proven first. The new identity/scope checks do not fix that separate execution/truth gap. It must be addressed through the governed confirmed-result path before release.
6. Pending drafts retain their previous ten-second visibility polling; the new money auto-refresh switch does not govern that separate read. No pending-draft freshness claim is made.
7. Offline fixtures establish behavior and ordering, not provider, MT5, live/demo or published-app latency. A notification readback timing is not a broker-to-screen benchmark. No guarantees, completion percentage or competitor superiority are claimed.

## Competitive acceptance still open

MT5 exposes balance, equity, account profit, credit, margin and free margin as account properties in the deposit currency; margin level is a percentage and currency precision is an explicit property. ARX must compare like-for-like fields from the same account and observation. [MetaQuotes account properties](https://www.mql5.com/en/docs/constants/environment_state/accountinformation).

Terminal transaction events can arise from manual trading, programs and server operations; their arrival order is not guaranteed. A reliable bridge must reconcile the authoritative account report instead of assuming a frontend action or event order proves the final balance. [MetaQuotes transaction handler](https://www.mql5.com/en/docs/event_handlers/ontradetransaction).

Acceptance remains: all views of the same field must agree on value, account, currency and observation; delayed/unavailable evidence must be clearly qualified; event-to-authoritative-read-to-visible-update latency must be measured with failures and tails retained. No direct MT5/TradingView performance comparison was run here.

## Boundaries

No main merge, deployment, Replit source update, database migration, broker connection, live/demo test, order, worker enablement, email or fund movement. Tests use synthetic data; browser non-GET requests are blocked. Existing incidental activity/scan POST attempts are recorded as blocked and are not described as zero mutation attempts.

## Scanner navigation regression on final application

Twenty first-actionable-click attempts were retained, five per viewport and CPU rate. All twenty completed with correct source, OHLC and visible native rendering. No chart-engine override, no deliberate pre-click dwell. The fixture injects an 80 ms candle response delay and primes browser resources; this is not cold browser startup or the hosted app.

| CPU | Viewport | Within 100 ms | Median | Maximum |
| --- | --- | --- | --- | --- |
|1x|Desktop|5/5|65.6ms|67.0ms|
|1x|Mobile|5/5|64.9ms|67.7ms|
|4x|Desktop|0/5|280.8ms|397.4ms|
|4x|Mobile|0/5|289.4ms|366.0ms|

The normal-CPU samples remain near the 19ac baseline. Throttled samples fail, and some are slower than the prior baseline; shared-host variation and the small sample do not establish causation or demonstrate no regression. Do not claim the 100 ms target, p95/p99 reliability, physical 60 fps or competitor parity. Exact per-attempt traces and interrupted/failure handling remain in the saved receipts. The checked-in driver separately reports source correctness and budget success.

## Checkpoint and next work

The previous native-default documentation checkpoint `8433a67e` was carried forward as docs-only `361664fe`; application remains `0090138e`. The new money report and portable receipt bundle are documentation only. See `docs/validation/position-money-refresh-20261102/manifest.json` for each retained file hash and archive SHA-256. Raw local evidence: `/Users/areyouok/arx-tier1-release/position-money-refresh-20261102/`.

Next priority: independently verify native account observation/ordering/currency identity and all balance/equity/P/L consumers; then measured event-to-screen delivery for changes made outside ARX. Retain the reverse confirmation gap and slow-CPU Scanner navigation failure. Existing trading/deployment restrictions remain in force.
