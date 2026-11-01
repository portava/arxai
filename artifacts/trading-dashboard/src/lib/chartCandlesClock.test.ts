import {afterEach,it,expect,vi} from 'vitest';
import {fetchChartCandles} from './chartCandlesQuery';
const utc={kind:'original_utc',basis:'UTC',authority:'test-original-utc',reason:null};
afterEach(()=>vi.unstubAllGlobals());
it.each([[[utc,utc],true],[[utc,null],false],[[utc,{...utc,authority:'other'}],false],[[null,null],false]] as const)('normalizes the same explicit clock evidence used by the chart: %j',async(evidence,qualified)=>{
 const candles=evidence.map((e,i)=>({symbol:"TEST",timeframe:"M1",source:"deriv_public",openTime:new Date(1700000000000+i*60000).toISOString(),open:10,high:11,low:9,close:10,...(e?{timeBasisEvidence:e}:{})}));
 vi.stubGlobal('fetch',vi.fn(async()=>new Response(JSON.stringify({symbol:"TEST",timeframe:"M1",candles,feedStatus:{symbol:"TEST",source:"deriv_public",isLive:true,aiUsable:true}}))));
 const actual=await fetchChartCandles('TEST','M1',2);expect(actual.sourceClockQualified).toBe(qualified);expect(actual.candles).toHaveLength(2);expect(actual.originalResponse).toEqual({symbol:"TEST",timeframe:"M1",candles,feedStatus:{symbol:"TEST",source:"deriv_public",isLive:true,aiUsable:true}});
});
it.each(['response-symbol','response-timeframe','candle-symbol','candle-timeframe','candle-source','feed-symbol','missing-owner'])('withholds wrong-owner prices and clock claims: %s',async(mismatch)=>{
 const body:any={symbol:'TEST',timeframe:'M1',feedStatus:{symbol:'TEST',source:'deriv_public',isLive:true,aiUsable:true},candles:[{symbol:'TEST',timeframe:'M1',source:'deriv_public',timeBasisEvidence:utc,openTime:'2026-11-01T14:00:00Z',open:100,high:101,low:99,close:100}]};
 if(mismatch==='response-symbol')body.symbol='OTHER';if(mismatch==='response-timeframe')body.timeframe='H1';if(mismatch==='candle-symbol')body.candles[0].symbol='OTHER';if(mismatch==='candle-timeframe')body.candles[0].timeframe='H1';if(mismatch==='candle-source')body.candles[0].source='other';if(mismatch==='feed-symbol')body.feedStatus.symbol='OTHER';if(mismatch==='missing-owner')delete body.candles[0].symbol;
 vi.stubGlobal('fetch',vi.fn(async()=>new Response(JSON.stringify(body))));const result=await fetchChartCandles('TEST','M1',200);expect(result.candles).toEqual([]);expect(result.sourceClockQualified).toBe(false);
});
