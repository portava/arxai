// EA v1.35 demo cost wires against the real server parsers. The fixture is the
// exact output of mt5-bridge/ArxDemoCostReceipt.mqh, pinned byte for byte by
// mt5-bridge/tests/run_cost_receipt.py. No DB, broker request or trade.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { beforeEach, test } from "node:test";
import { bridgeV2 } from "@workspace/domain";
import { atiCostReceiptFromResult, freezeAtiDemoConfirmationQuote, reconcileAtiCostEvidence } from "../atiCostEvidence.js";
import { nativeAccountBinding } from "../../brokerHub/nativeAccountReport.js";
import { brokerHistoryIdentity } from "../../data/brokerHistoryPolicy.js";
import { __resetMt5ProviderStore, recordMt5Tick } from "../../data/providers/mt5Provider.js";

const fixture = JSON.parse(readFileSync(new URL("../../../../../../mt5-bridge/tests/fixtures/ati_demo_cost_wire.json", import.meta.url), "utf8"));
const entryRaw = JSON.parse(fixture.entryRaw);
const exitRaw = JSON.parse(fixture.exitRaw);
const tickWire = JSON.parse(fixture.boundTick);
const bridge = { accountNumber: "41339260", serverName: "Deriv-Demo", accountType: "demo" };
const binding = nativeAccountBinding(bridge.accountNumber, bridge.serverName)!;
const owner = 70, bridgeId = 22;

beforeEach(() => __resetMt5ProviderStore());

test("the v1.35 entry and close results carry a receipt the server accepts", () => {
  const entry = atiCostReceiptFromResult(entryRaw, bridge, "DEMO");
  assert.ok(entry, "entry receipt accepted");
  assert.equal(entry.accountBinding, binding);
  assert.equal("accountLogin" in entry, false, "the raw login is not stored");
  assert.equal(entry.leg, "ENTRY");
  const exit = atiCostReceiptFromResult(exitRaw, bridge, "DEMO");
  assert.ok(exit, "close receipt accepted");
  assert.equal(exit.leg, "EXIT");
  assert.equal(exit.positionTicket, "4798698209");
});

test("a receipt from another account, a live bridge or a mismatched result is refused", () => {
  assert.equal(atiCostReceiptFromResult(entryRaw, { ...bridge, serverName: "Deriv-Server" }, "DEMO"), null);
  assert.equal(atiCostReceiptFromResult(entryRaw, { ...bridge, accountNumber: "41339261" }, "DEMO"), null);
  assert.equal(atiCostReceiptFromResult(entryRaw, { ...bridge, accountType: "real" }, "LIVE"), null);
  assert.equal(atiCostReceiptFromResult({ ...entryRaw, resultDeal: "1" }, bridge, "DEMO"), null);
  assert.equal(atiCostReceiptFromResult({ ...entryRaw, resultPrice: 45656.94 }, bridge, "DEMO"), null);
  assert.equal(atiCostReceiptFromResult({ ...exitRaw, positionTicket: "1" }, bridge, "DEMO"), null);
  assert.equal(atiCostReceiptFromResult({ retcode: 10009 }, bridge, "DEMO"), null, "legacy raw has no receipt");
});

test("the receipt reconciles to spread, slippage and charges for the command it reports", () => {
  const entry = atiCostReceiptFromResult(entryRaw, bridge, "DEMO")!;
  const r = reconcileAtiCostEvidence(entry, {
    mode: "DEMO", accountBinding: binding, order: "4798698209", deal: "4767566447",
    symbol: "Volatility 75 Index", side: "BUY", volume: 0.01, price: 45656.93, requestedVolume: 0.01,
  }) as any;
  assert.equal(r.state, "OBSERVED_BROKER_DEAL");
  assert.ok(Math.abs(r.spreadPriceUnits - 15.78) < 1e-9);
  assert.equal(r.adverseSlippagePriceUnits, 0);
  assert.deepEqual(r.charges, { currency: "USD", commission: 0, fee: 0, swap: 0 });
  const exit = atiCostReceiptFromResult(exitRaw, bridge, "DEMO")!;
  const x = reconcileAtiCostEvidence(exit, {
    mode: "DEMO", accountBinding: binding, order: "4798698530", deal: "4767566768",
    symbol: "Volatility 75 Index", side: "SELL", volume: 0.01, price: 45627, requestedVolume: 0.01,
    exit: { targetTicket: "4798698209", filledPositionTicket: "4798698209" },
  }) as any;
  assert.equal(x.state, "OBSERVED_BROKER_DEAL");
  assert.equal(x.leg, "EXIT");
  assert.ok(x.adverseSlippagePriceUnits === 0, "sell filled at the submission bid");
});

test("the v1.35 bound tick is a valid v2 TICK whose account claim matches the bridge", () => {
  const v = bridgeV2.validateBridgeV2Message(tickWire);
  assert.equal(v.ok, true, JSON.stringify(v));
  const claim = tickWire.payload.atiAccount;
  assert.equal(claim.mode, "DEMO");
  assert.equal(nativeAccountBinding(claim.login, claim.server), binding, "ingest's verifiedAtiAccount would accept it");
  assert.equal(tickWire.payload.brokerSymbol, "Volatility 75 Index");
});

test("two consecutive v1.35 ticks let order confirmation freeze a bound demo quote", () => {
  const account = { binding, mode: "DEMO" as const, historyIdentity: brokerHistoryIdentity({
    userId: owner, bridgeConnectionId: bridgeId, accountNumber: bridge.accountNumber,
    serverName: bridge.serverName, clockBasis: "broker_server" }) };
  const p = tickWire.payload;
  const now = Date.now();
  // As bridgeV2/ingest.ts feedMarketDataStore passes an accepted TICK.
  const post = (eaUtcMs: number, brokerTimeMs: number, bid: number, ask: number, receiptId: number) =>
    recordMt5Tick(p.symbol, { bid, ask, brokerSymbol: p.brokerSymbol, brokerTimeMs, eaUtcMs,
      atiReceiptId: receiptId, atiStreamKey: tickWire.streamKey }, { bridgeConnectionId: bridgeId, userId: owner }, account);
  const brokerNow = now + 2 * 3600_000; // a GMT+2 trade server clock
  post(now - 4000, brokerNow - 4100, p.bid, p.ask, 1);
  assert.equal(freezeAtiDemoConfirmationQuote(p.symbol, owner, bridgeId, Date.now()), null, "the first tick a partition holds is not observed");
  post(now - 2000, brokerNow - 2100, p.bid + 1, p.ask + 1, 2);
  assert.equal(freezeAtiDemoConfirmationQuote(p.symbol, owner, bridgeId, now - 1), null, "a quote received after confirmation is refused");
  const confirmedAt = Date.now();
  const q = freezeAtiDemoConfirmationQuote(p.symbol, owner, bridgeId, confirmedAt);
  assert.ok(q, "confirmation freezes the bound quote");
  assert.equal(q.accountBinding, binding);
  assert.equal(q.brokerSymbol, "Volatility 75 Index");
  assert.equal(q.bid, p.bid + 1);
  assert.equal(q.brokerTickAtMs, brokerNow - 2100);
  assert.equal(freezeAtiDemoConfirmationQuote(p.symbol, owner + 1, bridgeId, confirmedAt), null, "another owner cannot freeze it");
  assert.equal(freezeAtiDemoConfirmationQuote(p.symbol, owner, bridgeId + 1, confirmedAt), null, "another bridge cannot freeze it");
});

test("a tick without the account claim never yields a confirmation quote", () => {
  const p = tickWire.payload, now = Date.now(), brokerNow = now + 7200_000;
  for (const [ea, broker, bid] of [[now - 4000, brokerNow - 4100, p.bid], [now - 2000, brokerNow - 2100, p.bid + 1]])
    recordMt5Tick(p.symbol, { bid, ask: bid + 15.78, brokerSymbol: p.brokerSymbol, brokerTimeMs: broker, eaUtcMs: ea },
      { bridgeConnectionId: bridgeId, userId: owner }, null);
  assert.equal(freezeAtiDemoConfirmationQuote(p.symbol, owner, bridgeId, Date.now()), null);
});
