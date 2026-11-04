// Broker clock offset persistence (owner-decision option, droppable commit):
// best-effort write on change / every 10 min, lazy non-blocking reseed from
// the stored row within the TTL as one "persisted" sample.
import { test, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import {
  BROKER_CLOCK_OFFSET_TTL_MS,
  BROKER_CLOCK_PERSIST_INTERVAL_MS,
  __resetBrokerClockOffsets,
  getBrokerClockOffset,
  recordBrokerClockSample,
  seedBrokerClockOffset,
  seedBrokerClockOffsetFromConnection,
  setBrokerClockOffsetPersistence,
} from "../brokerClockOffset.js";

const T0 = Date.UTC(2026, 10, 4, 9, 0, 0);
const H = 60 * 60_000;
const flush = () => new Promise((r) => setImmediate(r));

let writes: { id: number; offsetMs: number; measuredAtMs: number }[] = [];
let stored = new Map<number, { offsetMs: number | null; measuredAtMs: number | null }>();
let reads = 0;
beforeEach(() => {
  __resetBrokerClockOffsets();
  writes = []; stored = new Map(); reads = 0;
  setBrokerClockOffsetPersistence({
    persist: async (id, offsetMs, measuredAtMs) => { writes.push({ id, offsetMs, measuredAtMs }); },
    seed: async (id) => { reads++; return stored.get(id) ?? null; },
  });
});
afterEach(() => setBrokerClockOffsetPersistence(null));

const sample = (id: number, offsetMs: number, nowMs: number) =>
  recordBrokerClockSample({ bridgeConnectionId: id, brokerMs: nowMs + offsetMs, gmtMs: nowMs, basis: "heartbeat", nowMs });

test("writes on the first measurement, on a change, and at most every 10 min otherwise", async () => {
  sample(5, 2 * H, T0);
  sample(5, 2 * H, T0 + 60_000);
  sample(5, 2 * H, T0 + BROKER_CLOCK_PERSIST_INTERVAL_MS - 1);
  await flush();
  assert.deepEqual(writes.map((w) => w.offsetMs), [2 * H]);
  sample(5, 2 * H, T0 + BROKER_CLOCK_PERSIST_INTERVAL_MS);
  await flush();
  assert.equal(writes.length, 2);
  // A DST move: the mode changes once the new offset outnumbers the old.
  for (let i = 1; i <= 4; i++) sample(5, 3 * H, T0 + BROKER_CLOCK_PERSIST_INTERVAL_MS + i * 1000);
  await flush();
  assert.equal(writes.at(-1)!.offsetMs, 3 * H);
  assert.ok(writes.every((w) => w.id === 5));
});

test("an unattributed bridge is never persisted; a failed write never throws into ingest", async () => {
  sample(null as never, 2 * H, T0);
  await flush();
  assert.equal(writes.length, 0);
  setBrokerClockOffsetPersistence({ persist: async () => { throw new Error("db down"); }, seed: async () => null });
  assert.equal(sample(6, 2 * H, T0), 2 * H);
  await flush();
  assert.equal(getBrokerClockOffset(6, T0)?.offsetMs, 2 * H);
});

test("a miss answers unknown now, seeds asynchronously, and serves the persisted offset next", async () => {
  stored.set(9, { offsetMs: 2 * H, measuredAtMs: T0 - H });
  assert.equal(getBrokerClockOffset(9, T0), null, "never blocks on I/O");
  await flush(); await flush();
  const o = getBrokerClockOffset(9, T0);
  assert.equal(o?.offsetMs, 2 * H);
  assert.equal(o?.basis, "persisted");
  assert.equal(o?.agreeingSamples, 1);
  assert.equal(o?.measuredAtMs, T0 - H);
  // Lookups are rate-limited per bridge.
  getBrokerClockOffset(10, T0); getBrokerClockOffset(10, T0 + 1000);
  await flush();
  assert.equal(reads, 2);
});

test("a stored value older than the TTL, off-grid, or missing is not used", () => {
  assert.equal(seedBrokerClockOffset(1, { offsetMs: 2 * H, measuredAtMs: T0 - BROKER_CLOCK_OFFSET_TTL_MS - 1 }, T0), false);
  assert.equal(seedBrokerClockOffset(1, { offsetMs: 2 * H + 5 * 60_000, measuredAtMs: T0 }, T0), false);
  assert.equal(seedBrokerClockOffset(1, { offsetMs: null, measuredAtMs: T0 }, T0), false);
  assert.equal(seedBrokerClockOffset(null, { offsetMs: 2 * H, measuredAtMs: T0 }, T0), false);
  assert.equal(getBrokerClockOffset(1, T0), null);
});

test("a seed never overrides live samples, and live samples win over the seed", () => {
  sample(3, 3 * H, T0);
  assert.equal(seedBrokerClockOffset(3, { offsetMs: 2 * H, measuredAtMs: T0 }, T0), false);
  assert.equal(seedBrokerClockOffsetFromConnection({ id: 4, brokerClockOffsetMs: 2 * H, brokerClockOffsetMeasuredAt: new Date(T0 - H) }, T0), true);
  sample(4, 3 * H, T0 + 1000);
  assert.equal(getBrokerClockOffset(4, T0 + 1000)?.offsetMs, 3 * H, "tie → the newest sample's offset");
  assert.equal(getBrokerClockOffset(4, T0 + 1000)?.basis, "heartbeat");
});

test("migration is additive and idempotent; the heartbeat seeds from its own row", () => {
  const sql = readFileSync(new URL("../../../../../../lib/db/migrations/2026-11-04_broker_clock_offset.sql", import.meta.url), "utf8");
  assert.match(sql, /ADD COLUMN IF NOT EXISTS broker_clock_offset_ms integer/);
  assert.match(sql, /ADD COLUMN IF NOT EXISTS broker_clock_offset_measured_at timestamp/);
  assert.doesNotMatch(sql.replace(/--.*$/gm, ""), /\b(DROP|UPDATE|DELETE)\b/i);
  const mt5 = readFileSync(new URL("../../../routes/mt5.ts", import.meta.url), "utf8");
  assert.match(mt5, /seedBrokerClockOffsetFromConnection\(userConn, heartbeatReceivedAt\.getTime\(\)\);\s*recordBrokerClockSample/);
  const boot = readFileSync(new URL("../../../index.ts", import.meta.url), "utf8");
  assert.match(boot, /installBrokerClockOffsetPersistence\(\)/);
});
