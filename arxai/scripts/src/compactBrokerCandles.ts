// One-time copy of broker_candles into the compact store
// (broker_candle_series / broker_candle_attrs / broker_candle_bars).
// See docs/BROKER_CANDLES_COMPACTION_PLAN.md.
//
// What it does, per batch of broker_candles ids (one transaction each):
//   1. creates the series and attribute rows the batch needs;
//   2. inserts its bars, storing a computable time as NULL + a `derived` bit
//      (rules built from FIXED_TIMEFRAME_SECONDS, the same table the app uses);
//   3. verifies every old row of the batch against the stored compact row,
//      rebuilt column by column, compared with IS NOT DISTINCT FROM;
//   4. advances broker_candle_compact_progress.last_id.
// A batch that does not verify is rolled back and the run stops with a report.
//
// Re-running after the new code is deployed (the old table no longer grows)
// first copies the remaining ids, then `--catch-up` brings copied bars that the
// OLD writer changed after their copy up to date. A bar the NEW writer has
// rewritten since (newer updated_at) is kept and counted as superseded, never
// overwritten with the older value.
//
// SAFETY
//   - Never modifies or deletes broker_candles. Dropping it is a separate step
//     the owner takes after `--final` verifies everything.
//   - Dry run by default (reports what would happen). `--apply` writes.
//   - One copier at a time (advisory lock). Each statement has a timeout.
//   - Needs the 2026-11-16_broker_candle_compact.sql migration applied first.
//
// Run:
//   pnpm --filter @workspace/scripts run compact:broker-candles                  # dry run
//   pnpm --filter @workspace/scripts run compact:broker-candles -- --apply [--batch 200000] [--max-batches N] [--sleep-ms 200]
//   pnpm --filter @workspace/scripts run compact:broker-candles -- --apply --catch-up
//   pnpm --filter @workspace/scripts run compact:broker-candles -- --final      # full verification, read-only

import { getTableColumns } from "drizzle-orm";
import { brokerCandlesTable } from "@workspace/db";
import { FIXED_TIMEFRAME_SECONDS } from "../../artifacts/api-server/src/lib/data/brokerCandleRows.js";

export interface Client { query<R = Record<string, unknown>>(sql: string, params?: unknown[]): Promise<{ rows: R[]; rowCount?: number | null }> }

const LOCK_KEY = 7_316_116; // arbitrary, fixed: one copier at a time

/** Interval of a fixed-length timeframe in SQL, or NULL (MN1 and unknown). */
function intervalSql(timeframeExpr: string): string {
  const whens = Object.entries(FIXED_TIMEFRAME_SECONDS)
    .map(([tf, seconds]) => `WHEN '${tf.replace(/'/g, "''")}' THEN interval '${seconds} seconds'`).join(" ");
  return `(CASE ${timeframeExpr} ${whens} ELSE NULL END)`;
}

const seriesKeySql = (o: string) => `jsonb_build_array(${o}.bridge_connection_id, ${o}.history_identity, ${o}.broker_symbol, ${o}.timeframe,
  ${o}.user_id, ${o}.symbol, ${o}.account_number, ${o}.server_name, ${o}.clock_basis)::text`;
const attrsKeySql = (o: string) => `jsonb_build_array(${o}.source, ${o}.terminal_id, ${o}.price_basis, ${o}.quality_status, ${o}.quality_reason)::text`;

/** Every broker_candles column, rebuilt from the compact tables (s, a, b). */
function rebuiltColumns(): Record<string, string> {
  const iv = intervalSql("s.timeframe");
  const rawOpen = "(CASE WHEN b.derived & 4 <> 0 THEN b.open_time_utc ELSE b.raw_open_time END)";
  return {
    id: "b.legacy_id",
    user_id: "s.user_id", bridge_connection_id: "s.bridge_connection_id", history_identity: "s.history_identity",
    account_number: "s.account_number", broker_symbol: "s.broker_symbol", symbol: "s.symbol", timeframe: "s.timeframe",
    open_time_utc: "b.open_time_utc",
    close_time_utc: `(CASE WHEN b.derived & 2 <> 0 THEN b.open_time_utc + ${iv} ELSE b.close_time_utc END)`,
    open: "b.open", high: "b.high", low: "b.low", close: "b.close",
    tick_volume: "b.tick_volume", tick_volume_observed: "b.tick_volume_observed", real_volume: "b.real_volume", spread: "b.spread",
    source: "a.source", terminal_id: "a.terminal_id", server_name: "s.server_name", clock_basis: "s.clock_basis",
    raw_open_time: rawOpen,
    raw_close_time: `(CASE WHEN b.derived & 8 <> 0 THEN ${rawOpen} + ${iv} ELSE b.raw_close_time END)`,
    price_basis: "a.price_basis", is_closed_bar: "b.is_closed_bar", broker_server_time: "b.broker_server_time",
    quality_status: "a.quality_status", quality_reason: "a.quality_reason",
    received_at: "b.received_at",
    created_at: "(CASE WHEN b.derived & 1 <> 0 THEN b.received_at ELSE b.created_at END)",
    updated_at: "b.updated_at",
  };
}

/** Old column names, in table order. Fails if the old table gained a column
 * this script does not carry (nothing may be dropped silently). */
export function oldColumns(): string[] {
  const names = Object.values(getTableColumns(brokerCandlesTable)).map((c) => c.name);
  const rebuilt = rebuiltColumns();
  const missing = names.filter((n) => !(n in rebuilt));
  const extra = Object.keys(rebuilt).filter((n) => !names.includes(n));
  if (missing.length || extra.length) throw new Error(`column map out of date: missing ${missing.join(",") || "-"}, extra ${extra.join(",") || "-"}`);
  return names;
}

/** Encoded bar values from an old row `o` (s, a = its series and attrs). */
function encodedBarSelect(): string {
  const iv = intervalSql("o.timeframe");
  const created = "(o.created_at = o.received_at)";
  const close = `(${iv} IS NOT NULL AND o.close_time_utc = o.open_time_utc + ${iv})`;
  const rawOpen = "(o.raw_open_time = o.open_time_utc)";
  const rawClose = `(${iv} IS NOT NULL AND o.raw_open_time IS NOT NULL AND o.raw_close_time = o.raw_open_time + ${iv})`;
  const bit = (cond: string, value: number) => `(CASE WHEN coalesce(${cond}, false) THEN ${value} ELSE 0 END)`;
  return `SELECT o.open_time_utc,
      CASE WHEN coalesce(${close}, false) THEN NULL ELSE o.close_time_utc END,
      o.broker_server_time,
      CASE WHEN coalesce(${rawOpen}, false) THEN NULL ELSE o.raw_open_time END,
      CASE WHEN coalesce(${rawClose}, false) THEN NULL ELSE o.raw_close_time END,
      o.received_at,
      CASE WHEN coalesce(${created}, false) THEN NULL ELSE o.created_at END,
      o.updated_at, o.open, o.high, o.low, o.close, o.tick_volume, o.real_volume, o.spread,
      s.id, o.id, a.id,
      (${bit(created, 1)} | ${bit(close, 2)} | ${bit(rawOpen, 4)} | ${bit(rawClose, 8)})::smallint,
      o.is_closed_bar, o.tick_volume_observed`;
}
const BAR_COLUMNS = `open_time_utc, close_time_utc, broker_server_time, raw_open_time, raw_close_time, received_at, created_at,
  updated_at, open, high, low, close, tick_volume, real_volume, spread, series_id, legacy_id, attrs_id, derived, is_closed_bar, tick_volume_observed`;

const batchRows = "broker_candles o WHERE o.id > $1 AND o.id <= $2";
const joinSeriesAttrs = `JOIN broker_candle_series s ON s.series_key = ${seriesKeySql("o")}
  JOIN broker_candle_attrs a ON a.attrs_key = ${attrsKeySql("o")}`;

export interface BatchResult { lo: number; hi: number; old: number; inserted: number; equal: number; superseded: number; missing: number; different: number; sample: unknown[] }

/** Verify the old rows with ids in (lo, hi] against the compact store. */
export async function verifyRange(c: Client, lo: number, hi: number): Promise<Omit<BatchResult, "inserted">> {
  const cols = oldColumns();
  const rebuilt = rebuiltColumns();
  const oldRow = `ROW(${cols.map((n) => `o.${n === "open" || n === "close" ? `"${n}"` : n}`).join(", ")})`;
  const newRow = `ROW(${cols.map((n) => rebuilt[n]).join(", ")})`;
  const { rows } = await c.query<{ status: string; n: number; sample: unknown[] | null }>(`
    WITH checked AS (
      SELECT o.id,
        CASE WHEN b.series_id IS NULL THEN 'missing'
             WHEN ${oldRow} IS NOT DISTINCT FROM ${newRow} THEN 'equal'
             WHEN b.updated_at > o.updated_at THEN 'superseded'
             ELSE 'different' END AS status
      FROM broker_candles o
      LEFT JOIN broker_candle_series s ON s.series_key = ${seriesKeySql("o")}
      LEFT JOIN broker_candle_bars b ON b.series_id = s.id AND b.open_time_utc = o.open_time_utc
      LEFT JOIN broker_candle_attrs a ON a.id = b.attrs_id
      WHERE o.id > $1 AND o.id <= $2)
    SELECT status, count(*)::int AS n, (array_agg(id ORDER BY id))[1:5] AS sample FROM checked GROUP BY status`, [lo, hi]);
  const by = Object.fromEntries(rows.map((r) => [r.status, r]));
  const n = (k: string) => by[k]?.n ?? 0;
  return { lo, hi, old: rows.reduce((t, r) => t + r.n, 0), equal: n("equal"), superseded: n("superseded"), missing: n("missing"),
    different: n("different"), sample: [...(by.missing?.sample ?? []), ...(by.different?.sample ?? [])] };
}

/** Copy ids in (lo, hi] and verify them, inside the caller's transaction. */
export async function copyRange(c: Client, lo: number, hi: number): Promise<BatchResult> {
  await c.query(`INSERT INTO broker_candle_series (series_key, bridge_connection_id, history_identity, broker_symbol, timeframe,
      user_id, symbol, account_number, server_name, clock_basis)
    SELECT DISTINCT ${seriesKeySql("o")}, o.bridge_connection_id, o.history_identity, o.broker_symbol, o.timeframe,
      o.user_id, o.symbol, o.account_number, o.server_name, o.clock_basis
    FROM ${batchRows} ON CONFLICT (series_key) DO NOTHING`, [lo, hi]);
  await c.query(`INSERT INTO broker_candle_attrs (attrs_key, source, terminal_id, price_basis, quality_status, quality_reason)
    SELECT DISTINCT ${attrsKeySql("o")}, o.source, o.terminal_id, o.price_basis, o.quality_status, o.quality_reason
    FROM ${batchRows} ON CONFLICT (attrs_key) DO NOTHING`, [lo, hi]);
  // A bar the new writer already stored is left as it is (verified below as
  // equal or superseded, never overwritten with the older value).
  const inserted = await c.query(`INSERT INTO broker_candle_bars (${BAR_COLUMNS})
    ${encodedBarSelect()} FROM broker_candles o ${joinSeriesAttrs} WHERE o.id > $1 AND o.id <= $2
    ON CONFLICT (series_id, open_time_utc) DO NOTHING`, [lo, hi]);
  const verified = await verifyRange(c, lo, hi);
  return { ...verified, inserted: inserted.rowCount ?? 0 };
}

/** Bring copied bars up to date with old-writer changes made after the copy.
 * Only rows still holding the copied value (same legacy id, older updated_at)
 * are rewritten; anything the new writer touched since is newer and kept. */
export async function catchUpRange(c: Client, lo: number, hi: number): Promise<number> {
  await c.query(`INSERT INTO broker_candle_attrs (attrs_key, source, terminal_id, price_basis, quality_status, quality_reason)
    SELECT DISTINCT ${attrsKeySql("o")}, o.source, o.terminal_id, o.price_basis, o.quality_status, o.quality_reason
    FROM ${batchRows} ON CONFLICT (attrs_key) DO NOTHING`, [lo, hi]);
  const updated = await c.query(`UPDATE broker_candle_bars b SET
      (${BAR_COLUMNS}) = (${encodedBarSelect().replace(/^SELECT /, "")})
    FROM broker_candles o ${joinSeriesAttrs}
    WHERE o.id > $1 AND o.id <= $2 AND b.series_id = s.id AND b.open_time_utc = o.open_time_utc
      AND b.legacy_id = o.id AND b.updated_at < o.updated_at`, [lo, hi]);
  return updated.rowCount ?? 0;
}

interface Options { apply: boolean; catchUp: boolean; final: boolean; batch: number; maxBatches: number; sleepMs: number; timeoutMs: number }

function parseArgs(argv: string[]): Options {
  const num = (flag: string, fallback: number) => {
    const i = argv.indexOf(flag);
    if (i < 0) return fallback;
    const v = Number(argv[i + 1]);
    if (!Number.isInteger(v) || v <= 0) throw new Error(`${flag} needs a positive integer`);
    return v;
  };
  return { apply: argv.includes("--apply"), catchUp: argv.includes("--catch-up"), final: argv.includes("--final"),
    batch: num("--batch", 200_000), maxBatches: num("--max-batches", Number.MAX_SAFE_INTEGER),
    sleepMs: argv.includes("--sleep-ms") ? num("--sleep-ms", 0) : 0, timeoutMs: num("--statement-timeout-ms", 120_000) };
}

async function inTx<T>(c: Client, timeoutMs: number, fn: () => Promise<T>): Promise<T> {
  await c.query("BEGIN");
  try {
    await c.query(`SET LOCAL statement_timeout = ${Math.floor(timeoutMs)}`);
    const out = await fn();
    await c.query("COMMIT");
    return out;
  } catch (e) { await c.query("ROLLBACK"); throw e; }
}

export async function run(c: Client, o: Options, log: (line: string) => void = console.log): Promise<{ ok: boolean }> {
  oldColumns();
  const [{ maxId }] = (await c.query<{ maxId: number }>("SELECT coalesce(max(id), 0)::bigint::float8 AS \"maxId\" FROM broker_candles")).rows as [{ maxId: number }];
  if (o.apply) await c.query("INSERT INTO broker_candle_compact_progress (id) VALUES (1) ON CONFLICT (id) DO NOTHING");
  const progress = (await c.query<{ last_id: number; rows_copied: number; rows_superseded: number }>(
    "SELECT last_id::float8 AS last_id, rows_copied::float8 AS rows_copied, rows_superseded::float8 AS rows_superseded FROM broker_candle_compact_progress WHERE id = 1")).rows[0]
    ?? { last_id: 0, rows_copied: 0, rows_superseded: 0 };
  log(`broker_candles max id ${maxId}; copied and verified through id ${progress.last_id} (${progress.rows_copied} rows, ${progress.rows_superseded} superseded)`);

  if (o.final) {
    let bad = 0, total = 0, superseded = 0;
    for (let lo = 0; lo < maxId; lo += o.batch) {
      const r = await inTx(c, o.timeoutMs, () => verifyRange(c, lo, lo + o.batch));
      total += r.old; superseded += r.superseded; bad += r.missing + r.different;
      if (r.missing + r.different) log(`ids ${lo + 1}-${lo + o.batch}: ${r.missing} missing, ${r.different} different (e.g. ids ${r.sample.join(",")})`);
    }
    log(`final: ${total} old rows, ${total - bad - superseded} identical, ${superseded} superseded by newer writes, ${bad} missing or different`);
    return { ok: bad === 0 && (total > 0) === (maxId > 0) };
  }

  if (!o.apply) {
    log(`dry run: would copy ids ${progress.last_id + 1}-${maxId} in batches of ${o.batch}${o.catchUp ? ", then catch up ids 1-" + progress.last_id : ""}. Re-run with --apply.`);
    return { ok: true };
  }
  const [{ locked }] = (await c.query<{ locked: boolean }>("SELECT pg_try_advisory_lock($1) AS locked", [LOCK_KEY])).rows as [{ locked: boolean }];
  if (!locked) { log("another copier holds the lock; stopping"); return { ok: false }; }
  try {
    if (o.catchUp) {
      let changed = 0;
      for (let lo = 0; lo < progress.last_id; lo += o.batch) {
        const hi = Math.min(lo + o.batch, progress.last_id);
        changed += await inTx(c, o.timeoutMs, () => catchUpRange(c, lo, hi));
      }
      log(`catch-up: ${changed} copied bars updated to the old writer's later values`);
    }
    let lo = progress.last_id, batches = 0;
    while (lo < maxId && batches < o.maxBatches) {
      const hi = Math.min(lo + o.batch, maxId);
      const started = Date.now();
      let result: BatchResult;
      try {
        result = await inTx(c, o.timeoutMs, async () => {
          const r = await copyRange(c, lo, hi);
          if (r.missing || r.different) throw Object.assign(new Error("BATCH_NOT_VERIFIED"), { result: r });
          await c.query(`UPDATE broker_candle_compact_progress SET last_id = $1, rows_copied = rows_copied + $2,
            rows_superseded = rows_superseded + $3, updated_at = now() WHERE id = 1`, [hi, r.equal, r.superseded]);
          return r;
        });
      } catch (e) {
        const r = (e as { result?: BatchResult }).result;
        if (!r) throw e;
        log(`ids ${lo + 1}-${hi}: NOT VERIFIED, rolled back: ${r.missing} missing, ${r.different} different (e.g. ids ${r.sample.join(",")})`);
        return { ok: false };
      }
      log(`ids ${lo + 1}-${hi}: ${r(result)} in ${Date.now() - started} ms`);
      lo = hi; batches++;
      if (o.sleepMs) await new Promise((res) => setTimeout(res, o.sleepMs));
    }
    log(lo >= maxId ? `copied through id ${lo} (current max). Run --final to verify every row.` : `stopped after ${batches} batches at id ${lo}`);
    return { ok: true };
  } finally {
    await c.query("SELECT pg_advisory_unlock($1)", [LOCK_KEY]);
  }
}
const r = (b: BatchResult) => `${b.old} rows, ${b.inserted} inserted, ${b.equal} identical, ${b.superseded} superseded`;

if (process.argv[1] && /compactBrokerCandles\.[tj]s$/.test(process.argv[1])) {
  const { pool } = await import("@workspace/db");
  const client = await pool.connect();
  run(client as unknown as Client, parseArgs(process.argv.slice(2))).then(
    ({ ok }) => { client.release(); return pool.end().then(() => process.exit(ok ? 0 : 1)); },
    (e) => { console.error(e instanceof Error ? e.message : e); client.release(); process.exit(1); },
  );
}
