// The dispatch-time observer and its wiring. The broker quote store and broker
// spec are local module doubles; no feed, database or venue is reached.
import { beforeEach, describe, it, mock } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

let quoteResult: unknown;
let specResult: unknown;
// Registry double for the transport's broker-symbol resolver: ARX-internal name
// → exact broker Market Watch name; unknown names pass through verbatim.
let registry: Record<string, string> | Error = {};
const calls: string[] = [];
mock.module("../../instruments/brokerSymbolName.js", {
  namedExports: {
    resolveBrokerSymbolName: async (stored: string) => {
      calls.push(`resolve:${stored}`);
      if (registry instanceof Error) throw registry;
      return registry[stored] ?? stored;
    },
  },
});
mock.module("../../data/providers/mt5Provider.js", {
  namedExports: {
    mt5Provider: {
      getQuote: async (symbol: string) => {
        calls.push(`quote:${symbol}`);
        if (quoteResult instanceof Error) throw quoteResult;
        return quoteResult;
      },
    },
  },
});
mock.module("../../mt5/brokerSymbolSpec.js", {
  namedExports: {
    getBrokerSymbolSpec: async (userId: number, symbol: string) => {
      calls.push(`spec:${userId}:${symbol}`);
      if (specResult instanceof Error) throw specResult;
      return specResult;
    },
  },
});
const { observeAgentEntryMarket } = await import("../entryMarketObservation.js");
const { evaluateEntryFreshFacts } = await import("../freshFacts.js");

const tick = { symbol: "EURUSD.a", bid: 1.1, ask: 1.1001, timestamp: "2026-10-27T12:00:00.000Z" };
const spec = { hasBrokerTruth: true, spec: { point: 0.00001 } };
beforeEach(() => {
  quoteResult = tick;
  specResult = spec;
  registry = {};
  calls.length = 0;
});

describe("observeAgentEntryMarket", () => {
  it("reads the execution broker's quote and point without inventing a time", async () => {
    assert.deepEqual(await observeAgentEntryMarket(9, "EURUSD.a"), {
      bid: 1.1,
      ask: 1.1001,
      observedAt: "2026-10-27T12:00:00.000Z",
      source: "mt5_broker",
      point: 0.00001,
      brokerClockOffsetMs: null,
      requestedSymbol: "EURUSD.a",
      brokerSymbol: "EURUSD.a",
    });
    assert.deepEqual(calls.sort(), ["quote:EURUSD.a", "resolve:EURUSD.a", "spec:9:EURUSD.a"]);
  });
  it("reads the quote and point under the broker-native name the transport would send", async () => {
    // A suffix broker quotes and specs "EURUSD.r"; the command row says "EURUSD".
    registry = { EURUSD: "EURUSD.r" };
    const obs = await observeAgentEntryMarket(9, "EURUSD");
    assert.equal(obs.requestedSymbol, "EURUSD");
    assert.equal(obs.brokerSymbol, "EURUSD.r");
    assert.equal(obs.bid, 1.1);
    assert.deepEqual(calls.sort(), ["quote:EURUSD.r", "resolve:EURUSD", "spec:9:EURUSD.r"]);
  });
  it("resolution is exact after the lookup: no case-folding or suffix guessing", async () => {
    registry = { V75: "Volatility 75 Index" };
    await observeAgentEntryMarket(9, "V75");
    assert.ok(calls.includes("quote:Volatility 75 Index"));
    assert.ok(calls.includes("spec:9:Volatility 75 Index"));
  });
  it("a symbol the registry does not know is looked up verbatim and fails closed when the broker never quoted it", async () => {
    quoteResult = { symbol: "XYZ", timestamp: new Date().toISOString() };
    const obs = await observeAgentEntryMarket(9, "XYZ");
    assert.equal(obs.brokerSymbol, "XYZ");
    assert.equal(obs.error, "BROKER_QUOTE_UNAVAILABLE");
    const v = evaluateEntryFreshFacts({
      side: "BUY",
      stopLoss: 1.09,
      thesis: { entryZone: { from: 1.1, to: 1.1001 } },
      observation: obs,
      nowMs: Date.now(),
    });
    assert.equal(v.ok ? "OK" : v.reason, "ENTRY_FRESH_QUOTE_UNAVAILABLE");
  });
  it("a resolver failure refuses before any quote or spec is read", async () => {
    registry = new Error("registry down");
    const obs = await observeAgentEntryMarket(9, "EURUSD");
    assert.equal(obs.error, "BROKER_SYMBOL_RESOLVE_FAILED");
    assert.equal(obs.brokerSymbol, null);
    assert.equal(obs.observedAt, null);
    assert.deepEqual(calls, ["resolve:EURUSD"]);
    const v = evaluateEntryFreshFacts({
      side: "BUY",
      stopLoss: 1.09,
      thesis: { entryZone: { from: 1.1, to: 1.1001 } },
      observation: obs,
      nowMs: Date.now(),
    });
    assert.equal(v.ok ? "OK" : v.reason, "ENTRY_FRESH_QUOTE_UNAVAILABLE");
  });
  it("a quote without a source timestamp stays unknown (refused later)", async () => {
    quoteResult = { symbol: "EURUSD.a", bid: 1.1, ask: 1.1001 };
    const obs = await observeAgentEntryMarket(9, "EURUSD.a");
    assert.equal(obs.observedAt, null);
    const v = evaluateEntryFreshFacts({
      side: "BUY",
      stopLoss: 1.09,
      thesis: { entryZone: { from: 1.1, to: 1.1001 } },
      observation: obs,
      nowMs: Date.parse("2026-10-27T12:00:00.000Z"),
    });
    assert.equal(v.ok ? "OK" : v.reason, "ENTRY_FRESH_QUOTE_TIMESTAMP_INVALID");
  });
  it("the store's priceless placeholder never passes on its fabricated now-timestamp", async () => {
    quoteResult = { symbol: "EURUSD.a", timestamp: new Date().toISOString() };
    const obs = await observeAgentEntryMarket(9, "EURUSD.a");
    assert.equal(obs.error, "BROKER_QUOTE_UNAVAILABLE");
    assert.equal(obs.observedAt, null);
  });
  it("store failure and spec failure become error observations", async () => {
    quoteResult = new Error("store exploded");
    assert.equal((await observeAgentEntryMarket(9, "EURUSD.a")).error, "BROKER_QUOTE_READ_FAILED");
    quoteResult = tick;
    specResult = new Error("db down");
    assert.equal((await observeAgentEntryMarket(9, "EURUSD.a")).error, "BROKER_SPEC_READ_FAILED");
  });
  it("without broker truth the point is unknown, so spread cannot be proven", async () => {
    specResult = { hasBrokerTruth: false, spec: { point: null } };
    assert.equal((await observeAgentEntryMarket(9, "EURUSD.a")).point, null);
  });
});

describe("dispatch wiring (source order)", () => {
  const source = readFileSync(
    fileURLToPath(new URL("../../live/liveCommandPipeline.ts", import.meta.url)),
    "utf8",
  );
  const start = source.indexOf("export async function dispatchLiveCommand");
  const end = source.indexOf("export async function sweepExpiredLiveCommands", start);
  const body = source.slice(start, end);
  it("observes agent entries after every gate and passes the observation to the only claim", () => {
    const evaluator = body.indexOf("evaluateLivePhaseBDispatchGate(");
    const exposure = body.indexOf("reserveExposureAtomicWithUserHeadroom(");
    const observe = body.indexOf("observeAgentEntryMarket(args.userId, row.symbol)");
    const claim = body.indexOf("claimLiveCommandForDispatch(");
    assert.ok(evaluator > 0 && exposure > 0 && observe > 0 && claim > 0);
    assert.ok(evaluator < observe && exposure < observe && observe < claim);
    assert.equal(body.split("claimLiveCommandForDispatch(").length, 2);
    assert.match(body.slice(claim, claim + 1200), /\{ entryMarket \}/);
    assert.match(body.slice(observe - 120, observe), /isAgentEntryCommand\(row\)/);
  });
});
