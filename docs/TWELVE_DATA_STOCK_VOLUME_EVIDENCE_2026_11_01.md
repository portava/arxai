# Twelve Data stock volume evidence — 1 November 2026

This extends the existing Twelve Data `time_series` adapter and existing candle Truth contract. It does not introduce a feed, calculator, execution authority, or deployment.

## Source contract and bounded qualification

Primary reference: [Twelve Data time_series documentation](https://twelvedata.com/docs#time-series), read 1 November 2026. It documents intraday `timezone=UTC`, original bar-open datetimes, instrument/venue metadata, `type=Common Stock`, `prepost=false`, `adjust=none`, and a string trading-volume field. Defaults otherwise include split adjustment. Extended-hours data need not include volume.

Only existing approved canonical stocks receive the explicit Common Stock / UTC / regular-session / unadjusted request. FX, crypto, ETFs and other existing request paths remain readable without this authority. Response identity, interval, Common Stock type, MIC, exchange and currency must validate; contradictory optional adjustment/session echoes fail. Exchange timezone names the exchange, not the requested output zone.

The scope is the **provider-returned listing**, not an independently pinned venue, a consolidated tape, or independently attested broker data. Endpoint documentation does not establish one universal share-unit contract. The quantity is therefore named **provider trade units**, never shares, lots, quote counts or ticks. Only original positive safe-integer quantities on closed bars qualify. Missing, zero, fractional, unsafe and still-forming quantities remain unavailable while valid OHLC stays readable. Zero availability is deliberately unproven, not inferred from a calculator's arithmetic.

`seriesIdentity` is an opaque SHA-256 of instrument, interval, returned venue/currency/type/exchange-clock, UTC output, regular-session request and unadjusted mode. Different listings or scopes cannot silently share an anchored calculation. Unadjusted data can contain corporate-action discontinuities. Loaded bars do not prove requested historical coverage, session completeness or missing-bar causes.

## Existing authority and transport

`twelveDataCandles.ts` issues frozen runtime-only evidence for the exact validated original bar. Private witnesses bind original timestamp, OHLC, numeric volume, symbol, interval, internal original listing key and evidence kind. The separate internal listing key is carried through the raw provider/router shape and omitted from normalized API candles; it is never sufficient authority by itself. Original fractional text cannot qualify by rounding to an integer during numeric conversion. Reference-preserving provider cache/router mappings retain witnesses. JSON serialization, DB/cache rehydration, copied evidence, changed OHLC/volume/time/context or arbitrary caller labels do not qualify through normalization. Normalized API evidence is a display contract; it is not a cryptographic producer attestation.

The additive existing `CandleVolumeEvidence` permits `real_volume` / `provider_trade_units`, authority `twelve-data:time-series:common-stock:regular-unadjusted:v1`, and optional `seriesIdentity`. Existing MT5 `tick_count` / `ticks` shapes and meaning remain unchanged. No generic numeric volume fallback is authorized. Forming composite tips already revoke original evidence.

The same audited stock request qualifies original UTC coordinates. It does **not** qualify BID/MID execution prices: research price-basis gates remain withheld. Every successful candle-history response stays DELAYED; original UTC/trade units do not prove live entitlement, quote freshness, liquidity or execution readiness. Broker-only decision routing is unchanged.

## Validation scope

Tests exercise pure parsing and actual mocked provider → reference cache → router → Truth normalization. External market/API/broker calls and database reads/writes are blocked or replaced by empty seams. They cover legacy requests, request options, listing mismatch, volume absence/zero, forming bars, copy/mutation/serialization, wrong source/symbol/interval, and execution refusal. Real entitlement/provider behavior, calendar completeness and operational activation remain untested.

Final bounded validation: 146/146 registered candle-shape tests pass with zero skips; API typecheck passes. The initial nine regressions failed before implementation. Independent review found two fractional-text rounding cases and a same-value/different-listing evidence transplant, all reproduced before correction. Twelve Data generic parser tests remain green. Raw logs, setup failures and intermediate failing checks are retained under `/Users/areyouok/arx-tier1-release/twelve-data-traded-volume-20261101/`.
