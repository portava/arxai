# Polygon/Massive FX custom-bars evidence — 1 November 2026

Scope: the existing Polygon adapter's REST forex custom-bars path. This adds no provider, execution engine, account connection, live entitlement, pagination service or volume study.

## Primary contract

[Massive custom-bars documentation](https://massive.com/docs/rest/forex/aggregates/custom-bars) specifies UTC aggregate windows and Unix millisecond window starts. Its limit applies to base aggregates, not a guaranteed count of requested output bars. No quote update can mean no bar; absent intervals cannot alone prove a data outage or a complete trading calendar.

[Massive's forex bar explanation](https://massive.com/knowledge-base/article/how-are-massives-forex-bars-built-and-what-do-v-and-n-mean-on-a-forex-bar) specifies bid-side OHLC. `v` and `n` count quotes, not traded quantity. Its `vw` is a mean of bids, not traded-size-weighted VWAP. The grouped daily summary has different timestamp semantics and is not admitted here.

## Existing path, narrower authority

`polygonFxCandles.ts` parses only an exact supported `C:` ticker and requested fixed interval, an OK response, strictly descending distinct aligned numeric times inside the requested window and not in the future, and valid positive OHLC geometry. Inconsistent result counts or quote-count fields refuse the whole response. An explicit zero quote count contradicts the quote-derived positive OHLC construction and is refused; absent counts remain distinct. The audited request subset starts at UTC midnight and ends at an inclusive UTC day boundary. Only bars on the requested full-interval midnight grid qualify; off-grid aggregation responses are explicitly unsupported rather than called universally invalid provider data. This is a narrow adapter limitation, not a claim that every valid custom request uses epoch-aligned four-hour bars. It validates all rows before taking the bounded newest closed window; forming rows are explicitly omitted. It does not salvage a few plausible rows from malformed responses.

Only that parser issues original-time and original-price evidence. Private server WeakMap witnesses bind each evidence object to its kind, requested symbol, timeframe and exact original timestamp/OHLC. Normalization validates those witnesses for `assistant_real:polygon`. Missing, forged, modified, wrong-context, copied or JSON-rehydrated evidence remains unavailable. A provider label or a string ending in Z cannot mint authority. No database schema/backfill is introduced.

The existing assistant memory cache preserves the issued object references. The router forwards them through its existing Candle shape; the normalizer emits ordinary API evidence after checking original ownership. Persisted numeric cache rows cannot recreate the witnesses. Historical research consumes the existing normalized contract and still calls the source `historical_unattested`; API metadata does not become broker attestation.

Both Polygon and Twelve Data candle timestamps name original bar opens. Exact provider mappings correct the former blanket assistant-bar-close subtraction. Twelve Data gets no UTC/BID research evidence from this coordinate correction.

## Honest limits

Successful Polygon history is conservatively `DELAYED`; an OK history response proves no live plan entitlement or executable quote. Broker-only decision routing remains unchanged and refuses substitute chart data. The new source receipt describes historical UTC bid observations, not traded prices or complete requested history.

The loaded window alone may qualify for exploratory testing. A longer requested period is withheld unless the actual observations cover its exact edges. Missing internal intervals retain the existing continuity uncertainty; no interpolation or fabricated candles are added. No pagination is followed. Base-aggregate limits can yield fewer bars than requested.

`v` stays in the legacy numeric field for compatibility, but no volume evidence is issued. Missing values are not evidence of observed zero, and neither `v`, `n` nor `vw` qualifies traded-volume VWAP or a volume profile.

Offline fixtures exercise the actual provider/cache/router/Truth/capture chain; only provider fetch and the empty durable-storage boundary are replaced. Native EA, real provider availability, entitlements, existing database migrations, deployment and broker testing are outside this slice. All raw failures and final counts are recorded beside the validation receipt, tied to the final commit.
