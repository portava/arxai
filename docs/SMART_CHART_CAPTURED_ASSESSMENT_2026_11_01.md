# Smart Chart captured assessment inputs — 1 November 2026

Status: development correctness increment; **not release-green, not deployed, no competitor-parity claim**.

Application source: `5648453f8905f88e4e5f9fcb1676c2c29c795a7e`, based on the account-recovery checkpoint `9275a5c912b0ac0688c9ff9d37e123dd1f606f4d`.

## Problems and changed behavior

The assessment previously derived its gate and sufficiency from a cached intelligence state, fetched primary candles again for the explanation, and independently probed feed status. Those reads could describe different source observations. Per-user broker enrichment also waited for its quote query before looking up the shared cache again, allowing another request's state and quality judgment to replace the original one.

The existing intelligence builder now returns the captured normalized candles, feed judgment, truth result and market evidence alongside its state. It owns a copy before awaited downstream work can mutate the provider's response. The old state-only API remains a wrapper. The assessment uses those exact primary candles and that feed verdict; it does not refetch primary data or let another feed probe upgrade the capture. Broker enrichment captures its context before the quote await and requires the exact passed state. A client-observed negative feed verdict still restricts the result.

Conversion preserves already-normalized open time, copied clock/price/volume descriptions and measured quantity units. Missing volume does not become observed zero. Forming bars are excluded even if their completion flags contradict each other. The audited original-provider test shows that normalized UTC/BID descriptions survive conversion without minting new runtime-issued producer authority.

Review also found a real higher-timeframe routing defect: the helper accepted aliases such as `5m` but the assessment supplied canonical `M5`. It now returns canonical codes for the existing comparison mappings. Weekly candles are no longer mislabeled as their own higher timeframe; unmapped intervals remain unavailable. Primary and higher-timeframe acquisition start concurrently, with distinct observations and quality judgments.

Only confirmed, nonstale higher-timeframe candles enter bias/confirmation consumers. Missing analysis is explicitly “Not assessed” in structural reads and draw-setup analysis, distinct from an assessed “No clear edge.” Classic pivot inputs require an actual daily, weekly or monthly interval and use its latest closed candle. An H1 comparison cannot be relabeled daily, and a closed-only window no longer incorrectly skips its latest bar.

## Exact validation scope

On `5648453f`:

- New captured-input suite: **40 pass, 0 fail/skip**. Actual builder, context and assessment functions run with provider/DB/background boundaries replaced by offline fixtures. Broker enrichment uses the actual imported wrapper and extracted actual pure enrichment function.
- Existing feed layers, patterns, pattern library, market intelligence, trendlines, overlay, interval normalization and clock-evidence suites: **145 pass, 0 fail/skip**.
- Existing structure script: **9/9 pass**, including canonical/alias mapping and no weekly self-comparison.
- Complete frontend suite: **3,861 pass, 0 fail, 11 skipped**; 228 files pass and one is skipped. The retained jsdom navigation warning is not browser acceptance.
- API and dashboard typechecks pass. The complete CI typecheck entry point passes all four groups: shared libraries, API, scripts and dashboard. Its initial CLI launch was denied access to the local tsx pipe; running the same entry point through Node's import loader passed. The launch failure is retained.
- API and dashboard builds pass. The dashboard retains its large-chunk warning (including an 883.35 kB minified chunk).
- Architecture guards: **85/87**, with the exact same 43 failure/header lines as the account-recovery checkpoint: 38 risky-wording findings and three internal UI-name findings. These failures are not waived.
- Independent review cleared the primary capture, original evidence handling, higher-timeframe follow-up and final source commit.

Before evidence is retained: three primary-context assertions failed against the original implementation; six broker-context assertions failed against its saved original function; the actual canonical higher-timeframe path failed its closed-bar assertion. Early test-seam and typing failures are retained too. Counts above overlap and must not be summed into a unique coverage total.

Raw receipts: `/Users/areyouok/arx-tier1-release/chart-assessment-captured-input-20261101/`. The repository archive contains source hashes, logs, independent review and repeatable measurement artifacts.

## Measured capture cost

One quiet-window offline run compared baseline `9275a5c9` with candidate `5648453f`: 30 warmup and 120 measured counterbalanced pairs, 200 normalized development candles, 300 actual fresh builds. Checked results matched in every pair and the shared fixture stayed unchanged. All samples and outliers are retained.

Baseline median/p95 were 0.0350/0.0544 ms; candidate median/p95 were 0.4788/0.5423 ms. Paired overhead median was **+0.4423 ms**, p95 **+0.4998 ms**, mean **+0.4454 ms**. This is an added cost for coherent inputs, not a speedup. The isolated builder comparison shares current downstream engines and mocks provider/DB boundaries; it does not measure whole-request, browser, broker or competitor latency.

## Remaining limits

This establishes coherent primary inputs within an assessment, not an atomic observation across all app sections. Higher-timeframe data, cached timeframe agreement, FVG's separate three-timeframe reads, remembered events and broker quotes remain distinct observations. No new same-account/source/window proof is claimed across them.

Broker quote age/account provenance, re-aging captures across long awaits, server-to-client source/account/window/observation and draft binding, and an approved assessment-expiry policy remain open. Existing normalized metadata is descriptive evidence, not a new execution authorization. Neither cache TTL nor a successful response proves that the broker is current.

No real provider, HTTP/browser, terminal or competitor timing was measured here. Canonical HTF routing now performs work that the broken mapping skipped; removing duplicate primary reads and overlapping requests does not by itself prove a faster user experience. The added captured data has memory/copy cost; deployment-scale cache capacity remains unmeasured. Previously recorded slow-device first-click failures, broader chart capability gaps, native monetary acceptance and original architecture work remain open.

No main/PR76 merge, deployment, Replit update/restart, existing database change, worker activation or live/demo broker test occurred. Full root CI and database-backed integration were not run in this slice.
