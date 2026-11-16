import { test } from "node:test";
import assert from "node:assert/strict";
import { createAccountSnapshotScheduler } from "../accountSnapshotScheduler.js";

function clock() {
  let time = 0;
  let id = 0;
  const queue = new Map<number, { at: number; callback: () => void }>();
  return {
    now: () => time,
    schedule(callback: () => void, delay: number) {
      queue.set(++id, { at: time + delay, callback });
      return id as unknown as ReturnType<typeof setTimeout>;
    },
    cancel(timer: ReturnType<typeof setTimeout>) { queue.delete(timer as unknown as number); },
    advance(ms: number) {
      const end = time + ms;
      for (;;) {
        const next = [...queue].sort((a, b) => a[1].at - b[1].at)[0];
        if (!next || next[1].at > end) break;
        time = next[1].at; queue.delete(next[0]); next[1].callback();
      }
      time = end;
    },
    size: () => queue.size,
  };
}
const flush = async () => { await Promise.resolve(); await Promise.resolve(); };

test("initial read starts immediately; a burst earns one bounded trailing read", async () => {
  const c = clock(); const starts: number[] = [];
  const scheduler = createAccountSnapshotScheduler(async () => { starts.push(c.now()); }, c);
  scheduler.request();
  assert.deepEqual(starts, [0]);
  for (let i = 0; i < 100; i++) scheduler.request();
  await flush();
  c.advance(249); assert.deepEqual(starts, [0]);
  c.advance(1); await flush(); assert.deepEqual(starts, [0, 250]);
  assert.equal(c.size(), 0);
  scheduler.stop();
});

test("a slow initial read coalesces event AND fallback ticks without parallel reads", async () => {
  const c = clock(); const starts: number[] = []; let release!: () => void;
  let running = 0; let maxRunning = 0;
  const scheduler = createAccountSnapshotScheduler(async () => {
    starts.push(c.now()); running++; maxRunning = Math.max(maxRunning, running);
    if (starts.length === 1) await new Promise<void>(resolve => { release = resolve; });
    running--;
  }, c);
  scheduler.request();
  c.advance(100); scheduler.request();
  c.advance(2900); scheduler.request(); // periodic fallback while initial read is still running
  assert.deepEqual(starts, [0]);
  release(); await flush();
  assert.deepEqual(starts, [0, 3000]);
  assert.equal(maxRunning, 1);
  scheduler.stop();
});

test("updates inside the trailing read cannot bypass the minimum gap", async () => {
  const c = clock(); const starts: number[] = []; let release!: () => void;
  const scheduler = createAccountSnapshotScheduler(async () => {
    starts.push(c.now());
    await new Promise<void>(resolve => { release = resolve; });
  }, c);
  scheduler.request(); scheduler.request();
  c.advance(10); release(); await flush();
  assert.deepEqual(starts, [0]);
  c.advance(240); scheduler.request();
  c.advance(10); release(); await flush();
  c.advance(239); assert.deepEqual(starts, [0, 250]);
  c.advance(1); assert.deepEqual(starts, [0, 250, 500]);
  scheduler.stop(); release(); await flush();
});

test("failure releases the reader and retains a pending update", async () => {
  const c = clock(); let calls = 0;
  const scheduler = createAccountSnapshotScheduler(async () => { calls++; throw new Error("offline"); }, c);
  scheduler.request(); scheduler.request(); await flush();
  c.advance(250); await flush(); assert.equal(calls, 2);
  scheduler.stop();
});

test("disconnect cancels queued work and prevents late completion from reopening it", async () => {
  const c = clock(); let calls = 0; let release!: () => void;
  const scheduler = createAccountSnapshotScheduler(async () => { calls++; await new Promise<void>(resolve => { release = resolve; }); }, c);
  scheduler.request(); scheduler.request(); scheduler.stop();
  release(); await flush(); c.advance(10000); scheduler.request();
  assert.equal(calls, 1); assert.equal(c.size(), 0);
});

test("disconnect clears a scheduled gap timer", async () => {
  const c = clock(); let calls = 0;
  const scheduler = createAccountSnapshotScheduler(async () => { calls++; }, c);
  scheduler.request(); await flush(); scheduler.request();
  assert.equal(c.size(), 1); scheduler.stop();
  assert.equal(c.size(), 0); c.advance(1000); assert.equal(calls, 1);
});
