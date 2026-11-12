import {test} from 'node:test';
import assert from 'node:assert/strict';
import {barCloseMs,advanceBarOpen,calendarAwareTrailingIntervals} from '../timeframes.js';
import {normalizeCandles,rawTrailingIntervalGap} from '../candleNormalization.js';
import {prepareMarketRead,evidenceMatches} from '../../../truth/marketReadEvidence.js';
import {marketFixture} from '../../../truth/__qa__/marketEvidenceFixtures.js';
const at=(x:string)=>Date.parse(x+'T00:00:00Z');
for(const [open,close] of [['2023-02-01','2023-03-01'],['2024-02-01','2024-03-01'],['2026-04-01','2026-05-01'],['2026-12-01','2027-01-01']]){
 test('calendar month closes at actual next boundary '+open,()=>{
  assert.equal(barCloseMs(at(open!),'MN1'),at(close!));
  const raw=[{time:new Date(at(open!)).toISOString(),open:100,high:102,low:99,close:101}];
  const before=normalizeCandles(raw,{symbol:'V50',displaySymbol:'V50',timeframe:'MN1',source:'mt5_broker',now:at(close!)-1});
  const after=normalizeCandles(raw,{symbol:'V50',displaySymbol:'V50',timeframe:'MN1',source:'mt5_broker',now:at(close!)});
  assert.equal(before.candles[0]?.isFinal,false);assert.equal(after.candles[0]?.isFinal,true);
  assert.equal(after.candles[0]?.closeTime,new Date(at(close!)).toISOString());
  assert.equal(rawTrailingIntervalGap(raw,'mt5_broker','MN1',at(close!)),1);
 });
}
test('monthly scanner accepts real February spacing and binds the same closed boundary',()=>{
 const now=at('2024-03-01')+1000;const f=marketFixture({symbol:'V50',timeframe:'MN1',now});
 f.result.candles=Array.from({length:27},(_,i)=>({time:new Date(Date.UTC(2022,i,1)).toISOString(),open:100,high:102,low:99,close:101,brokerSymbol:'Volatility 50 Index'}));
 const result=prepareMarketRead(f.result,'V50','MN1',now);
 assert.ok(result);assert.equal(result.openClosed.length,26);assert.equal(result.evidence.lastClosedCandleAt,'2024-03-01T00:00:00.000Z');assert.equal(result.trailingIntervals,1);
});
test('monthly evidence expires at next actual month boundary, not after31days',()=>{
 const f=marketFixture({symbol:'V50',timeframe:'MN1'}).evidence;
 f.lastClosedCandleAt='2024-02-01T00:00:00.000Z';
 assert.equal(evidenceMatches(f,f,at('2024-02-29')),true);
 assert.equal(evidenceMatches(f,f,at('2024-03-01')),false);
});
test('weekly age is anchored to observed broker week, not Unix epoch Thursday',()=>{
 assert.equal(calendarAwareTrailingIntervals(at('2026-10-26'),'W1',at('2026-11-03')),1);
 assert.equal(calendarAwareTrailingIntervals(at('2026-10-26'),'W1',at('2026-11-09')),2);
});
test('intraday geometry and invalid timestamp refusals remain unchanged',()=>{
 assert.equal(barCloseMs(at('2026-11-05'),'M5'),at('2026-11-05')+300000);
 assert.equal(advanceBarOpen(at('2026-11-05'),'M5',-1),at('2026-11-05')-300000);
 assert.ok(Number.isNaN(barCloseMs(NaN,'MN1')));assert.equal(calendarAwareTrailingIntervals(NaN,'MN1',Date.now()),null);
});
