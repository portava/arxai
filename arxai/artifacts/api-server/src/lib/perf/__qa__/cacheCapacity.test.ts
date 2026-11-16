import { test } from "node:test";
import assert from "node:assert/strict";
import { getCache, describeCacheRuntime } from "../../cache/cacheAdapter.js";

test("scanner cache bounds retained keys even when keys are never requested again", () => {
  const cache = getCache("perf-capacity-test", 60_000);
  for (let i = 0; i < 10_000; i++) cache.set(`user:${i}`, { observation: i });
  assert.equal(cache.size(), 1000);
  assert.equal(cache.get("user:0").hit, false);
  assert.deepEqual(cache.get("user:9999"), { hit: true, value: { observation: 9999 } });
  assert.deepEqual(cache.stats(), { hits: 1, misses: 1, evictions: 9000, maxEntries: 1000 });
  assert.equal(describeCacheRuntime().namespaces.find(n => n.name === "perf-capacity-test")?.evictions, 9000);
});

test("expired observations are not returned, and namespaces retain separate data", t => {
  let now = 1000; t.mock.method(Date, "now", () => now);
  const a = getCache("perf-a", 10), b = getCache("perf-b", 10);
  a.set("same-key", "a"); b.set("same-key", "b");
  assert.deepEqual(a.get("same-key"), { hit: true, value: "a" });
  assert.deepEqual(b.get("same-key"), { hit: true, value: "b" });
  now += 11;
  assert.deepEqual(a.get("same-key"), { hit: false });
  assert.equal(b.size(), 0);
});
