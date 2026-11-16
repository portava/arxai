# broker_candles compaction plan (2026-11-16)

Status: **proposed, measured on a real sample, not applied anywhere.** Needs the owner's approval because it changes the dev database schema.

## Why

`broker_candles` on the Replit dev DB is 128 GB (70 GB heap + 58 GB indexes, ~198M rows, ~690 bytes per bar). The size is real history, not bloat or duplicates:

- 1 user, 1 bridge, 1 history identity (99.8%), 43 symbols x 21 timeframes; 354k dead tuples.
- Backfill walks each symbol/timeframe back to the broker's first bar (`depthTargetDaysFor` is informational, never a ceiling). 1,156 of 1,806 chains are still `BUILDING`. Rows arrived at roughly 2M/hour from 2026-11-13 to 11-16.
- The owner needs the full history, so the history is kept. The fix is how each bar is stored.

A bar's market data is ~60 bytes. The rest is per-row repetition: a 64-character history hash, account, broker symbol, symbol, server, clock basis, source, terminal, price basis and quality text on every bar, plus three B-tree indexes, two of which carry those text columns.

## Design

| Table | Holds | Rows |
|---|---|---|
| `broker_candle_series` | one row per (bridge, history identity, broker symbol, timeframe) with its constant attributes: user, symbol, account, server, clock basis | ~1.8k |
| `broker_candle_provenance` | distinct (source, terminal id, price basis) | tens |
| `broker_candle_quality` | distinct (status, reason) | a few |
| `broker_candle_bars` | per bar: series id, open time, OHLC, volumes, spread, flags, receipt/update times, original id | all bars |

- Primary key `(series_id, open_time_utc)` replaces the unique key and the read index: same dedupe, one index.
- Time columns that equal a value computable from the bar itself are stored NULL, and a `derived` bitmask records which: `created_at = received_at`, `close = open + interval`, `raw_open = open`, `raw_close = raw_open + interval`. A clear bit with NULL is a real NULL. MN1 is never derived (no fixed length).
- Every original column and value is reproducible. Reads use the series first, then a primary-key range scan.

## Measured (750,000 real rows exported read-only from Replit: EURUSD M1, V75 M5, XAUUSD M15, USDJPY H1)

| Layout | Bytes per bar | Sample size |
|---|---|---|
| Current, freshly loaded | 557 | 399 MB |
| Compact | 199 | 142 MB |
| Compact + derived times | **166** | 119 MB |

- Round trip: rebuilding all rows from the compact tables and comparing with `EXCEPT ALL` both ways gives **0 missing or changed, 0 extra** for both variants.
- Chart read (latest 2,000 M1 bars): about 106 pages in either layout.
- Projected on the live table: ~198M x 166 bytes = **~33 GB fresh-packed instead of 128 GB**, likely 35-40 GB once it has grown in place. New bars cost ~4x less while the backfill continues.
- The live table is less tightly packed than a fresh load (690 vs 557 bytes per bar), so the live gain should be at least this large; it is measured only on the sample.

Prototype SQL: `scratchpad/bcsample/compact.sql`, `compact2.sql` in the session that produced this. The real migration is to be written as reviewed SQL, not drizzle push-force.

## Migration steps (no deletion until verified)

1. Create the new tables with an explicit SQL migration (never push-force on Replit).
2. Switch the writer (`brokerCandleStore.ts`) to the new tables, keeping its validation, immutability and idempotency rules. The old table stops growing. Readers go through one read function that checks the new tables first, then the old one.
3. Copy old rows into the new tables in id-ordered batches (for example 500k), each batch verified with the `EXCEPT ALL` round trip before the next. Resumable and read-only on the old table. Needs ~35-40 GB of temporary headroom.
4. Point every reader (about 29 non-test files mention the table) at the new tables and run the full suite plus the CI integration lane.
5. After the full copy verifies, **the owner** decides when to drop the old table (frees ~128 GB). Until then it is the rollback.

## Not changed

- No bar, price, timestamp or provenance value is altered or dropped.
- Closed candles stay immutable; the copy never rewrites the source.
- The backfill keeps walking to the broker's first bar.

## Open questions for the owner

- Approve the schema change on the dev DB.
- Replit's storage limit and cost: the DB refused writes at 46 GB on 2026-11-14 but is now at 131 GB and accepting writes. The copy needs ~35-40 GB of headroom.
- Keep `legacy_id` (the original `id`, 4 bytes per bar)? Nothing in the code references it; it is kept for traceability.
