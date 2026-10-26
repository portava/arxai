# Source-bound chart history continuation

## Contract and current limitation

A provider label is not historical account provenance. The shared `market_candles` key is `(symbol, timeframe, source, barTime)` and can be overwritten by another bridge. The canonical `broker_candles` key includes a bridge but omits account era. Its ingest accepts a payload account number ahead of the bridge fallback, and a forming-row update can preserve an old account attribution while changing prices. The current MT5 router evidence also lacks a historical account era. None of those facts can be repaired by attaching today's connection identity to old rows.

Both chart surfaces now require producer evidence before appending a history page. The client sends its expected opaque source identity; that digest is a consistency constraint, never an access grant. A missing, different, malformed or absent response identity withholds the page and reports the limitation. Existing generation invalidation and cancellation prevent obsolete pages from repopulating a changed symbol, timeframe, provider or opaque context.

The strict server path currently supports the distinct `deriv_public` namespace. This namespace is produced by the fixed credential-free Deriv transport and has no broker account. The server observes the routed public provenance, rejects account/bridge/subprovider attribution, compares the expected digest, verifies the public transport remains selected, and checks every returned bar is valid, chronological, closed and strictly before the requested window. `historyEvidence` describes the actual returned page. A public connection does not authorize trading.

Each Deriv candle response carries the source captured from the actual client before awaiting I/O. History checks that producer before any cache write; the router also preserves that returned source. The original candle function already captured its client synchronously before awaiting; this change exposes and enforces that fact at the storage boundary, rather than claiming a reproduced baseline transport swap. Pre/post configuration checks alone do not independently attest a returned response when settings change and return to their original value. A private or unattributed result cannot populate the public namespace, including during that change-and-return sequence.

Strict MT5, private Deriv and other legacy history continuations return no bars because the current storage cannot attest the required historical identity. Their latest visible candle window remains available under the existing feed contract. Provider-only legacy service callers retain their prior behavior, explicitly without history evidence; those responses cannot be appended by the strict chart consumers. This is containment of an integrity gap, not restored MT5 history parity.

No database migration or external database operation is part of this slice. Restoring account-bound history requires authenticated producer account evidence, an immutable account-era/source key, preservation at ingest and cache writes, and an actual viewer-authorized history read. A bridge token or the connection's current owner/login must not retroactively attest old bars. Mapping changes also need a new historical source version; a current canonical alias cannot relabel older native-instrument data.

## Competitive criteria

Reviewed October 26, 2026 using primary documentation:

- [TradingView required datafeed methods](https://www.tradingview.com/charting-library-docs/latest/connecting_data/datafeed-api/required-methods/) specify chronological historical bars and distinguish full historical cache resets from incremental updates to the latest bar. [Datafeed common issues](https://www.tradingview.com/charting-library-docs/latest/connecting_data/Datafeed-Issues/) describe resetting cached data and re-requesting history after connection problems. ARX acceptance: an obsolete or wrong-context page never enters the current series; unavailable history remains visible as unavailable.
- [MetaTrader 5 CopyRates](https://www.mql5.com/en/docs/series/copyrates) requests an exact symbol and timeframe with a count or time window, returns available history and reports unavailable/partial retrieval. ARX acceptance: exact source identity and older-than boundary, valid ordered bars, no invented depth or silent venue/account substitution.

These sources do not provide an equivalent-condition latency benchmark. Neither competitor parity nor 60fps is established by this change. MT5 deeper-history coverage remains a named feature gap until historical account provenance is stored correctly.

## Validation criteria

- Valid public control; forged digest and changed public/provider identity refused.
- Unknown account history refused before touching the shared cache.
- Same-provider bridge/owner changes and public-to-private transport change during an awaited read refused.
- Missing response evidence, wrong symbol/timeframe/source, future evidence, invalid OHLC, duplicate/nonchronological bars and overlapping cursor windows refused.
- Legacy service callers remain unattested; no invented metadata added.
- Both chart callers opt into the strict contract; stale responses and cancellation still preserve current state.
- Record local compute overhead and the additional observed-source read separately from provider latency. No hidden completion or live-financial claim.

## Recorded checks and local processing comparison

The focused integrity suite passes 24 history cases and five captured-producer cases; the combined history/Deriv regressions pass 62 cases. The expanded chart suite passes 62 cases; the full dashboard suite passes 1,325 tests with 9 optional live tests skipped. All four workspace typecheck units pass. Generated contracts come from OpenAPI/codegen, including the optional current-window market evidence emitted by the Truth component dependency.

A bounded processing-only replay used 500 cached bars per page, 50 warmups and 500 measured samples per path on the Apple M4 Pro host. Source and storage I/O were mocked; the real service and source-evidence preparation executed. Legacy unattested processing measured median/p95/p99 of 0.008/0.016/0.101ms; strict processing measured 0.161/0.467/1.169ms. The strict path made one additional observed-source read per page. This measures local processing overhead, not real provider/database latency or end-to-end history completion. The network cost and deep-history availability remain visible gaps; no claim of faster history or equivalent competitor performance follows.

The separate combined scanner browser receipt does not include this history slice. It validates the previously reviewed lifecycle and Truth changes only.
