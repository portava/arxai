// Run: node --import tsx --test src/lib/perf/__qa__/heapWatch.test.ts
import { test } from "node:test";
import assert from "node:assert/strict";
import { assessHeap, registerHeapWatchGauge, readHeapWatchGauges, sampleHeap } from "../heapWatch.js";

const GB = 1_073_741_824;

test("heap levels: ok under 70%, elevated from 70%, critical from 85% of the V8 limit", () => {
  const base = { rssBytes: 0, heapTotalBytes: 0, externalBytes: 0, heapLimitBytes: 4 * GB };
  assert.equal(assessHeap({ ...base, heapUsedBytes: 1 * GB }).level, "ok");
  assert.equal(assessHeap({ ...base, heapUsedBytes: 2.8 * GB }).level, "elevated");
  assert.equal(assessHeap({ ...base, heapUsedBytes: 3.5 * GB }).level, "critical");
  assert.equal(assessHeap({ ...base, heapUsedBytes: 1 * GB, heapLimitBytes: 0 }).level, "ok", "unknown limit never alarms");
});

test("gauges are read by name and a throwing gauge reports -1 instead of breaking the sample", () => {
  registerHeapWatchGauge("qa.fine", () => 7);
  registerHeapWatchGauge("qa.broken", () => { throw new Error("boom"); });
  const g = readHeapWatchGauges();
  assert.equal(g["qa.fine"], 7);
  assert.equal(g["qa.broken"], -1);
});

test("a live sample carries a positive heap limit", () => {
  assert.ok(sampleHeap().heapLimitBytes > 0);
});
