# Chart Truth: measured and unavailable checks

The previous score granted full interaction points without interaction telemetry,
used candle-shape proxies as rendering/scale measurements, and could treat absent
price precision or broker quotes as successful checks. These were unsupported
claims, even when the OHLC data itself was valid.

Each sub-metric now carries `evidenceStatus`. An unmeasured property has null raw
and weighted scores. The aggregate adds earned weighted points against the
original fixed denominator; it never redistributes missing weights. Coverage and
the list of unmeasured checks accompany the number. This is a heuristic evidence
score, not a probability, profitability estimate, or architecture completion
percentage. A perfect source window currently earns at most 87 because renderer,
scale and interaction telemetry remain unavailable.

Broker comparison needs finite positive chart/bid/ask/mid prices, a noncrossed
quote and finite deviation. All-forming or all-closed windows do not establish a
closed-to-forming merge boundary. Missing expected precision is unmeasured.
Conflicting stale/non-live flags cap the feed score even when quality says clean.
Observed failed broker comparisons remain FAIL in the named handshake field.
Cached legacy sub-scores without evidence status cannot prove a PASS.
The broker comparison remains a comparison of supplied numeric values. It does
not independently prove the quote's account, source identity or freshness;
those provenance checks remain separate unfinished work.

The existing chart-advisory threshold remains 75. Fewer earned points can
therefore withhold confident chart reads, scanner confirmation and self-trade
chart confirmation until evidence is present. Candle rendering stays available;
this change does not enable trading or change live execution authorization.
Advisory gate booleans alone cannot prove renderer or broker measurements.

The API schema and generated clients expose nullable scores, measured coverage
and unmeasured keys. Consumers must not coerce a null sub-score to a successful
measurement. Rendering/interaction measurements will need a separately designed
source, identity and freshness contract before they can earn points.

## Competitive reference and acceptance

Reviewed 2026-10-26 (America/New_York): TradingView documents an explicit delayed
feed indicator and changes countdown behavior when data is delayed; this is a
reference for status claims tied to actual feed state.
[TradingView countdown and delayed data](https://www.tradingview.com/support/solutions/43000476233-the-countdown-is-not-displayed-on-the-chart/).
MT5 defines History Quality from actual data-quality observations, including
incorrect bars and gaps, rather than treating missing measurements as success.
[MT5 testing report](https://www.metatrader5.com/en/terminal/help/algotrading/testing_report).
These document particular behaviors, not matched product speed or feature parity.

Acceptance: no unmeasured property earns points or a handshake PASS; known
failures remain visible; JSON/schema roundtrips preserve null; fixed weights and
coverage reconcile; actual normalization and alignment producers exercise the
missing/invalid evidence cases. Offline paired scoring cost is recorded in the
external checkpoint receipt. Real broker data and end-to-end UI telemetry remain
outside this validation.
