# broker_candles compaction plan (2026-11-16)

Status: **built and tested; not applied to the Replit database.** Applying the migration and running the copy there needs the owner's approval because it changes the dev database schema.

## Why

`broker_candles` on the Replit dev DB is 128 GB (70 GB heap + 58 GB indexes, ~198M rows, ~690 bytes per bar). The size is real history, not bloat or duplicates:

- 1 user, 1 bridge, 1 history identity (99.8%), 43 symbols x 21 timeframes; 354k dead tuples.
- Backfill walks each symbol/timeframe back to the broker's first bar (`depthTargetDaysFor` is informational, never a ceiling). 1,156 of 1,806 chains are still `BUILDING`. Rows arrived at roughly 2M/hour from 2026-11-13 to 11-16.
- The owner needs the full history, so the history is kept. The fix is how each bar is stored.

A bar's market data is ~60 bytes. The rest is per-row repetition: a 64-character history hash, account, broker symbol, symbol, server, clock basis, source, terminal, price basis and quality text on every bar, plus three B-tree indexes, two of which carry those text columns.

## Design

| Table | Holds | Rows |
|---|---|---|
| `broker_candle_series` | one row per distinct (bridge, history identity, broker symbol, timeframe, user, symbol, account, server, clock basis); `series_key` is their exact JSON | ~1.8k |
| `broker_candle_attrs` | distinct (source, terminal id, price basis, quality status, quality reason) | tens |
| `broker_candle_bars` | per bar: series id, open time, OHLC, volumes, spread, flags, receipt/update times, original id | all bars |
| `broker_candle_compact_progress` | one row: how far the copy has got | 1 |

- For a current history identity the series values are part of the identity hash, so there is one series per native key; the live writer refuses a push that would relabel one (`series_<field>_conflict`). Legacy-identity rows can differ in account or symbol inside one native key; each variant becomes its own series, so nothing is relabelled.
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

## Built (branch codex/arx-history-system-repair-20261113)

- Migration `lib/db/migrations/2026-11-16_broker_candle_compact.sql` (additive; rollback file alongside) and drizzle schema `lib/db/src/schema/brokerCandleBars.ts`.
- `artifacts/api-server/src/lib/data/brokerCandleRows.ts`: the one read/write layer. Reads are series-first (`findSeries` then `readBars` on the primary key); the writer (`brokerCandleStore.ts`) keeps its validation, immutability and idempotency rules through `upsertBars`. Every reader of the old table now reads the new tables.
- `scripts/src/compactBrokerCandles.ts` (`pnpm --filter @workspace/scripts run compact:broker-candles`): copies broker_candles in id batches, one transaction each; every batch is verified row by row (each old column rebuilt from the compact tables, `IS NOT DISTINCT FROM`) before its progress is saved, and a batch that fails is rolled back and stops the run. Dry run by default, `--apply` to write, `--catch-up` after deploy, `--final` to verify every row. Never modifies the old table.
- Tests: `scripts/src/compactBrokerCandles.test.ts` (every encoding branch, decoder agreement, missing/changed/superseded detection, catch-up), plus every converted reader and writer test.

Measured with the real script on the 750,000-row sample: **750,000 identical, 0 missing or different**; 399 MB old vs 136 MB new (~181 bytes per bar including the copy's original id), so roughly **36 GB for the current ~198M bars**.

## Cutover on Replit (needs the owner's approval; nothing done yet)

1. Check storage headroom (~40 GB) and apply the migration with `psql -f` (never drizzle push-force).
2. Run the copy while the current build is still writing the old table: `compact:broker-candles -- --apply` (resumable; about 1,000 batches).
3. Deploy the new build. The old table stops growing; new bars go to the compact tables.
4. Run `--apply --catch-up` once: copies ids written between step 2 and the deploy, and applies later old-writer changes to bars copied earlier. A bar the new writer has rewritten since is newer and is kept (reported as superseded).
5. Run `--final`: every old row must be identical or superseded.
6. **The owner** decides when to drop `broker_candles` (frees ~128 GB). Until then it is the rollback.

## Not changed

- No bar, price, timestamp or provenance value is altered or dropped.
- Closed candles stay immutable; the copy never rewrites the source.
- The backfill keeps walking to the broker's first bar.

## Open questions for the owner

- Approve the schema change on the dev DB.
- Replit's storage limit and cost: the DB refused writes at 46 GB on 2026-11-14 but is now at 131 GB and accepting writes. The copy needs ~35-40 GB of headroom.
- Keep `legacy_id` (the original `id`, 4 bytes per bar)? Nothing in the code references it; it is kept for traceability.
