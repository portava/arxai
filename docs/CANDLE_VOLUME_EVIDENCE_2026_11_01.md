# Source-qualified candle volume — 1 November 2026

Base: `e50035efee42e804a6aad3c9b27aa49c8c678a99` (Truth source-identity fix). This is a bounded development contract addition, not a release or feature-parity claim.

## Contract

`Candle.volumeEvidence` and normalized/API `ChartCandle.volumeEvidence` are optional for old-wire compatibility. New normalization emits `{ kind, quantity, unit, reason }` explicitly. Supported observations are `tick_count` in `ticks`, finite nonnegative safe integers, from the exact `mt5_broker` source. An observed zero ticks remains zero. Missing, malformed, negative, fractional or unsupported evidence yields `unavailable`, null quantity and units, with an explanation.

`real_volume` / `broker_units` are reserved for a future positively supported producer and never emitted by this change. Neither a generic numeric volume nor MT5 real_volume=0 establishes traded volume. Synthetic/mock/third-party declarations cannot borrow MT5 tick semantics. The legacy numeric `volume` field remains compatible and its API description now explicitly says it is ambiguous; consumers must use the evidence.

## Producer mapping and boundaries

- Direct `/mt5/sync-candles`: retain only the explicit `tickVolume` observation before its legacy `tickVolume ?? volume` alias.
- `ingestMt5CandleHistory`: same, retained in the existing live mirror. Tests use mocked cache/provider functions; no database or broker connection.
- `ingestBrokerCandles`: preserve the original explicit field in its in-memory intermediate row and closed-bar mirror. Existing database columns/writes and schema are unchanged. No existing database was touched during this work.
- Existing persisted `market_candles` rows retain only ambiguous numeric volume. Reads honestly become unavailable rather than upgrading old rows. BrokerHub's `realVolume ?? tickVolume` projection is not qualified by this change.
- MT5 generic stream `volume` aliases remain unavailable. The shipped EA's candle batch explicitly sends `tickVolume`, so that existing path can carry qualified counts.
- Both appended and same-bar merged forming tips explicitly clear inherited evidence: the server's partial observed tick count is not a complete broker candle count.
- Current provider merging replaces the entire candle at a matching time; normalization keeps the selected duplicate's evidence. No candle timeframe resampler that spreads last-constituent metadata was found in data/router/domain searches. Any future resampling must clear evidence unless complete exact summation and units are established.

The existing chart source identity, timestamps, finality and quality authorities remain responsible for the surrounding candle context. Volume evidence adds quantity semantics; it does not make a stale candle current or grant liquidity/order-flow/trading authority.

## Validation

- Before implementation: eight new normalized-volume acceptance tests failed, two existing shape tests passed.
- After: `test:chart-candle-shape` 30/30 (24 pure shape/evidence cases and six real history-producer-to-normalizer cases with I/O mocked).
- `test:chart-truth-fixtures`: 52/52.
- `test:forming-tip-source-gate`: 18/18, including same-bar and appended-tip evidence invalidation.
- OpenAPI/React client/Zod regeneration succeeded with the existing offline build environment.
- API typecheck passed after correcting a test fixture's widened source type to the exact MT5 source literal.
- Root and AI-capability agent independently reviewed the source/provenance changes with no blocker. They confirmed the explicit limitation that existing DB-cache rehydration has no volume evidence until a fresh qualified observation arrives.
- `git diff --check` passed.

No live/demo broker tests, network data requests, database migration or existing database writes were performed. DB-backed route integration suites remain unrun; parent must validate the final combined source separately. Frontend volume rendering is a separate coordinated agent change. Traded-volume VWAP and volume profile remain unsupported until their own proven contracts exist.
