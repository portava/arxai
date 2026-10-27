/** Explicit offline benchmark only: local HTTP, controlled synthetic work, no
 * application router/database/provider/broker imports or credentials. */
import express from "express";
import assert from "node:assert/strict";
import { performance } from "node:perf_hooks";
import { cpus, totalmem } from "node:os";
import { writeFileSync } from "node:fs";
import type { AddressInfo } from "node:net";
import { ScannerReadAdmission, withScannerReadAdmission } from "../scannerReadAdmission.js";

if (process.env.SCANNER_ADMISSION_BENCHMARK !== "1" || !process.argv[2]) {
  throw new Error("Requires explicit offline benchmark flag and output file");
}
const app = express(), gate = new ScannerReadAdmission();
app.use((req, _res, next) => {
  // Test server only. Production uses resolved session identity, never this header.
  req.authUser = { id: Number(req.headers["x-fixture-viewer"] ?? 1) } as NonNullable<typeof req.authUser>;
  next();
});
const payload = { generatedAt: "2026-01-01T00:00:00Z", source: "synthetic_fixture", complete: true, rows: [] };
let fault = false, pendingResolvers: Array<() => void> = [], running = 0, peak = 0;
const handler = async (_req: express.Request, res: express.Response) => {
  running++; peak = Math.max(peak, running);
  try {
    if (fault) await new Promise<void>(resolve => pendingResolvers.push(resolve));
    else await new Promise(resolve => setTimeout(resolve, 2));
    return res.json(payload);
  } finally { running--; }
};
app.get("/before", handler);
app.get("/after", withScannerReadAdmission(handler, gate));
const server = app.listen(0, "127.0.0.1");
await new Promise<void>(resolve => server.once("listening", resolve));
const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
const read = async (side: string, viewer: number) => {
  const start = performance.now();
  const response = await fetch(`${url}/${side}`, { headers: { "x-fixture-viewer": String(viewer) } });
  const body = await response.json();
  return { ms: performance.now() - start, status: response.status, body };
};
function stats(values: number[]) {
  const sorted = [...values].sort((a, b) => a - b), n = sorted.length;
  return { n, median: n % 2 ? sorted[(n - 1) / 2] : (sorted[n / 2 - 1]! + sorted[n / 2]!) / 2,
    p95: sorted[Math.ceil(n * .95) - 1], p99: sorted[Math.ceil(n * .99) - 1], max: sorted[n - 1] };
}
try {
  // Warmups are identified separately, never discarded measured outliers.
  const warmups = [];
  for (const side of ["before", "after"]) for (let n = 0; n < 2; n++) {
    warmups.push({ side, rows: await Promise.all(Array.from({ length: 8 }, (_, i) => read(side, i % 4 + 1))) });
  }
  const paired: Array<{ pair: number; side: string; rows: Awaited<ReturnType<typeof read>>[] }> = [];
  for (let pair = 0; pair < 24; pair++) for (const side of pair % 2 ? ["after", "before"] : ["before", "after"]) {
    const rows = await Promise.all(Array.from({ length: 8 }, (_, i) => read(side, i % 4 + 1)));
    rows.forEach(row => { assert.equal(row.status, 200); assert.deepEqual(row.body, payload); });
    paired.push({ pair, side, rows });
  }
  const overload = [];
  for (const side of ["before", "after"]) {
    fault = true; peak = 0; pendingResolvers = [];
    let settled = 0;
    const requests = Array.from({ length: 128 }, (_, i) => read(side, i % 16 + 1).then(row => { settled++; return row; }));
    // All requests must have either started their held work or received refusal.
    const deadline = performance.now() + 5000;
    while (pendingResolvers.length + settled < 128 && performance.now() < deadline) await new Promise(resolve => setTimeout(resolve, 2));
    assert.equal(pendingResolvers.length + settled, 128);
    const held = pendingResolvers.length, activeBeforeRelease = gate.activeCount;
    pendingResolvers.forEach(resolve => resolve());
    const rows = await Promise.all(requests);
    const refused = rows.filter(row => row.status === 503), completed = rows.filter(row => row.status === 200);
    completed.forEach(row => assert.deepEqual(row.body, payload));
    refused.forEach(row => {
      assert.ok(row.body && typeof row.body === "object");
      const body = row.body as Record<string, unknown>;
      assert.equal(body.reason, "SCANNER_BUSY"); assert.equal(body.complete, undefined);
    });
    if (side === "before") assert.equal(held, 128);
    else { assert.equal(held, 32); assert.equal(refused.length, 96); }
    assert.equal(gate.activeCount, 0);
    overload.push({ side, requested: 128, held, activeBeforeRelease, peak, completed: completed.length, refused: refused.length,
      refusalMs: refused.length ? stats(refused.map(row => row.ms)) : null, rows });
    fault = false;
    assert.deepEqual((await read("after", 1)).body, payload);
  }
  const result = { recordedUtc: new Date().toISOString(), node: process.version, hardware: { cpu: cpus()[0]?.model, logicalCpus: cpus().length, memoryBytes: totalmem() },
    scope: "Loopback HTTP completion with identical2ms synthetic awaited work. Wrapper comparison isolates admission cost; no real provider, production capacity, UI display or competitor-speed claim.",
    methodology: "24 alternating pairs of8 requests;192 measured completions per variant. Conventional even median, nearest-rank p95/p99; all measured samples retained. Controlled stalled-work overload is reported separately and is not a latency speedup comparison.",
    warmups, paired, acceptedMs: Object.fromEntries(["before", "after"].map(side => [side, stats(paired.filter(run => run.side === side).flatMap(run => run.rows.map(row => row.ms)))])), overload };
  writeFileSync(process.argv[2]!, JSON.stringify(result, null, 2) + "\n");
  process.stdout.write(JSON.stringify({ acceptedMs: result.acceptedMs, overload: overload.map(({ rows, ...rest }) => rest) }) + "\n");
} finally {
  pendingResolvers.forEach(resolve => resolve()); server.closeAllConnections();
  await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
}
