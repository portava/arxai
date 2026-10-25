import { test } from "node:test";
import assert from "node:assert/strict";
import { createDependencyReadiness } from "../dependencyReadiness.js";

test("dependency success has a minimal timestamped response and bounded cache", async () => {
  let calls = 0; let now = 1000;
  const check = createDependencyReadiness(async () => { calls++; }, { now: () => now, cacheMs: 10 });
  assert.deepEqual(await check(), { status: "ready", checkedAt: new Date(1000).toISOString() });
  await check(); assert.equal(calls, 1);
  now += 11; await check(); assert.equal(calls, 2);
});
test("database errors return unavailable without leaking connection/error details", async () => {
  const check = createDependencyReadiness(async () => { throw new Error("postgres://user:password@host/database"); });
  const response = await check();
  assert.equal(response.status, "unavailable");
  assert.deepEqual(Object.keys(response), ["status", "checkedAt"]);
  assert.doesNotMatch(JSON.stringify(response), /password|postgres|host/);
});
test("a hanging database times out and concurrent probes cannot accumulate", async () => {
  let calls = 0; let finish!: () => void;
  const check = createDependencyReadiness(() => { calls++; return new Promise<void>(r => { finish = r; }); }, { timeoutMs: 5, cacheMs: 0 });
  const responses = await Promise.all(Array.from({ length: 20 }, () => check()));
  assert.ok(responses.every(r => r.status === "unavailable"));
  await check(); assert.equal(calls, 1);
  finish(); await new Promise(r => setImmediate(r));
  const next = check(); await new Promise(r => setImmediate(r)); finish();
  assert.equal((await next).status, "ready"); assert.equal(calls, 2);
});
test("failed probes recover without a server restart", async () => {
  let fail = true;
  const check = createDependencyReadiness(async () => { if (fail) throw new Error("down"); }, { cacheMs: 0 });
  assert.equal((await check()).status, "unavailable");
  await new Promise(r => setImmediate(r)); fail = false;
  assert.equal((await check()).status, "ready");
});
