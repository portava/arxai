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
Broker comparison provenance (2026-10-27): the comparison now carries an
additive `quoteBinding` (`BOUND | MISMATCH | STALE | UNVERIFIED` plus every
failed reason). Symbol Mirror Accuracy earns points, the handshake
`BrokerPriceAlignment` can PASS and Ruby's trust line can say "Mirror synced" or
"Mirror drifting" only when the quote is BOUND: same observed provider, bridge
and owner as the served chart series, owner equal to the requesting user, no
observed environment/broker-symbol contradiction (unknown on either side is not
a contradiction), and an observed tick time no older than the shared 15-second
quote freshness budget and not more than 5 s in the future (the shared
`MAX_FUTURE_CLOCK_SKEW_MS` clock-skew allowance; before the 2026-10-27 review
follow-up an EA clock 1 ms ahead read `QUOTE_TIME_FUTURE` permanently). The chart producer keeps the
served series' router provenance off the wire (non-enumerable) for this check.
`/me/chart/intelligence` tries the live MT5 quote pushed by the series' own
bridge (only when that bridge belongs to the requesting user), then the user's
`arx_symbol_specs` row, which binds only from an EA-reported `lastTickTime`.
Otherwise the sub-metric is null and its detail names the reasons (for example
`BRIDGE_MISMATCH`, `QUOTE_STALE`, `QUOTE_TIME_UNKNOWN`). An observed failed
deviation from an unbound quote still blocks chart trade confirmation and shows
`MirrorSync` FAIL, but cannot earn or lose mirror points. A perfect window
without a bound quote now earns at most 75.

Still open: no current ingest path writes `arx_symbol_specs.last_tick_time`,
so snapshot rows stay `UNVERIFIED` and only the live same-bridge quote can bind; durable-mirror series have no
bridge/owner and stay unattributed; shared chart series served from another
user's bridge cannot be compared for this user; environment and broker-native
symbol are not observed on the live push path; EA clock/time-zone correctness
is not independently verified (v2 TICK `brokerTimeEpochMs` is broker server
time by contract and is recorded as an observed tick time without any
conversion, so an un-converted broker clock fails closed as future or stale
rather than binding); the router's Truth quote pairing (`scannerQuoteFor`)
still rejects any negative quote age via `classifyQuoteFreshness`, which is
stricter than this binding; self-trade's cached chart context still uses the
unenriched placeholder. No production broker data, latency or terminal behavior
was exercised.

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
