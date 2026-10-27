import { test } from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import type { Request, Response } from "express";
import { ScannerReadAdmission, withScannerReadAdmission } from "../scannerReadAdmission.js";

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>(yes => { resolve = yes; });
  return { promise, resolve };
}
function fixture(viewer: number | null = 1) {
  const req = Object.assign(new EventEmitter(), { authUser: viewer == null ? null : { id: viewer }, headers: {}, query: {} });
  const headers = new Map<string, string>();
  const response = Object.assign(new EventEmitter(), {
    statusCode: 200, body: undefined as unknown,
    setHeader(name: string, value: string) { headers.set(name, value); return response; },
    status(code: number) { response.statusCode = code; return response; },
    json(body: unknown) { response.body = body; return response; },
  });
  return { req: req as unknown as Request, res: response as unknown as Response, response, headers };
}
const invoke = (handler: ReturnType<typeof withScannerReadAdmission>, f: ReturnType<typeof fixture>) =>
  Promise.resolve(handler(f.req, f.res, () => assert.fail("This wrapper must return its async rejection to Express")));

test("global and per-viewer bounds refuse without queuing and free all owner entries", () => {
  const gate = new ScannerReadAdmission({ total: 3, perViewer: 2 });
  const first = gate.acquire(1)!, second = gate.acquire(1)!;
  assert.equal(gate.acquire(1), null);
  const third = gate.acquire(2)!;
  assert.equal(gate.acquire(3), null);
  assert.equal(gate.activeCount, 3); assert.equal(gate.activeViewerCount, 2);
  first(); first(); assert.equal(gate.activeCount, 2);
  const recovered = gate.acquire(3)!; assert.equal(typeof recovered, "function");
  second(); third(); recovered();
  assert.equal(gate.activeCount, 0); assert.equal(gate.activeViewerCount, 0);
});

test("invalid and anonymous identities share one bounded bucket", () => {
  const gate = new ScannerReadAdmission({ total: 3, perViewer: 1 });
  const release = gate.acquire(null)!;
  for (const key of [null, -1, 0, NaN, Infinity, 1.5]) assert.equal(gate.acquire(key), null);
  assert.equal(gate.activeViewerCount, 1); release();
  const other = gate.acquire(1)!; assert.equal(gate.activeViewerCount, 1); other();
});

test("invalid limits fail and caller mutation cannot change admitted capacity", () => {
  for (const limits of [{ total: 0, perViewer: 1 }, { total: 2, perViewer: 3 }, { total: 1.5, perViewer: 1 }, { total: 2, perViewer: NaN }]) {
    assert.throws(() => new ScannerReadAdmission(limits), RangeError);
  }
  const limits = { total: 2, perViewer: 1 }, gate = new ScannerReadAdmission(limits);
  limits.perViewer = 2;
  const release = gate.acquire(1)!; assert.equal(gate.acquire(1), null); release();
});

test("overload is an uncached503 with retry advice and never invokes market work", async () => {
  const gate = new ScannerReadAdmission({ total: 1, perViewer: 1 }), release = gate.acquire(1)!;
  const f = fixture(2);
  await invoke(withScannerReadAdmission(() => assert.fail("refused read must not run"), gate), f);
  assert.equal(f.response.statusCode, 503);
  assert.equal(f.headers.get("Retry-After"), "1"); assert.equal(f.headers.get("Cache-Control"), "no-store");
  assert.deepEqual(f.response.body, { ok: false, error: "SCANNER_BUSY", reason: "SCANNER_BUSY",
    message: "The scanner is busy. Try again in a moment.", retryAfterMs: 1000 });
  assert.equal(gate.activeCount, 1); release();
});

test("admitted result preserves original source time and response rather than synthesizing success", async () => {
  const gate = new ScannerReadAdmission({ total: 1, perViewer: 1 }), f = fixture();
  const result = { generatedAt: "2026-01-01T00:00:00Z", source: "stored", opportunities: [] };
  await invoke(withScannerReadAdmission((_req, res) => res.json(result), gate), f);
  assert.equal(f.response.body, result); assert.equal(gate.activeCount, 0); assert.equal(gate.activeViewerCount, 0);
});

test("sync throws, async rejection and early response all release exactly once", async () => {
  const gate = new ScannerReadAdmission({ total: 1, perViewer: 1 });
  for (const handler of [() => { throw new Error("sync"); }, async () => { throw new Error("async"); }]) {
    await assert.rejects(invoke(withScannerReadAdmission(handler, gate), fixture()), /sync/);
    assert.equal(gate.activeCount, 0); assert.equal(gate.activeViewerCount, 0);
  }
  await invoke(withScannerReadAdmission((_req, res) => res.status(400).json({ error: "invalid" }), gate), fixture());
  assert.equal(gate.activeCount, 0);
});

test("disconnect or an already written response cannot release unfinished work", async () => {
  const gate = new ScannerReadAdmission({ total: 1, perViewer: 1 }), f = fixture(), hold = deferred();
  const pending = invoke(withScannerReadAdmission(async (_req, res) => { res.json({ context: true }); await hold.promise; }, gate), f);
  f.req.emit("close"); f.res.emit("close"); f.req.emit("aborted");
  assert.equal(gate.activeCount, 1); assert.equal(gate.acquire(2), null);
  hold.resolve(); await pending; assert.equal(gate.activeCount, 0);
});

test("a late response failure after disconnect releases only after actual provider settlement", async () => {
  const gate = new ScannerReadAdmission({ total: 1, perViewer: 1 }), f = fixture(), hold = deferred();
  const pending = invoke(withScannerReadAdmission(async () => { await hold.promise; throw new Error("response closed"); }, gate), f);
  const outcome = assert.rejects(pending, /response closed/);
  f.req.emit("close"); assert.equal(gate.activeCount, 1);
  hold.resolve(); await outcome; assert.equal(gate.activeCount, 0);
});

test("spoofed request owner keys do not evade the resolved-session limit", async () => {
  const gate = new ScannerReadAdmission({ total: 2, perViewer: 1 }), release = gate.acquire(1)!;
  const f = fixture(1); f.req.headers["x-user-id"] = "2"; f.req.query.ownerId = "2";
  await invoke(withScannerReadAdmission(() => assert.fail("untrusted identity was used"), gate), f);
  assert.equal(f.response.statusCode, 503); release();
});

test("128 concurrent mixed viewers start at most32 handlers and retain all accepted results", async () => {
  const gate = new ScannerReadAdmission(), hold = deferred(); let started = 0;
  const handler = withScannerReadAdmission(async (_req, res) => { started++; await hold.promise; res.json({ complete: true }); }, gate);
  const fixtures = Array.from({ length: 128 }, (_, i) => fixture(i % 8 + 1));
  const pending = fixtures.map(f => invoke(handler, f));
  assert.equal(started, 32); assert.equal(gate.activeCount, 32);
  assert.equal(fixtures.filter(f => f.response.statusCode === 503).length, 96);
  hold.resolve(); await Promise.all(pending);
  assert.equal(fixtures.filter(f => f.response.statusCode === 200).length, 32);
  assert.equal(gate.activeCount, 0); assert.equal(gate.activeViewerCount, 0);
  const recovered = fixture(); await invoke(handler, recovered); assert.deepEqual(recovered.response.body, { complete: true });
});
