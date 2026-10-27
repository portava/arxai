// The dispatch-time observer and its wiring. The broker quote store and broker
// spec are local module doubles; no feed, database or venue is reached.
import { beforeEach, describe, it, mock } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

// The instruments index is the one import path (ci guard
// instrument-mapping-single-source); only the resolver is replaced here.
import * as realInstruments from "../../instruments/index.js";

let quoteResult: unknown;
let tickResult: unknown;
let specResult: unknown;
// Registry double for the transport's broker-symbol resolver: ARX-internal name
// → exact broker Market Watch name; unknown names pass through verbatim.
let registry: Record<string, string> | Error = {};
const calls: string[] = [];
mock.module("../../instruments/index.js", {
  namedExports: {
    ...realInstruments,
    resolveBrokerSymbolName: async (stored: string) => {
      calls.push(`resolve:${stored}`);
      if (registry instanceof Error) throw registry;
      return registry[stored] ?? stored;
    },
  },
});
// Only the bridge-scoped read exists on this path (quoteBridgeScope.test.ts
// covers the real partitions). No unscoped `getQuote` is offered at all, so a
// regression to the most-recent-writer read would fail to import.
mock.module("../../data/providers/mt5Provider.js", {
  namedExports: {
    readMt5Quote: (symbol: string, opts: { bridgeConnectionId: number }) => {
      calls.push(`quote:${symbol}@${opts.bridgeConnectionId}`);
      if (quoteResult instanceof Error) throw quoteResult;
      return { quote: quoteResult, bridgeConnectionId: opts.bridgeConnectionId, userId: null, tick: tickResult };
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
// The store's first-sight provenance of that tick (epoch ms), as readMt5Quote returns it.
const T = Date.parse(tick.timestamp);
const provenance = { firstSeenEaMs: T, lastPostedEaMs: T + 2_000, reposts: 1, priorPostEaMs: T - 2_000 };
const spec = { hasBrokerTruth: true, spec: { point: 0.00001 } };
// The dispatch context: the bridge the command goes to and its reported EA.
const CTX = { bridgeConnectionId: 4, eaVersion: "1.54" };
const verdict = (observation: Awaited<ReturnType<typeof observeAgentEntryMarket>>) =>
  evaluateEntryFreshFacts({
    side: "BUY",
    stopLoss: 1.09,
    thesis: { entryZone: { from: 1.1, to: 1.1001 } },
    observation,
    nowMs: Date.now(),
  });
beforeEach(() => {
  quoteResult = tick;
  tickResult = provenance;
  specResult = spec;
  registry = {};
  calls.length = 0;
});

describe("observeAgentEntryMarket", () => {
  it("reads the execution broker's quote and point from the dispatch bridge without inventing a time", async () => {
    assert.deepEqual(await observeAgentEntryMarket(9, "EURUSD.a", CTX), {
      bid: 1.1,
      ask: 1.1001,
      observedAt: "2026-10-27T12:00:00.000Z",
      tickProvenance: {
        firstSeenAt: "2026-10-27T12:00:00.000Z",
        lastPostedAt: "2026-10-27T12:00:02.000Z",
        reposts: 1,
        priorPostAt: "2026-10-27T11:59:58.000Z",
      },
      source: "mt5_broker",
      point: 0.00001,
      brokerClockOffsetMs: null,
      requestedSymbol: "EURUSD.a",
      brokerSymbol: "EURUSD.a",
      bridgeConnectionId: 4,
      eaVersion: "1.54",
    });
    assert.deepEqual(calls.sort(), ["quote:EURUSD.a@4", "resolve:EURUSD.a", "spec:9:EURUSD.a"]);
  });
  it("copies the store's provenance verbatim: a first-ever tick has no prior post, a legacy write has none at all", async () => {
    tickResult = { firstSeenEaMs: T, lastPostedEaMs: T, reposts: 0, priorPostEaMs: null };
    const first = await observeAgentEntryMarket(9, "EURUSD.a", CTX);
    assert.deepEqual(first.tickProvenance, {
      firstSeenAt: "2026-10-27T12:00:00.000Z",
      lastPostedAt: "2026-10-27T12:00:00.000Z",
      reposts: 0,
      priorPostAt: null,
    });
    tickResult = null;
    const legacy = await observeAgentEntryMarket(9, "EURUSD.a", CTX);
    assert.equal(legacy.tickProvenance, null);
    assert.equal(legacy.observedAt, tick.timestamp);
    const v = evaluateEntryFreshFacts({
      side: "BUY",
      stopLoss: 1.09,
      thesis: { entryZone: { from: 1.1, to: 1.1001 } },
      observation: legacy,
      nowMs: T + 1_000,
    });
    assert.equal(v.ok ? "OK" : v.reason, "ENTRY_FRESH_QUOTE_TIMESTAMP_INVALID");
  });
  it("reads the quote and point under the broker-native name the transport would send", async () => {
    // A suffix broker quotes and specs "EURUSD.r"; the command row says "EURUSD".
    registry = { EURUSD: "EURUSD.r" };
    const obs = await observeAgentEntryMarket(9, "EURUSD", CTX);
    assert.equal(obs.requestedSymbol, "EURUSD");
    assert.equal(obs.brokerSymbol, "EURUSD.r");
    assert.equal(obs.bid, 1.1);
    assert.deepEqual(calls.sort(), ["quote:EURUSD.r@4", "resolve:EURUSD", "spec:9:EURUSD.r"]);
  });
  it("resolution is exact after the lookup: no case-folding or suffix guessing", async () => {
    registry = { V75: "Volatility 75 Index" };
    await observeAgentEntryMarket(9, "V75", CTX);
    assert.ok(calls.includes("quote:Volatility 75 Index@4"));
    assert.ok(calls.includes("spec:9:Volatility 75 Index"));
  });
  it("a symbol the registry does not know is looked up verbatim and fails closed when the bridge never quoted it", async () => {
    quoteResult = null;
    const obs = await observeAgentEntryMarket(9, "XYZ", CTX);
    assert.equal(obs.brokerSymbol, "XYZ");
    assert.equal(obs.error, "BROKER_QUOTE_UNAVAILABLE");
    const v = verdict(obs);
    assert.equal(v.ok ? "OK" : v.reason, "ENTRY_FRESH_QUOTE_UNAVAILABLE");
    assert.ok(!v.ok && /BROKER_QUOTE_UNAVAILABLE; symbol XYZ; bridge 4; EA v1.54 streams broker quotes for its configured symbols only/.test(v.detail), v.ok ? "" : v.detail);
  });
  it("a resolver failure refuses before any quote or spec is read", async () => {
    registry = new Error("registry down");
    const obs = await observeAgentEntryMarket(9, "EURUSD", CTX);
    assert.equal(obs.error, "BROKER_SYMBOL_RESOLVE_FAILED");
    assert.equal(obs.brokerSymbol, null);
    assert.equal(obs.observedAt, null);
    assert.deepEqual(calls, ["resolve:EURUSD"]);
    const v = verdict(obs);
    assert.equal(v.ok ? "OK" : v.reason, "ENTRY_FRESH_QUOTE_UNAVAILABLE");
  });
  it("a dispatch without a bridge identity refuses before any read", async () => {
    for (const bridgeConnectionId of [null, undefined, NaN]) {
      calls.length = 0;
      const obs = await observeAgentEntryMarket(9, "EURUSD.a", { bridgeConnectionId, eaVersion: "1.54" });
      assert.equal(obs.error, "BROKER_QUOTE_BRIDGE_UNKNOWN");
      assert.equal(obs.bridgeConnectionId, null);
      assert.deepEqual(calls, []);
      const v = verdict(obs);
      assert.equal(v.ok ? "OK" : v.reason, "ENTRY_FRESH_QUOTE_UNAVAILABLE");
      assert.ok(!v.ok && /bridge unknown/.test(v.detail));
    }
  });
  it("on the shipped v1.31 kit a missing quote says the EA streams none, and still refuses", async () => {
    quoteResult = null;
    const obs = await observeAgentEntryMarket(9, "EURUSD", { bridgeConnectionId: 12, eaVersion: "1.31" });
    assert.equal(obs.error, "BROKER_QUOTE_UNAVAILABLE");
    assert.equal(obs.eaVersion, "1.31");
    assert.equal(obs.eaQuoteSupply?.quoteStream, "NONE");
    const v = verdict(obs);
    assert.equal(v.ok ? "OK" : v.reason, "ENTRY_FRESH_QUOTE_UNAVAILABLE");
    assert.ok(
      !v.ok && v.detail.startsWith("BROKER_QUOTE_UNAVAILABLE; symbol EURUSD; bridge 12; EA v1.31 does not stream broker quotes (ReplitMT5BridgeEA_v131.mq5"),
      v.ok ? "" : v.detail,
    );
  });
  it("an EA version outside the verified table is reported as unknown, never guessed", async () => {
    quoteResult = null;
    const obs = await observeAgentEntryMarket(9, "EURUSD", { bridgeConnectionId: 12, eaVersion: "1.55" });
    assert.equal(obs.eaQuoteSupply?.quoteStream, "UNKNOWN");
    const v = verdict(obs);
    assert.ok(!v.ok && /EA v1\.55 is not in the verified table/.test(v.detail));
    const none = await observeAgentEntryMarket(9, "EURUSD", { bridgeConnectionId: 12, eaVersion: null });
    assert.equal(none.eaVersion, null);
    assert.equal(none.eaQuoteSupply?.quoteStream, "UNKNOWN");
  });
  it("a present quote carries the EA version but no supply note (nothing to explain)", async () => {
    const obs = await observeAgentEntryMarket(9, "EURUSD.a", { bridgeConnectionId: 4, eaVersion: " 1.31 " });
    assert.equal(obs.eaVersion, "1.31");
    assert.equal(obs.eaQuoteSupply, undefined);
    assert.equal(verdict(obs).ok, false); // nowMs is far from the fixture time: STALE, not UNAVAILABLE
  });
  it("a quote without a source timestamp stays unknown (refused later)", async () => {
    quoteResult = { symbol: "EURUSD.a", bid: 1.1, ask: 1.1001 };
    const obs = await observeAgentEntryMarket(9, "EURUSD.a", CTX);
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
  it("a priceless quote never passes on a timestamp", async () => {
    quoteResult = { symbol: "EURUSD.a", timestamp: new Date().toISOString() };
    const obs = await observeAgentEntryMarket(9, "EURUSD.a", CTX);
    assert.equal(obs.error, "BROKER_QUOTE_UNAVAILABLE");
    assert.equal(obs.observedAt, null);
  });
  it("store failure and spec failure become error observations", async () => {
    quoteResult = new Error("store exploded");
    assert.equal((await observeAgentEntryMarket(9, "EURUSD.a", CTX)).error, "BROKER_QUOTE_READ_FAILED");
    quoteResult = tick;
    specResult = new Error("db down");
    assert.equal((await observeAgentEntryMarket(9, "EURUSD.a", CTX)).error, "BROKER_SPEC_READ_FAILED");
  });
  it("without broker truth the point is unknown, so spread cannot be proven", async () => {
    specResult = { hasBrokerTruth: false, spec: { point: null } };
    assert.equal((await observeAgentEntryMarket(9, "EURUSD.a", CTX)).point, null);
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
    const observe = body.indexOf("observeAgentEntryMarket(args.userId, row.symbol, {");
    const claim = body.indexOf("claimLiveCommandForDispatch(");
    assert.ok(evaluator > 0 && exposure > 0 && observe > 0 && claim > 0);
    assert.ok(evaluator < observe && exposure < observe && observe < claim);
    assert.equal(body.split("claimLiveCommandForDispatch(").length, 2);
    assert.match(body.slice(claim, claim + 1200), /\{ entryMarket \}/);
    assert.match(body.slice(observe - 120, observe), /isAgentEntryCommand\(row\)/);
    // The observation is bound to the bridge the command is dispatched to, and
    // carries that bridge's EA version for the supply note.
    assert.match(body.slice(observe, observe + 240), /bridgeConnectionId: bridge\?\.id \?\? null/);
    assert.match(body.slice(observe, observe + 240), /eaVersion: bridge\?\.eaVersion \?\? null/);
  });
  it("the claim forwards the verdict detail and the dispatch catch persists it beside the reason", () => {
    const cas = readFileSync(
      fileURLToPath(new URL("../../live/liveCommandCas.ts", import.meta.url)),
      "utf8",
    );
    assert.match(cas, /new AgentEntryAuthorityError\(verdict\.reason, verdict\.detail\)/);
    const catchAt = body.indexOf("const refusalDetail =");
    assert.ok(catchAt > 0);
    const tail = body.slice(catchAt);
    assert.match(tail, /dispatchGateSnapshot: \{ \.\.\.snapshot, dbError: msg, \.\.\.refusalDetail \}/);
    assert.match(tail, /metadata: \{ commandId: args\.commandId, dbError: msg, \.\.\.refusalDetail \}/);
  });
});
