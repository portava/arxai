import { test } from "node:test";
import assert from "node:assert/strict";
import { ScannerPollLoop, ScannerRunCoordinator } from "../scannerRunCoordinator.js";

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}
async function flush() { for (let i = 0; i < 10; i++) await Promise.resolve(); }

test("identical concurrent requests share one computation and publish once", async () => {
  const runs = new ScannerRunCoordinator<string>();
  const pending = deferred<string>();
  let builds = 0;
  const publications: string[] = [];
  const build = () => { builds++; return pending.promise; };
  const reads = Array.from({ length: 100 }, () => runs.run("same", build, (v) => publications.push(v)));
  await flush();
  assert.equal(builds, 1);
  assert.equal(runs.activeCount, 1);
  pending.resolve("snapshot");
  assert.deepEqual(await Promise.all(reads), Array(100).fill("snapshot"));
  assert.deepEqual(publications, ["snapshot"]);
  assert.equal(runs.activeCount, 0);
});

test("slow older results cannot replace a newer requested scan", async () => {
  const runs = new ScannerRunCoordinator<string>();
  const old = deferred<string>();
  const publications: string[] = [];
  const a = runs.run("old", () => old.promise, (v) => publications.push(v));
  assert.equal(await runs.run("new", async () => "new result", (v) => publications.push(v)), "new result");
  old.resolve("old result");
  assert.equal(await a, "old result", "the original caller still receives its own result");
  assert.deepEqual(publications, ["new result"]);
});

test("a failed shared scan is removed and a later request can retry", async () => {
  const runs = new ScannerRunCoordinator<string>();
  await assert.rejects(runs.run("x", async () => { throw new Error("unavailable"); }, () => assert.fail()), /unavailable/);
  assert.equal(runs.activeCount, 0);
  assert.equal(await runs.run("x", async () => "recovered", () => {}), "recovered");
});

test("coalescing the most recent request still prevents an intervening scan publishing", async () => {
  const runs = new ScannerRunCoordinator<string>();
  const a = deferred<string>(); const b = deferred<string>();
  const published: string[] = [];
  const first = runs.run("a", () => a.promise, (v) => published.push(v));
  const middle = runs.run("b", () => b.promise, (v) => published.push(v));
  const last = runs.run("a", () => { assert.fail("must coalesce"); }, (v) => published.push(v));
  b.resolve("b"); await middle;
  assert.deepEqual(published, []);
  a.resolve("a"); await Promise.all([first, last]);
  assert.deepEqual(published, ["a"]);
});

test("polling waits for completion, survives failures and stops without queued scans", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const work = deferred<void>();
  let calls = 0;
  const loop = new ScannerPollLoop(() => { calls++; return calls === 1 ? work.promise : Promise.reject(new Error("offline")); }, () => 1000);
  loop.start(); loop.start(); await flush();
  assert.equal(calls, 1);
  t.mock.timers.tick(60_000); await flush();
  assert.equal(calls, 1, "a slow scan must not accumulate timer work");
  work.resolve(); await flush();
  t.mock.timers.tick(999); await flush(); assert.equal(calls, 1);
  t.mock.timers.tick(1); await flush(); assert.equal(calls, 2);
  t.mock.timers.tick(1000); await flush(); assert.equal(calls, 3, "failed scans still schedule a retry");
  loop.stop(); t.mock.timers.tick(60_000); await flush(); assert.equal(calls, 3);
});

test("stop/start during active work never opens a second polling scan", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const work = deferred<void>(); let calls = 0;
  const loop = new ScannerPollLoop(() => { calls++; return work.promise; }, () => 1000);
  loop.start(); await flush(); loop.stop(); loop.start(); await flush();
  assert.equal(calls, 1);
  work.resolve(); await flush(); t.mock.timers.tick(1000); await flush();
  assert.equal(calls, 2); loop.stop();
});
