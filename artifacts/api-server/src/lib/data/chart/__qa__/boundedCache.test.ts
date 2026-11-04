// In-process chart caches stay bounded (2026-11-04 feed sweep).
import { test } from "node:test";
import assert from "node:assert/strict";
import { boundedCacheSet } from "../boundedCache.js";

test("expired entries are swept on write", () => {
  const m = new Map<string, { exp: number }>();
  boundedCacheSet(m, "a", { exp: 10 }, { max: 10, isExpired: () => false });
  boundedCacheSet(m, "b", { exp: 100 }, { max: 10, isExpired: () => false });
  boundedCacheSet(m, "c", { exp: 100 }, { max: 10, isExpired: (v) => v.exp <= 50 });
  assert.deepEqual([...m.keys()], ["b", "c"]);
});

test("past the cap the least recently written entry is evicted", () => {
  const m = new Map<string, number>();
  const opts = { max: 3, isExpired: () => false };
  for (const k of ["a", "b", "c"]) boundedCacheSet(m, k, 1, opts);
  boundedCacheSet(m, "a", 2, opts); // re-written → most recent
  boundedCacheSet(m, "d", 1, opts);
  assert.deepEqual([...m.keys()], ["c", "a", "d"]);
  for (let i = 0; i < 1000; i++) boundedCacheSet(m, `k${i}`, i, opts);
  assert.equal(m.size, 3);
});
