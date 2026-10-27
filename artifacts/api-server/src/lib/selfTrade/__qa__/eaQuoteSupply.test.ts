// Which EA builds stream broker quotes: a pure table keyed by exact major.minor,
// verified against mt5-bridge/*.mq5 (docs/SELF_TRADING_BROKER_QUOTE_SUPPLY_2026_10_27.md).
// The lookup only explains a missing quote; it never changes the fail-closed
// outcome, and an unknown version is reported as unknown, never guessed.
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { describeEaQuoteSupply, eaVersionKey } from "../eaQuoteSupply.js";
import { describeQuoteUnavailable, evaluateEntryFreshFacts } from "../freshFacts.js";

describe("eaVersionKey", () => {
  it("accepts the heartbeat's plain major.minor and common decorations", () => {
    for (const [raw, key] of [
      ["1.31", "1.31"],
      ["1.54", "1.54"],
      ["v1.54", "1.54"],
      ["V2.00", "2.00"],
      [" 1.52 ", "1.52"],
      ["1.54.1", "1.54"],
      ["1.54-beta", "1.54"],
      ["01.31", "1.31"],
    ] as const)
      assert.equal(eaVersionKey(raw), key, raw);
  });
  it("refuses anything that is not a version", () => {
    for (const raw of [null, undefined, "", "   ", "latest", "1", "1.", ".54", "1,54", 1.54, {}, "1.5x4"])
      assert.equal(eaVersionKey(raw), null, String(raw));
  });
});

describe("describeEaQuoteSupply", () => {
  it("the shipped v1.31 kit and every other poll-only build stream no quotes", () => {
    for (const v of ["1.27", "1.28", "1.29", "1.30", "1.31", "1.40", "1.50", "1.51"]) {
      const s = describeEaQuoteSupply(v);
      assert.equal(s.quoteStream, "NONE", v);
      assert.equal(s.versionKey, v);
      assert.match(s.note, new RegExp(`^EA v${v.replace(".", "\\.")} does not stream broker quotes \\(`));
    }
    assert.match(describeEaQuoteSupply("1.31").note, /ReplitMT5BridgeEA_v131\.mq5/);
    assert.match(describeEaQuoteSupply("1.51").note, /candles\/ingest only/);
  });
  it("the v1.52 and v1.54 Universal Agents stream their configured symbols only", () => {
    for (const v of ["1.52", "1.54"]) {
      const s = describeEaQuoteSupply(v);
      assert.equal(s.quoteStream, "STREAMS_CONFIGURED_SYMBOLS", v);
      assert.match(s.note, /CandleSymbols/);
      assert.match(s.note, /chart symbol only/);
    }
  });
  it("the v2.00 beta kernel is opt-in and off by default", () => {
    const s = describeEaQuoteSupply("2.00");
    assert.equal(s.quoteStream, "OPT_IN_DEFAULT_OFF");
    assert.match(s.note, /EnableTickStream=true/);
  });
  it("a version outside the table is unknown: ordering is never used to infer support", () => {
    for (const v of ["1.53", "1.55", "1.60", "3.00", "0.99"]) {
      const s = describeEaQuoteSupply(v);
      assert.equal(s.quoteStream, "UNKNOWN", v);
      assert.equal(s.versionKey, v);
      assert.match(s.note, /not in the verified table/);
    }
  });
  it("a missing or malformed version is unknown and keeps the raw text for the operator", () => {
    const none = describeEaQuoteSupply(null);
    assert.equal(none.quoteStream, "UNKNOWN");
    assert.equal(none.eaVersion, null);
    assert.equal(none.versionKey, null);
    assert.match(none.note, /reported no EA version/);
    const junk = describeEaQuoteSupply(" build-7 ");
    assert.equal(junk.quoteStream, "UNKNOWN");
    assert.equal(junk.eaVersion, "build-7");
    assert.equal(junk.versionKey, null);
  });
});

describe("the refusal detail for a missing quote", () => {
  const base = {
    bid: null,
    ask: null,
    observedAt: null,
    source: "mt5_broker",
    point: null,
    error: "BROKER_QUOTE_UNAVAILABLE",
    requestedSymbol: "EURUSD",
    brokerSymbol: "EURUSD.r",
    bridgeConnectionId: 12,
    eaVersion: "1.31",
    eaQuoteSupply: describeEaQuoteSupply("1.31"),
  };
  it("names the error, both symbols, the bridge and the EA's supply", () => {
    assert.equal(
      describeQuoteUnavailable(base),
      "BROKER_QUOTE_UNAVAILABLE; symbol EURUSD.r (requested EURUSD); bridge 12; " +
        describeEaQuoteSupply("1.31").note,
    );
  });
  it("is the UNAVAILABLE verdict's detail and does not change the reason", () => {
    const v = evaluateEntryFreshFacts({
      side: "BUY",
      stopLoss: 1.09,
      thesis: { entryZone: { from: 1.1, to: 1.1001 } },
      observation: base,
      nowMs: Date.now(),
    });
    assert.equal(v.ok, false);
    if (!v.ok) {
      assert.equal(v.reason, "ENTRY_FRESH_QUOTE_UNAVAILABLE");
      assert.match(v.detail, /^BROKER_QUOTE_UNAVAILABLE; .*EA v1\.31 does not stream broker quotes/);
    }
  });
  it("degrades honestly when parts are unknown", () => {
    assert.equal(describeQuoteUnavailable(null), "no quote observation");
    assert.equal(
      describeQuoteUnavailable({ ...base, brokerSymbol: null, bridgeConnectionId: null, eaQuoteSupply: null }),
      "BROKER_QUOTE_UNAVAILABLE; symbol unresolved (requested EURUSD); bridge unknown",
    );
    assert.equal(
      describeQuoteUnavailable({ bid: null, ask: null, observedAt: null, source: null, point: null, error: "X" }),
      "X; bridge unknown",
    );
  });
});
