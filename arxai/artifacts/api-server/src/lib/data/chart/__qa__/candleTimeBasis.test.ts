import {test} from "node:test";
import assert from "node:assert/strict";
import {resolveCandleTimeBasisEvidence} from "../../candleTimeBasisEvidence.js";
import {normalizeCandles} from "../candleNormalization.js";
import {runCandleTruth} from "../candleTruthEngine.js";
import type {Candle} from "../../types.js";
const now=Date.UTC(2026,10,1,12), step=60_000;
const raw:Candle[] = Array.from({length:10},(_,i)=>({time:new Date(now-(10-i)*step).toISOString(),open:1,high:1.2,low:.9,close:1.1}));
const opts={symbol:"EURUSD",displaySymbol:"EUR/USD",timeframe:"M1" as const,source:"mt5_broker",assetClass:"forex" as const,limit:100,now};
for(const source of ["mt5_broker","deriv","deriv_public","binance",null])
 for(const supplied of [undefined,{kind:"original_utc",basis:"UTC",authority:"client_said_utc",reason:null},{kind:"original_utc",basis:"UTC",authority:"current_heartbeat_offset",reason:null}])
  test(`${source}: raw declarations cannot mint unregistered UTC authority (${JSON.stringify(supplied)})`,()=>{
   const evidence=resolveCandleTimeBasisEvidence(supplied,source);
   assert.equal(evidence.kind,"unavailable");assert.equal(evidence.authority,null);assert.equal(evidence.basis,source==="mt5_broker"?"BROKER_SERVER":null);
  });
test("normalization preserves chart coordinates and prices while withholding inferred UTC",()=>{
 const result=normalizeCandles(raw.map(c=>({...c,timeBasisEvidence:{kind:"original_utc",basis:"UTC",authority:"forged",reason:null} as const})),opts);
 assert.equal(result.candles.length,raw.length);
 result.candles.forEach((c,i)=>{assert.equal(c.openTime,raw[i]!.time);assert.equal(c.close,raw[i]!.close);assert.equal(c.timeBasisEvidence?.kind,"unavailable");assert.equal(c.timeBasisEvidence?.basis,"BROKER_SERVER");});
});
test("Truth exposes an explicit historical clock limitation without rewriting OHLC",()=>{
 const truth=runCandleTruth(raw,opts);
 assert.equal(truth.verifiedCandles.length,raw.length);
 assert.match(truth.truthResult.sourceDocumentation.timeBasisNote??"",/broker\/source-clock.*UTC mapping is unverified/);
 assert.ok(truth.verifiedCandles.every(c=>c.timeBasisEvidence?.kind==="unavailable"));
});

test("MT5 truth documents the actual terminal source and complete timeframe contract", () => {
 for (const assetClass of ["forex", "synthetic"] as const) {
  const result = runCandleTruth(raw, { ...opts, assetClass }).truthResult;
  const docs = result.sourceDocumentation;
  assert.match(docs.dataMode, /MetaTrader 5/);
  assert.match(docs.updateMethod, /native OHLC/);
  assert.doesNotMatch(JSON.stringify(docs), /DERIV_APP_ID|Deriv WebSocket/);
  assert.equal(docs.supportedTimeframes.length, 21);
  assert.deepEqual(result.allowedTimeframes, docs.supportedTimeframes);
  for (const tf of ["M2", "M15", "H12", "W1", "MN1"]) assert.ok(docs.supportedTimeframes.includes(tf));
  assert.ok(docs.knownLimitations.some(x => /do not guarantee/.test(x)));
  assert.match(docs.timeBasisNote ?? "", /UTC mapping is unverified/);
 }
});
