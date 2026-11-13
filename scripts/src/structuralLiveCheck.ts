/** Bounded, read-only real-feed check using the actual service and receipt store.
 * Refuses every database except this task's explicitly isolated local database.
 */
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import assert from "node:assert/strict";
import type { StructuralBar, DataOrigin } from "@workspace/domain/structural";
import { StructuralForecastService } from "../../artifacts/api-server/src/lib/structural/service.js";
import { fitInWorker } from "../../artifacts/api-server/src/lib/structural/fitAsync.js";
const database = process.env.ARX_STRUCTURAL_TEST_DATABASE_URL;
if (!database || new URL(database).hostname !== "127.0.0.1" || !new URL(database).pathname.startsWith("/arx_structural_pr150_")) throw new Error("DISPOSABLE_LOCAL_DATABASE_REQUIRED");
process.env.DATABASE_URL = database;
const { structuralRepository } = await import("../../artifacts/api-server/src/lib/structural/repository.js");
const output = resolve(process.argv[2] ?? "");
if (!process.argv[2] || !process.argv[3]) throw new Error("Pass output directory and captured V75 JSON path");
await mkdir(output, { recursive: true });
const seed = JSON.parse(await readFile(resolve(process.argv[3]), "utf8")) as { bars: StructuralBar[] };
async function readFeed() {
  const response: any = await new Promise((resolve, reject) => {
    const ws = new WebSocket("wss://api.derivws.com/trading/v1/options/ws/public");
    const timer = setTimeout(() => { ws.close(); reject(new Error("FEED_TIMEOUT")); }, 15_000);
    ws.onopen = () => ws.send(JSON.stringify({ ticks_history: "R_75", style: "candles", granularity: 60, count: 1000, end: "latest", req_id: 1 }));
    ws.onerror = () => { clearTimeout(timer); ws.close(); reject(new Error("FEED_CONNECTION_FAILED")); };
    ws.onmessage = e => { const r = JSON.parse(String(e.data)); if (r.req_id === 1) { clearTimeout(timer); ws.close(); if (r.error) reject(new Error(r.error.code)); else resolve(r); } };
  });
  const now = Date.now(), map = new Map(seed.bars.map(b => [b.openTime, b]));
  for (const c of response.candles ?? []) {
    const openTime = Number(c.epoch) * 1000;
    if (openTime + 60_000 <= now) map.set(openTime, { openTime, closeTime: openTime + 60_000,
      open: Number(c.open), high: Number(c.high), low: Number(c.low), close: Number(c.close), isFinal: true });
  }
  const bars = [...map.values()].sort((a, b) => a.openTime - b.openTime);
  const origin: DataOrigin = { provider: "deriv_public", symbol: "V75", fetchedAt: new Date(now).toISOString(), kind: "LIVE_OBSERVED", historicalArrivalTimesKnown: false };
  return { bars, origin, ready: true, reason: null };
}
const service = new StructuralForecastService({ repository: structuralRepository, readFeed, now: Date.now, fit: fitInWorker });
const issued = await service.issue(150068, "V75");
await writeFile(join(output, "issued.json"), JSON.stringify(issued, null, 2), { flag: "wx" });
console.log(JSON.stringify({ state: "ISSUED_AND_SAVED", id: issued.id, issuedAt: issued.issuedAt, asOf: issued.forecast.asOf, mode: issued.forecast.mode }));
const wait = Math.max(0, issued.forecast.asOf + 62_000 - Date.now());
await new Promise(resolve => setTimeout(resolve, wait));
const resolved = (await service.history(150068, "V75")).find(r => r.id === issued.id)!;
// PostgreSQL JSONB canonicalizes object-key order; compare values, not key order.
assert.deepEqual(resolved.forecast, issued.forecast);
const result = { id: issued.id, resolvedAt: Date.now(), waitMs: wait, scores: resolved.scores,
  immutable: true, orders: 0, limitation: "One prospective one-minute observation; no market-edge claim." };
await writeFile(join(output, "resolved.json"), JSON.stringify(result, null, 2), { flag: "wx" });
console.log(JSON.stringify(result));
if (!resolved.scores.some(s => s.horizon === 1)) process.exitCode = 1;
// The database pool belongs only to this bounded CLI process.
process.exit(process.exitCode ?? 0);
