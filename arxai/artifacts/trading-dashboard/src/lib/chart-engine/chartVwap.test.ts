import {describe,it,expect} from 'vitest';
import {StudyCalculator,STUDY_CATALOG} from './chartStudies';
import {sameCandle} from './candleReconciliation';
import {adaptChartCandles} from '@/components/scanner/scannerCandleAdapter';
const identity='a'.repeat(64);
const authority='twelve-data:time-series:common-stock:regular-unadjusted:v1';
const tradeEvidence=(quantity:number,seriesIdentity=identity)=>({kind:'real_volume',unit:'provider_trade_units',quantity,authority,seriesIdentity,reason:null});
const data=[
 {time:1700000000,open:9,high:12,low:6,close:9,volumeEvidence:tradeEvidence(2)},
 {time:1700000060,open:15,high:18,low:12,close:15,volumeEvidence:tradeEvidence(6)},
 {time:1700000120,open:12,high:15,low:9,close:12,volumeEvidence:tradeEvidence(4)},
];
const config:any={kind:'vwap',period:1,source:'hlc3',color:'#ffffff',vwapAnchor:{kind:'observed_bar',time:data[0]!.time,seriesIdentity:identity}};
const values=(bars:any[]=data,c=config)=>new StudyCalculator(c).calculate(bars).map(p=>p.values[0]);
describe('original trade-volume anchored bar VWAP',()=>{
 it('has a real calculated price overlay',()=>{expect(STUDY_CATALOG.find(d=>d.defaults.kind as string==='vwap')?.pane).toBe(false);expect(values()).toEqual([9,13.5,13]);});
 it('starts at exact chosen observed bar',()=>{expect(values(data,{...config,vwapAnchor:{...config.vwapAnchor,time:data[1]!.time}})).toEqual([null,15,13.8]);});
 it('holds if exact anchor is absent',()=>{expect(values(data,{...config,vwapAnchor:{...config.vwapAnchor,time:data[0]!.time-60}})).toEqual([null,null,null]);});
 it.each([undefined,{kind:'tick_count',unit:'ticks',quantity:6,reason:null},tradeEvidence(0),tradeEvidence(-1),tradeEvidence(NaN),{...tradeEvidence(6),reason:'partial'},tradeEvidence(6,'b'.repeat(64))])('holds suffix after unavailable/mismatched volume: %j',e=>{const b=data.map(x=>({...x}));b[1]!.volumeEvidence=e as any;expect(values(b)).toEqual([9,null,null]);});
 it('does not move anchor when older history arrives',()=>{expect(values([{...data[0]!,time:data[0]!.time-60,close:999},...data])).toEqual([null,9,13.5,13]);});
 it('revisions and withdrawal match rebuild',()=>{const c=new StudyCalculator(config);c.calculate(data as any);const b=data.map(x=>({...x}));b[1]!.volumeEvidence=tradeEvidence(2);c.calculate(b as any,1);expect(c.points).toEqual(new StudyCalculator(config).calculate(b as any));expect(c.points[2]!.values[0]).toBe(12);b[1]!.volumeEvidence=undefined as any;c.calculate(b as any,1);expect(c.points.map(p=>p.values[0])).toEqual([9,null,null]);});
 it('has prefix invariance with independent arithmetic',()=>{for(let n=1;n<=data.length;n++)expect(values(data.slice(0,n))).toEqual([9,13.5,13].slice(0,n));});
 it('uses the chosen original applied price',()=>{expect(values(data,{...config,source:'high'})).toEqual([12,16.5,16]);});
 it('plots trade quantities separately from ticks',()=>{expect(new StudyCalculator({kind:'trade_volume',period:1,color:'#ffffff'} as any).calculate(data as any).map(p=>p.values)).toEqual([[2],[6],[4]]);});
 it('detects evidence changes without price changes',()=>{for(const e of [tradeEvidence(7),tradeEvidence(2,'b'.repeat(64)),undefined])expect(sameCandle(data[0] as any,{...data[0],volumeEvidence:e} as any)).toBe(false);});
 it('passes evidence only from the exact qualified original provider',()=>{const raw={...data[0],time:data[0]!.time*1000,source:'assistant_real:twelve_data'};expect((adaptChartCandles([raw])[0] as any).volumeEvidence).toEqual(tradeEvidence(2));for(const source of ['mt5_broker','assistant_real:polygon',undefined])expect((adaptChartCandles([{...raw,source}])[0] as any).volumeEvidence).toBeUndefined();});
});
