// Unit tests for the short-TTL single-flight cache (Task #455). Run via:
//   node --import tsx --test src/lib/perf/__qa__/shortTtlCache.test.ts
// (wired as `pnpm --filter @workspace/api-server run test:short-ttl-cache`)

import { test } from "node:test";
import assert from "node:assert/strict";
import { createShortTtlCache } from "../shortTtlCache.js";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

test("single-flight: concurrent calls for the same key share one computation", async () => {
  const cache = createShortTtlCache<number>({ ttlMs: 1_000 });
  let computeCount = 0;
  const compute = async () => {
    computeCount += 1;
    await sleep(20);
    return 42;
  };
  const [a, b, c] = await Promise.all([
    cache.get("k", compute),
    cache.get("k", compute),
    cache.get("k", compute),
  ]);
  assert.equal(a, 42);
  assert.equal(b, 42);
  assert.equal(c, 42);
  assert.equal(computeCount, 1, "three concurrent callers must collapse to one compute");
});

test("a resolved value is reused until the TTL expires, then recomputed", async () => {
  const cache = createShortTtlCache<number>({ ttlMs: 40 });
  let n = 0;
  const compute = async () => ++n;
  assert.equal(await cache.get("k", compute), 1);
  assert.equal(await cache.get("k", compute), 1, "within TTL → cached");
  await sleep(60);
  assert.equal(await cache.get("k", compute), 2, "after TTL → recomputed");
});

test("a rejected computation is NOT cached (next call recomputes)", async () => {
  const cache = createShortTtlCache<number>({ ttlMs: 1_000 });
  let attempt = 0;
  const compute = async () => {
    attempt += 1;
    if (attempt === 1) throw new Error("transient");
    return 7;
  };
  await assert.rejects(cache.get("k", compute), /transient/);
  // Second call must recompute (failure was evicted, never served).
  assert.equal(await cache.get("k", compute), 7);
  assert.equal(attempt, 2);
});

test("distinct keys are isolated", async () => {
  const cache = createShortTtlCache<string>({ ttlMs: 1_000 });
  assert.equal(await cache.get("a", async () => "A"), "A");
  assert.equal(await cache.get("b", async () => "B"), "B");
  assert.equal(await cache.get("a", async () => "A2"), "A", "key a stays cached");
});

test("invalidate forces a recompute for that key only", async () => {
  const cache = createShortTtlCache<number>({ ttlMs: 1_000 });
  let n = 0;
  const compute = async () => ++n;
  assert.equal(await cache.get("k", compute), 1);
  cache.invalidate("k");
  assert.equal(await cache.get("k", compute), 2);
});

test("maxEntries bounds the cache (oldest evicted first)", async () => {
  const cache = createShortTtlCache<number>({ ttlMs: 60_000, maxEntries: 2 });
  await cache.get("a", async () => 1);
  await cache.get("b", async () => 2);
  await cache.get("c", async () => 3); // evicts "a"
  let recomputed = false;
  const v = await cache.get("a", async () => {
    recomputed = true;
    return 11;
  });
  assert.equal(v, 11);
  assert.equal(recomputed, true, "oldest key 'a' must have been evicted");
});
