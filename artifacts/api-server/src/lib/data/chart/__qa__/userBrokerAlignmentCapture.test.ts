import { test, beforeEach, mock } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import vm from "node:vm";
import ts from "typescript";
import { runCandleTruth } from "../candleTruthEngine.js";
import { computeBrokerPriceAlignment, noBrokerAlignment } from "../brokerPriceAlignment.js";
import { computeChartTruthScore } from "../chartTruthScore.js";
import { computeChartGateOutput } from "../chartGateOutput.js";
import type { ChartIntelligenceContext, ChartIntelligenceState } from "../chartIntelligence.js";
import type { ChartFeedStatus } from "../chartDataService.js";

// Import the actual user-broker enrichment module with all DB reads replaced.
// The intelligence module is mocked solely to control cache replacement. Its
// enrichment function is extracted verbatim below and uses the real pure
// alignment, truth and gate engines, rather than a spread-only test substitute.
function extractFunction(path: URL | string, name: string, bindings: Record<string, unknown>) {
  const source = readFileSync(path, "utf8");
  const tree = ts.createSourceFile("captured-function.ts", source, ts.ScriptTarget.Latest, true);
  const declaration = tree.statements.find(node => ts.isFunctionDeclaration(node) && node.name?.text === name);
  assert.ok(declaration, `Missing actual function ${name}`);
  const code = declaration.getText(tree).replace(/^export /, "") + `\nglobalThis.extracted=${name};`;
  const context = vm.createContext(bindings);
  vm.runInContext(ts.transpileModule(code, { compilerOptions: { target: ts.ScriptTarget.ES2022 } }).outputText, context);
  return context.extracted;
}
const actualEnrich = extractFunction(new URL("../chartIntelligence.ts", import.meta.url), "enrichStateWithBrokerAlignment", {
  computeBrokerPriceAlignment, computeChartTruthScore, computeChartGateOutput,
}) as typeof import("../chartIntelligence.js").enrichStateWithBrokerAlignment;

type Quote = { bid?: number | null; ask?: number | null; spreadPoints?: number | null };
let cached: ChartIntelligenceContext | null = null;
let query: () => Promise<Quote[]> = async () => [{ bid: 99.99, ask: 100.01 }];
let cacheCalls: unknown[][] = [];
let predicates: unknown[] = [];
let queryCount = 0;
let enrichCalls: Array<Parameters<typeof actualEnrich>> = [];
let operations: string[] = [];
const eq = (field: unknown, value: unknown) => ({ op: "eq", field, value });
const and = (...conditions: unknown[]) => ({ op: "and", conditions });
const columns = { bid: "bid", ask: "ask", spreadPoints: "spreadPoints", userId: "userId", symbol: "symbol" };
const db = { select: (projection: unknown) => {
  operations.push("query"); queryCount++;
  assert.deepEqual(JSON.parse(JSON.stringify(projection)), { bid: "bid", ask: "ask", spreadPoints: "spreadPoints" });
  return { from: (table: unknown) => {
    assert.equal(table, columns);
    return { where: (predicate: unknown) => {
      predicates.push(predicate);
      return { limit: (limit: number) => { assert.equal(limit, 1); return query(); } };
    } };
  } };
} };
const getCachedIntelligenceContext = (...args: unknown[]) => { operations.push("cache"); cacheCalls.push(args); return cached; };
const enrichStateWithBrokerAlignment: typeof actualEnrich = (...args) => { enrichCalls.push(args); return actualEnrich(...args); };
mock.module("@workspace/db", { namedExports: { db, arxSymbolSpecsTable: columns } });
mock.module("drizzle-orm", { namedExports: { eq, and } });
mock.module("../chartIntelligence.js", { namedExports: { getCachedIntelligenceContext, enrichStateWithBrokerAlignment } });
const actualModule = await import("../userBrokerAlignment.js");
// Optional before-evidence seam executes a saved prior function against the
// same mocks; normal checks always exercise the actual imported module.
const enrichUser: typeof actualModule.enrichStateWithUserBrokerQuote = process.env.ARX_USER_ALIGNMENT_BASELINE
  ? extractFunction(process.env.ARX_USER_ALIGNMENT_BASELINE, "enrichStateWithUserBrokerQuote", {
    db, arxSymbolSpecsTable: columns, eq, and, getCachedIntelligenceContext, enrichStateWithBrokerAlignment,
    deriveChartPriceBasis: actualModule.deriveChartPriceBasis,
  }) as typeof actualModule.enrichStateWithUserBrokerQuote
  : actualModule.enrichStateWithUserBrokerQuote;

const epoch = 1_800_000_000_000;
function capture(price: number, stale = false): ChartIntelligenceContext {
  const truthResult = runCandleTruth(Array.from({ length: 30 }, (_, i) => ({
    time: new Date(epoch + i * 300_000).toISOString(), open: price, high: price + .01, low: price - .01, close: price,
  })), { symbol: "EURUSD", displaySymbol: "Offline fixture", timeframe: "M5", source: "dev", assetClass: "forex", limit: 30, now: epoch + 30 * 300_000 }).truthResult;
  const feedStatus: ChartFeedStatus = { symbol: "EURUSD", displaySymbol: "Offline fixture", assetClass: "forex", source: "dev",
    isLive: false, lastTickTime: null, lastCandleTime: new Date(epoch).toISOString(), latencyMs: null,
    missingCandleCount: 0, duplicateCount: 0, outOfOrderCount: 0, invalidOhlcCount: 0, trailingIntervals: stale ? 5 : 0,
    stale, quality: stale ? "stale" : "clean", warning: null, aiUsable: false, feedReadinessState: null,
    message: `Offline capture ${price}`, completenessReason: null };
  const state = { symbol: "EURUSD", timeframe: "M5", assetClass: "forex", source: `capture-${price}`,
    latestClosedCandle: { close: price }, chartReadScore: { score: 50, label: "fixture", subMetrics: [], primaryConcern: null, note: "Offline" },
    brokerAlignment: noBrokerAlignment(price, "MID"), chartTruthScore: { original: true }, gateOutput: { original: true },
  } as unknown as ChartIntelligenceState;
  return { state, truthResult, feedStatus, candles: [], marketEvidence: null };
}
function freeze<T>(value: T): T {
  if (value && typeof value === "object") { Object.freeze(value); for (const child of Object.values(value)) freeze(child); }
  return value;
}
const args = { userId: 17, symbol: "eurusd", timeframe: "M5" as const, limit: 30 };
beforeEach(() => { cached = null; query = async () => [{ bid: 99.99, ask: 100.01 }]; cacheCalls = []; predicates = []; queryCount = 0; enrichCalls = []; operations = []; });

test("quote await cannot mix captured A state/truth/feed with replacement cache B", async () => {
  const a = freeze(capture(100)), b = freeze(capture(900, true)); cached = a;
  let release!: (rows: Quote[]) => void;
  query = () => new Promise(resolve => { release = resolve; });
  const pending = enrichUser(a.state, args);
  const beforeAwait = [...operations];
  cached = b;
  release([{ bid: 99.99, ask: 100.01, spreadPoints: 2 }]);
  const result = await pending;
  assert.equal(cacheCalls.length, 1);
  assert.equal(enrichCalls.length, 1);
  assert.equal(enrichCalls[0]![0], a.state);
  assert.equal(enrichCalls[0]![1], a.truthResult);
  assert.equal(enrichCalls[0]![2], a.feedStatus);
  assert.equal(enrichCalls[0]![3].chartPrice, 100);
  assert.deepEqual(beforeAwait, ["cache", "query"]);
  assert.equal(result.brokerAlignment.chartPrice, 100);
  assert.equal(result.gateOutput.autonomousChartActionAllowed, true); // captured stale=false, not permission to trade
  assert.notEqual(result, a.state);
  assert.deepEqual(cacheCalls, [["eurusd", "M5", 30]]);
  assert.deepEqual(predicates, [and(eq("userId", 17), eq("symbol", "EURUSD"))]);
});
for (const reason of ["missing", "expired"] as const) test(`${reason} cache authority returns original state before any quote query`, async () => {
  const a = capture(100); cached = null; // existing cache owner reports absence/expiry as null
  assert.equal(await enrichUser(a.state, args), a.state);
  assert.equal(queryCount, 0); assert.equal(enrichCalls.length, 0);
});
test("equal-looking replacement state is not the exact captured state", async () => {
  const a = capture(100); cached = { ...a, state: { ...a.state } };
  assert.equal(await enrichUser(a.state, args), a.state);
  assert.equal(queryCount, 0); assert.equal(enrichCalls.length, 0);
});
test("explicit matching context bypasses cache, including replacement or expired cache", async () => {
  for (const replacement of [capture(900, true), null]) {
    const a = freeze(capture(100)); cached = replacement;
    const result = await enrichUser(a.state, { ...args, context: a });
    assert.equal(result.brokerAlignment.chartPrice, 100);
    assert.equal(enrichCalls.at(-1)![1], a.truthResult);
    assert.equal(enrichCalls.at(-1)![2], a.feedStatus);
  }
  assert.equal(cacheCalls.length, 0); assert.equal(queryCount, 2);
});
test("mismatched explicit context cannot fall back to a coincidentally matching cache", async () => {
  const a = capture(100); cached = a;
  assert.equal(await enrichUser(a.state, { ...args, context: capture(900) }), a.state);
  assert.equal(cacheCalls.length, 0); assert.equal(queryCount, 0);
});
for (const row of [null, { ask: 100.01 }, { bid: 99.99 }, { bid: null, ask: 100 }, { bid: 100, ask: null }]) {
  test(`missing quote component never enriches (${JSON.stringify(row)})`, async () => {
    const a = capture(100); cached = a; query = async () => row == null ? [] : [row];
    assert.equal(await enrichUser(a.state, args), a.state); assert.equal(enrichCalls.length, 0);
  });
}
test("two users receive independent enrichment without changing shared base or prior user output", async () => {
  const a = freeze(capture(100)); const snapshot = JSON.stringify(a); cached = a;
  const first = await enrichUser(a.state, args);
  const firstSnapshot = JSON.stringify(first);
  query = async () => [{ bid: 200, ask: 201 }];
  const second = await enrichUser(a.state, { ...args, userId: 29 });
  assert.equal(JSON.stringify(a), snapshot); assert.equal(JSON.stringify(first), firstSnapshot);
  assert.notEqual(first, second); assert.notEqual(first.brokerAlignment, second.brokerAlignment);
  assert.notEqual(first.chartTruthScore, second.chartTruthScore); assert.notEqual(first.gateOutput, second.gateOutput);
  assert.equal(first.brokerAlignment.aligned, true); assert.equal(second.brokerAlignment.tolerance, "failed");
  assert.deepEqual(predicates, [and(eq("userId", 17), eq("symbol", "EURUSD")), and(eq("userId", 29), eq("symbol", "EURUSD"))]);
});
test("invalid zero quote remains unmeasured under actual alignment engine", async () => {
  const a = capture(100); cached = a; query = async () => [{ bid: 0, ask: 0 }];
  const result = await enrichUser(a.state, args);
  assert.equal(result.brokerAlignment.brokerDataAvailable, false); assert.equal(result.brokerAlignment.aligned, false);
});
test("lookup rejection does not substitute another context or grant successful alignment", async () => {
  const a = freeze(capture(100)); cached = a; const error = new Error("offline query failure");
  query = async () => { cached = capture(900, true); throw error; };
  await assert.rejects(enrichUser(a.state, args), actual => actual === error);
  assert.equal(enrichCalls.length, 0); assert.equal(a.state.brokerAlignment.brokerDataAvailable, false);
});
