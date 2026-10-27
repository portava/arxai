// Constructed request/control fixtures only. The real cache and per-caller
// comparison run; the expensive core is isolated before any provider/DB work.
import { test, mock, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { categorizeOpportunities } from "@workspace/domain/signal-intelligence";
import { CHART_TIMEFRAMES } from "../../data/chart/timeframes.js";
import { UNIVERSE_IDS, type UniverseId } from "../../marketScanner.js";
import type { OpportunityMapCoreArgs, OpportunityMapCore } from "../opportunityMapService.js";

const START = Date.parse("2026-10-26T15:00:00Z");
const calls: OpportunityMapCoreArgs[] = [];
function fixture(args: OpportunityMapCoreArgs, at = Date.now()): OpportunityMapCore {
  return { universe: args.universe, timeframe: args.timeframe!, generatedAt: new Date(at).toISOString(),
    universeCount: 2, skippedSymbols: [], dataNote: null,
    map: categorizeOpportunities(["EURUSD", "GBPUSD"].map((symbol, i) => ({ symbol, displayName: symbol,
      direction: "BUY", recommendedAction: "BUY", setupType: "retest", edgeScore: i ? 60 : 80,
      entryQuality: 80, executionQuality: 80, newsRisk: "none", hasLiveData: true,
      isLate: false, reason: "Constructed fixture" }))),
  };
}
function deferred<T>() {
  let resolve!: (value: T) => void, reject!: (reason: Error) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}
let build = async (args: OpportunityMapCoreArgs) => fixture(args);
const realService = await import("../opportunityMapService.js");
mock.module("../opportunityMapService.js", { namedExports: { ...realService,
  buildOpportunityMapCore: async (args: OpportunityMapCoreArgs) => { calls.push({ ...args }); return build(args); },
} });
const { getCachedOpportunityMap, __clearOpportunityMapCache } = await import("../opportunityMapReadCache.js");
beforeEach(() => {
  mock.timers.enable({ apis: ["Date"], now: START });
  __clearOpportunityMapCache(); calls.length = 0;
  build = async (args) => fixture(args);
});
afterEach(() => { mock.timers.reset(); });

const request = { universe: "forex" as const, timeframe: "M5" };
test("pending build remains shared past TTL; completion never resets original timestamp or age", async () => {
  const gate = deferred<OpportunityMapCore>(); const original = fixture(request);
  build = () => gate.promise;
  const first = getCachedOpportunityMap(request);
  mock.timers.setTime(START + 10_001);
  const later = getCachedOpportunityMap(request);
  assert.equal(calls.length, 1, "an expired result window must not duplicate active work");
  gate.resolve(original);
  const results = await Promise.all([first, later]);
  assert.ok(results.every((r) => r.generatedAt === original.generatedAt));
  build = async (args) => fixture(args);
  const next = await getCachedOpportunityMap(request);
  assert.equal(calls.length, 2, "already-old completed result cannot gain a fresh TTL");
  assert.equal(next.generatedAt, new Date(START + 10_001).toISOString());
});

test("pending rejection reaches all waiters once and clears the key for a fresh retry", async () => {
  const gate = deferred<OpportunityMapCore>(); build = () => gate.promise;
  const first = getCachedOpportunityMap(request);
  mock.timers.setTime(START + 20_000);
  const later = getCachedOpportunityMap(request);
  const settled = Promise.allSettled([first, later]);
  gate.reject(new Error("Constructed provider failure"));
  assert.ok((await settled).every((r) => r.status === "rejected"));
  assert.equal(calls.length, 1);
  build = async (args) => fixture(args);
  assert.equal((await getCachedOpportunityMap(request)).timeframe, "M5");
  assert.equal(calls.length, 2);
});

test("canonical timeframe aliases share one build and return canonical identity", async () => {
  const rows = await Promise.all(["M5", "5m", "m5", " 5M "].map((timeframe) =>
    getCachedOpportunityMap({ ...request, timeframe })));
  assert.deepEqual(calls, [request]);
  assert.ok(rows.every((row) => row.timeframe === "M5" && row.generatedAt === rows[0]!.generatedAt));
  await getCachedOpportunityMap({ universe: "forex" });
  assert.equal(calls.length, 1, "default timeframe shares M5 too");
});

test("unsupported timeframes and universes reject without any core read", async () => {
  for (const timeframe of ["", "  ", "M7", "5seconds", "../M5"]) {
    await assert.rejects(getCachedOpportunityMap({ ...request, timeframe }), /Unsupported.*timeframe/);
  }
  await assert.rejects(getCachedOpportunityMap({ ...request, universe: "unbounded-key" as UniverseId }), /Unsupported.*universe/);
  assert.equal(calls.length, 0);
});

test("selected symbol comparison is recomposed per caller while original map and age are retained", async () => {
  const first = await getCachedOpportunityMap({ ...request, selectedSymbol: "EURUSD" });
  const originalBytes = JSON.stringify(first.map);
  mock.timers.setTime(START + 9_999);
  const second = await getCachedOpportunityMap({ ...request, selectedSymbol: "GBPUSD" });
  assert.equal(first.bestVsSelected.selectedEdge, 80);
  assert.equal(first.bestVsSelected.hasCleanerAlternative, false);
  assert.equal(second.bestVsSelected.selectedEdge, 60);
  assert.equal(second.bestVsSelected.hasCleanerAlternative, true);
  assert.equal(second.bestVsSelected.best?.symbol, "EURUSD");
  assert.equal(second.generatedAt, first.generatedAt);
  assert.equal(JSON.stringify(first.map), originalBytes);
  assert.equal(calls.length, 1);
  mock.timers.setTime(START + 10_000);
  await getCachedOpportunityMap(request);
  assert.equal(calls.length, 2, "existing 10-second result TTL remains anchored to start");
});

test("resolved cache eviction cannot detach an active build for the same finite key", async () => {
  const gate = deferred<OpportunityMapCore>();
  build = async (args) => args.universe === request.universe && args.timeframe === request.timeframe
    ? gate.promise : fixture(args);
  const first = getCachedOpportunityMap(request);
  const others = UNIVERSE_IDS.flatMap((universe) => CHART_TIMEFRAMES.map((timeframe) => ({ universe, timeframe })))
    .filter((a) => a.universe !== request.universe || a.timeframe !== request.timeframe).slice(0, 65);
  await Promise.all(others.map(getCachedOpportunityMap));
  const later = getCachedOpportunityMap(request);
  assert.equal(calls.filter((a) => a.universe === request.universe && a.timeframe === request.timeframe).length, 1);
  gate.resolve(fixture(request));
  await Promise.all([first, later]);
});
