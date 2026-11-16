import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { EventEmitter } from "node:events";
import vm from "node:vm";
import ts from "typescript";
import { createAccountSnapshotScheduler } from "../accountSnapshotScheduler.js";
import { createSseWriter } from "../../perf/sseWriter.js";

// Execute the actual route body with read-only data/transport seams. No DB,
// credentials, server or broker. This supplements the scheduler's clock tests;
// it detects a route accidentally bypassing the scheduler or subscribing late.
const source = readFileSync(process.env.ARX_ACCOUNT_STREAM_SOURCE ?? new URL("../../../routes/meLive.ts", import.meta.url), "utf8");
const begin = source.indexOf('router.get("/me/live/account-stream"');
assert.notEqual(begin, -1);
const route = source.slice(begin, source.indexOf("\n});", begin) + 4)
  .replace('await import("../lib/live/liveAccountSnapshot.js")', "await snapshotModule()")
  .replace('await import("../lib/live/liveAccountEventBus.js")', "await busModule()");
const js = ts.transpileModule(route, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.None } }).outputText;
const flush = async () => { for (let i = 0; i < 20; i++) await Promise.resolve(); };

function harness(delayModule = false) {
  const req = new EventEmitter();
  const bus = new EventEmitter();
  const writes: string[] = [];
  const intervals = new Map<number, () => void>();
  let handler!: (req: unknown, res: unknown) => Promise<void>;
  let finishModule!: (value: object) => void;
  let reads = 0; let active = 0; let maxActive = 0;
  const releases: Array<() => void> = [];
  const context = {
    router: { get: (_path: string, _auth: unknown, fn: typeof handler) => { handler = fn; } },
    requireUser: () => {}, uid: () => "u1", isAdmin: () => false,
    snapshotModule: () => delayModule ? new Promise(resolve => { finishModule = resolve; }) : Promise.resolve({}),
    busModule: async () => ({ liveAccountEventBus: bus }),
    createAccountSnapshotScheduler: (read: () => Promise<void>) => createAccountSnapshotScheduler(read, { minGapMs: 0 }),
    createSseWriter,
    getUserModeScope: async () => ({ currentAccountMode: "DEMO" }),
    resolveLivePositionVisibility: () => ({ includeLive: false, notLiveReason: "not live" }),
    fetchInvestorBalanceParts: async () => {
      reads++; active++; maxActive = Math.max(maxActive, active);
      await new Promise<void>(resolve => releases.push(resolve)); active--;
      return {};
    },
    composeInvestorBalance: () => ({ source: "demo" }),
    toInvestorLiveBalanceWire: (value: unknown) => value,
    setInterval: (fn: () => void, ms: number) => { intervals.set(ms, fn); return ms; },
    clearInterval: (id: number) => { intervals.delete(id); },
    setTimeout, clearTimeout,
  };
  vm.runInNewContext(js, context);
  const response = Object.assign(new EventEmitter(), {
    destroyed: false, writableEnded: false,
    setHeader() {}, flushHeaders() {},
    write: (value: string) => { writes.push(value); return true; },
    destroy(this: EventEmitter & { destroyed: boolean }) { this.destroyed = true; this.emit("close"); },
  });
  const run = handler(req, response);
  return {
    run, req, bus, writes, intervals,
    finishModule: () => finishModule({}),
    reads: () => reads, maxActive: () => maxActive,
    release: () => { const done = releases.shift(); assert.ok(done); done(); },
  };
}

test("an update during the initial account read earns a trailing refresh", async () => {
  const h = harness(); await flush();
  try {
    assert.equal(h.reads(), 1);
    assert.equal(h.bus.listenerCount("u1"), 1);
    h.bus.emit("u1"); h.release(); await flush();
    assert.equal(h.reads(), 2);
    h.release(); await flush();
    assert.equal(h.writes.length, 2);
  } finally { h.req.emit("close"); }
});

test("fallback ticks cannot overlap an event-driven refresh", async () => {
  const h = harness(); await flush(); h.release(); await flush();
  try {
    h.bus.emit("u1"); await flush();
    assert.equal(h.reads(), 2);
    h.intervals.get(3000)!(); await flush();
    assert.equal(h.maxActive(), 1);
    assert.equal(h.reads(), 2);
    h.release(); await flush();
    assert.equal(h.reads(), 3);
    h.release(); await flush();
  } finally { h.req.emit("close"); }
});

test("disconnect during module loading never starts reads or subscriptions", async () => {
  const h = harness(true); h.req.emit("close"); h.finishModule(); await flush();
  assert.equal(h.reads(), 0);
  assert.equal(h.bus.listenerCount("u1"), 0);
  assert.equal(h.intervals.size, 0);
});

test("disconnect during a read suppresses writes and trailing work", async () => {
  const h = harness(); await flush();
  h.bus.emit("u1"); h.req.emit("close"); h.release(); await flush();
  assert.equal(h.reads(), 1);
  assert.equal(h.bus.listenerCount("u1"), 0);
  assert.equal(h.intervals.size, 0);
  assert.equal(h.writes.length, 0);
});
