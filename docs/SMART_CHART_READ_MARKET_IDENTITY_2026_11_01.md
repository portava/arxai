# Chart assessment market identity — 1 November 2026

Application: `adc7a76fbb42932a08997ada2ce15de482fc455b`. Development only; **not deployed or release-green**.

## Reproduced failures and changes

Eight regression cases failed before the change. The shared read store accepted wrong/missing symbol or timeframe echoes, and `M1` versus `1m` remained separate entries. Consequently an M1 scalp-panel read could be invisible to the Scanner header consuming 1m, including its failure restriction.

The existing store now uses the chart's strict interval parser for all get/set/request keys. Recognized display/API aliases share one request lifecycle and assessment. Unknown intervals retain their identity instead of becoming a default interval. JSON tuple keys continue to preserve separators, and broker suffixes/prefixes are not silently dropped. Logical-symbol case normalization remains consistent with the existing store; it is not a broker-instrument resolver.

Before publication, the validated endpoint payload must echo the requested symbol and interval. Missing, malformed or mismatching identity remains restricted. Unknown intervals may receive an explicit matching refusal, but cannot supply an affirmative assessment. These checks establish the echoed UI market identity only, not the underlying market evidence.

The panel sends canonical intervals on the wire. In particular the chart parser's `1M` month becomes `MN1`; `1m` minute becomes `M1`. This avoids the server's legacy raw-1M alias interpretation as a minute. It does **not** enable unavailable weekly/monthly charts or establish calendar boundaries.

## Validation on the exact application commit

- Full frontend: **3,860 pass, 0 fail, 11 skipped**; 228 files pass and one skipped.
- Dashboard typecheck and production build pass. The existing large-chunk build warning remains.
- Guards: **85/87**. The same risky-wording and internal-name violation/header lines remain as `5eee59fc`; one additional product source file is scanned. No waiver.
- Targeted intermediate run: 112 pass. The final wire/helper run: 43 pass (overlapping counts, not additive). Full suite above includes the final three request-body cases.
- Tests exercise all 21 recognized interval identifiers, month/minute separation, unknown interval refusals, malformed echoes, preserved suffixes, cross-alias races, and actual outgoing fetch bodies.
- The real ScannerHeaderSummary test first demonstrates “Ready now,” then verifies that a failed M1 read changes its 1m action to “Wait for confirmation.” This is a React DOM test with data hooks mocked, not a deployed browser observation.
- Independent source review found no blocker and requested the explicit interval/wire coverage, which was added. The reviewer inspected coverage rather than independently rerunning it.

The initial eight failures and an intermediate fixture failure are retained: the older independence fixture returned EURUSD/M5 even for GBPUSD/H1 requests; it was corrected to return the identity it claimed to test. The new validation correctly rejected those mismatched fixtures.

Receipts: [manifest](validation/chart-read-market-identity-20261101/manifest.json), [archive](validation/chart-read-market-identity-20261101/receipts.tar.gz). Archive SHA-256: `0b0e23c1e73fb7a6335734b4418f1cb2e7626c2e02224e6dc34ef05cff19293b`.

## Open evidence and competitive gaps

Account, source, candle-window, observation-time, plan-specific draft binding and assessment expiry are still open. A matching endpoint label is not proof of any of those. Static inspection also shows `buildRubyChartContext` computing gates/sufficiency from chart intelligence state before separately fetching primary and higher-timeframe candles; `rubyStructuralReadService` separately probes feed status. A shared provider chain does not establish one captured observation. The archive includes a source-hashed audit note; this particular mismatch has not yet been reproduced at runtime.

Next: trace and reuse authoritative captured candle evidence for both assessment content and its quality judgment, carry that identity to consumers, and reject or explicitly limit mismatched observations. Preserve account isolation and never invent evidence expiry policy. Original Smart Chart features, slow-device timing, real-preview acceptance and TradingView/MT5 comparisons remain incomplete.

No actual-browser or latency test ran in this slice. No broker/model/provider calls, trades, existing database changes, worker activation, Replit edits/restart, main merge or deployment occurred.
