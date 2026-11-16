// Disposable local PostgreSQL only. Proves the broker_candles -> compact copy
// is lossless (SQL encoder vs rebuilt rows, and vs the app's TS decoder), that
// its verification catches missing / changed bars, and that a bar the new
// writer rewrote is reported as superseded and never overwritten.
import test, { after } from "node:test";
import assert from "node:assert/strict";
import { asc, eq } from "drizzle-orm";
import { db, pool, brokerCandlesTable } from "@workspace/db";
import { deleteSeries, findSeries, jsonbArrayText, readBars } from "../../artifacts/api-server/src/lib/data/brokerCandleRows.js";
import { catchUpRange, copyRange, oldColumns, run, verifyRange, type Client } from "./compactBrokerCandles.js";

const url = new URL(process.env.DATABASE_URL ?? "postgres://invalid");
if (process.env.ARX_REQUIRE_INTEGRATION_DB !== "true" || !["127.0.0.1", "localhost"].includes(url.hostname))
  throw new Error("compactBrokerCandles tests require an explicitly disposable local database");

const BRIDGE = 931_207, USER = 931_207;
const client = pool as unknown as Client;
after(async () => { await clean(); await pool.end(); });

async function clean() {
  await deleteSeries(db, { bridgeConnectionIds: [BRIDGE] });
  await db.delete(brokerCandlesTable).where(eq(brokerCandlesTable.bridgeConnectionId, BRIDGE));
}

/** Old rows covering every encoding branch, inserted with exact µs times. */
async function seed(): Promise<{ lo: number; hi: number; n: number }> {
  const base = "2026-03-02 10:00:00.123456+00";
  const rows: string[] = [
    // all four times derivable (M1)
    `('M1', 'EURUSD', 'id-a', 'acct', '${base}', '${base}'::timestamptz + interval '1 minute', '${base}', '${base}'::timestamptz + interval '1 minute', 'accepted', NULL, true, '2026-03-02 10:01:00.5+00', '2026-03-02 10:01:00.5+00')`,
    // close not derivable, raw open differs, raw close derivable from raw open
    `('M5', 'EURUSD', 'id-a', 'acct', '${base}', '${base}'::timestamptz + interval '4 minutes', '${base}'::timestamptz + interval '2 hours', '${base}'::timestamptz + interval '2 hours 5 minutes', 'finalized', 'late_close', true, '2026-03-02 10:05:00.000001+00', '2026-03-02 10:05:00.000002+00')`,
    // MN1: nothing derivable by interval; raw times NULL
    `('MN1', 'XAUUSD', 'id-a', 'acct', '2026-02-01 00:00:00+00', '2026-03-01 00:00:00+00', NULL, NULL, 'accepted', NULL, true, '2026-03-02 00:00:00+00', '2026-03-02 00:00:00+00')`,
    // forming bar, NULL close, NULL account, legacy identity
    `('H1', 'V75', 'legacy', NULL, '${base}', NULL, NULL, '${base}'::timestamptz + interval '1 hour', 'idempotent', NULL, false, '2026-03-02 11:00:00+00', '2026-03-02 11:00:01+00')`,
    // same legacy native key, another account era: its own series, not relabelled
    `('H1', 'V75', 'legacy', 'other "era" \\ é', '${base}'::timestamptz + interval '1 hour', '${base}'::timestamptz + interval '2 hours', NULL, NULL, 'accepted', E'tab\\there', true, '2026-03-02 12:00:00+00', '2026-03-02 12:00:00+00')`,
  ];
  const { rows: ids } = await pool.query<{ id: number }>(`
    INSERT INTO broker_candles (user_id, bridge_connection_id, timeframe, broker_symbol, history_identity, account_number,
      open_time_utc, close_time_utc, raw_open_time, raw_close_time, quality_status, quality_reason, is_closed_bar,
      received_at, created_at, symbol, server_name, clock_basis, source, terminal_id, price_basis,
      open, high, low, close, tick_volume, tick_volume_observed, real_volume, spread, broker_server_time, updated_at)
    SELECT ${USER}, ${BRIDGE}, v.tf, v.sym, v.ident, v.acct, v.o::timestamptz, v.c::timestamptz, v.ro::timestamptz, v.rc::timestamptz,
      v.q, v.qr, v.closed, v.recv::timestamptz, v.created::timestamptz, v.sym, 'srv', 'broker_server', 'mt5_ea', 'T1', 'bid',
      1.1 + random() / 10, 1.3, 1.0, 1.2, 42, true, NULL, 0.7, now(), '2026-03-02 13:00:00.654321+00'
    FROM (VALUES ${rows.join(",\n")}) v(tf, sym, ident, acct, o, c, ro, rc, q, qr, closed, recv, created)
    RETURNING id`);
  const list = ids.map((r) => Number(r.id));
  return { lo: Math.min(...list) - 1, hi: Math.max(...list), n: list.length };
}

const inTx = async <T>(fn: (c: Client) => Promise<T>) => {
  const c = await pool.connect();
  try { await c.query("BEGIN"); const out = await fn(c as unknown as Client); await c.query("COMMIT"); return out; }
  catch (e) { await c.query("ROLLBACK"); throw e; } finally { c.release(); }
};

test("series and attribute keys match jsonb text on awkward values", async () => {
  const values = [15, "abc", 'q"uote', "back\\slash", "tab\there", "nl\nx", "é ü 日本", "\u0001", null, "U+2028 "];
  const { rows } = await pool.query<{ t: string }>("SELECT jsonb_build_array($1::int, $2::text, $3::text, $4::text, $5::text, $6::text, $7::text, $8::text, $9::text, $10::text)::text AS t", values);
  assert.equal(jsonbArrayText(values), rows[0]!.t);
});

test("the column map covers every broker_candles column", () => {
  // oldColumns() throws when the old table has a column the copy does not carry.
  assert.equal(oldColumns().length, 32);
});

test("copy is lossless, idempotent, and agrees with the app's decoder", async () => {
  await clean();
  const { lo, hi, n } = await seed();
  const first = await inTx((c) => copyRange(c, lo, hi));
  assert.deepEqual({ old: first.old, inserted: first.inserted, equal: first.equal, missing: first.missing, different: first.different, superseded: first.superseded },
    { old: n, inserted: n, equal: n, missing: 0, different: 0, superseded: 0 });
  const again = await inTx((c) => copyRange(c, lo, hi));
  assert.equal(again.inserted, 0); assert.equal(again.equal, n);

  // Five series: the two account eras of one legacy native key stay apart.
  const series = await findSeries(db, { bridgeConnectionIds: [BRIDGE] });
  assert.equal(series.length, 5);
  const { rows: derived } = await pool.query<{ timeframe: string; derived: number }>(
    "SELECT s.timeframe, b.derived FROM broker_candle_bars b JOIN broker_candle_series s ON s.id = b.series_id WHERE s.bridge_connection_id = $1 ORDER BY b.legacy_id", [BRIDGE]);
  assert.deepEqual(derived.map((r) => r.derived), [15, 8, 1, 0, 3], "M1 all; M5 raw close only; MN1 created only; forming none; H1 created + close");

  const old = await db.select().from(brokerCandlesTable).where(eq(brokerCandlesTable.bridgeConnectionId, BRIDGE)).orderBy(asc(brokerCandlesTable.id));
  const decoded = (await readBars(db, series)).sort((a, b) => (a.id ?? 0) - (b.id ?? 0));
  assert.deepEqual(decoded, old);
  await clean();
});

test("verification reports missing and changed bars; a newer write is superseded, catch-up never overwrites it", async () => {
  await clean();
  const { lo, hi, n } = await seed();
  await inTx((c) => copyRange(c, lo, hi));
  const legacy = (k: number) => lo + 1 + k;

  // Changed without a newer write: different.
  await pool.query("UPDATE broker_candle_bars SET close = close + 1 WHERE legacy_id = $1", [legacy(0)]);
  // Missing.
  await pool.query("DELETE FROM broker_candle_bars WHERE legacy_id = $1", [legacy(1)]);
  // The new writer rewrote this bar after the copy: superseded.
  await pool.query("UPDATE broker_candle_bars SET tick_volume = 43, updated_at = now() + interval '1 day' WHERE legacy_id = $1", [legacy(2)]);
  let v = await verifyRange(client, lo, hi);
  assert.deepEqual({ equal: v.equal, different: v.different, missing: v.missing, superseded: v.superseded }, { equal: n - 3, different: 1, missing: 1, superseded: 1 });
  assert.deepEqual(v.sample, [legacy(1), legacy(0)]);

  // A failed batch never advances: copyRange re-inserts the missing bar only.
  const redo = await inTx((c) => copyRange(c, lo, hi));
  assert.equal(redo.inserted, 1); assert.equal(redo.missing, 0); assert.equal(redo.different, 1);

  // The old writer changed a copied bar later: catch-up applies it; the
  // superseded bar (newer) is left alone.
  await pool.query("UPDATE broker_candles SET quality_status = 'finalized', updated_at = '2026-03-03 00:00:00+00' WHERE id = ANY($1)", [[legacy(0), legacy(2)]]);
  const changed = await inTx((c) => catchUpRange(c, lo, hi));
  assert.equal(changed, 1);
  v = await verifyRange(client, lo, hi);
  assert.deepEqual({ equal: v.equal, different: v.different, missing: v.missing, superseded: v.superseded }, { equal: n - 1, different: 0, missing: 0, superseded: 1 });
  const { rows } = await pool.query<{ tick_volume: number }>("SELECT tick_volume FROM broker_candle_bars WHERE legacy_id = $1", [legacy(2)]);
  assert.equal(rows[0]!.tick_volume, 43);
  await clean();
});

test("the runner's dry run changes nothing", async () => {
  const lines: string[] = [];
  const { rows: before } = await pool.query<{ n: number }>("SELECT count(*)::int AS n FROM broker_candle_bars");
  const out = await run(client, { apply: false, catchUp: false, final: false, batch: 1000, maxBatches: 1, sleepMs: 0, timeoutMs: 10_000 }, (l) => lines.push(l));
  assert.equal(out.ok, true);
  assert.match(lines.at(-1)!, /^dry run: would copy ids/);
  const { rows: after } = await pool.query<{ n: number }>("SELECT count(*)::int AS n FROM broker_candle_bars");
  assert.equal(after[0]!.n, before[0]!.n);
});
