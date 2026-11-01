import {expect,it} from 'vitest';
import {STUDY_CATALOG,StudyCalculator,type ChartStudy} from './chartStudies';
import {validatePreferences} from './chartWorkspace';
import {calculateVolumeProfile,prepareVolumeProfileStudy,profileCandleEvidence,type VolumeProfileRange} from './chartVolumeProfile';
import {TRADE_VOLUME_AUTHORITY} from './chartVolume';
import type {ChartEngineCandle} from './types';
const identity='a'.repeat(64);
export const profileBar=(time:number,low=1,high=9,quantity=80):ChartEngineCandle=>({time,open:low,high,low,close:high,volumeEvidence:{kind:'real_volume',unit:'provider_trade_units',quantity,reason:null,authority:TRADE_VOLUME_AUTHORITY,seriesIdentity:identity},profileEvidence:{finality:'closed',clockAuthority:TRADE_VOLUME_AUTHORITY}});
const range=(bars:ChartEngineCandle[]):VolumeProfileRange=>({kind:'observed_range',fromTime:bars[0]!.time,toTime:bars.at(-1)!.time,seriesIdentity:identity,clockAuthority:TRADE_VOLUME_AUTHORITY});
const config:ChartStudy={kind:'volume_profile',period:1,color:'#22ccaa',profileRows:8,profileValueAreaPercent:70};
it('registers an actual configurable estimated volume profile',()=>{expect(STUDY_CATALOG.find(row=>row.defaults.kind==='volume_profile')).toBeDefined();expect(validatePreferences({studies:[config]}).studies).toHaveLength(1);});
it('allocates exact hand-computed overlap, POC interval and below-target whole-row value area',()=>{
 const bars=[profileBar(60),profileBar(120,1,3,40)],result=calculateVolumeProfile(bars,range(bars),8,70);expect(result.status).toBe('ready');if(result.status!=='ready')return;
 expect(result.rows.map(r=>r.estimatedTradeUnits)).toEqual([30,30,10,10,10,10,10,10]);expect(result.totalTradeUnits).toBe(120);expect(result.pocIndex).toBe(0);expect(result.valueArea).toEqual({low:1,high:5,fromIndex:0,toIndex:3,targetPercent:70,achievedPercent:80/120*100,estimatedTradeUnits:80});
 expect(result.rows.reduce((n,r)=>n+r.estimatedTradeUnits,0)).toBe(result.totalTradeUnits);
});
it('stops value area once target reached rather than extending through zero-volume neighbors',()=>{
 const bars=[profileBar(60,1,1,70),profileBar(120,9,9,30)],r=calculateVolumeProfile(bars,range(bars),8,70);expect(r.status).toBe('ready');if(r.status!=='ready')return;expect(r.rows.map(b=>b.estimatedTradeUnits)).toEqual([70,0,0,0,0,0,0,30]);expect(r.valueArea.toIndex).toBe(0);expect(r.valueArea.achievedPercent).toBe(70);
});
it('handles flat original prices without inventing a tick size; POC alone may exceed target',()=>{
 const bars=[profileBar(60,5,5,80),profileBar(120,5,5,20)],r=calculateVolumeProfile(bars,range(bars),32,70);expect(r).toMatchObject({status:'ready',requestedRowCount:32,rowCount:1,rows:[{low:5,high:5,estimatedTradeUnits:100}],valueArea:{achievedPercent:100}});
});
it('assigns exact boundary flat candles once, with maximum in final row',()=>{
 const bars=[profileBar(60,1,9,80),profileBar(120,2,2,20),profileBar(180,9,9,30)],r=calculateVolumeProfile(bars,range(bars),8,100);if(r.status!=='ready')throw Error(r.reason);expect(r.rows.map(x=>x.estimatedTradeUnits)).toEqual([10,30,10,10,10,10,10,40]);expect(r.valueArea.fromIndex).toBe(0);expect(r.valueArea.toIndex).toBe(7);
});
it('matches independent straightforward overlap reference including decimal prices',()=>{
 const bars=Array.from({length:237},(_,i)=>{const low=101+Math.sin(i/7)*3;return profileBar(60+i*60,low,low+.1+(i%11)/10,101+i);});const r=calculateVolumeProfile(bars,range(bars),32,70);if(r.status!=='ready')throw Error(r.reason);
 const expected=r.rows.map(row=>bars.reduce((sum,b)=>sum+b.volumeEvidence!.quantity!*Math.max(0,Math.min(b.high,row.high)-Math.max(b.low,row.low))/(b.high-b.low),0));r.rows.forEach((row,i)=>expect(row.estimatedTradeUnits).toBeCloseTo(expected[i]!,8));expect(r.rows.reduce((s,b)=>s+b.estimatedTradeUnits,0)).toBeCloseTo(r.totalTradeUnits,8);
});
it.each(['missing','zero','fraction','tick','series','clock','closed','contradictory','price','duplicate'] as const)('holds whole range for %s evidence; never salvages sparse rows',mode=>{
 const bars=[profileBar(60),profileBar(120),profileBar(180)],bad=bars[1]!;
 if(mode==='missing')delete bad.volumeEvidence;if(mode==='zero')bad.volumeEvidence!.quantity=0;if(mode==='fraction')bad.volumeEvidence!.quantity=1.1;if(mode==='tick')bad.volumeEvidence={kind:'tick_count',quantity:12,unit:'ticks',reason:null};if(mode==='series')bad.volumeEvidence!.seriesIdentity='b'.repeat(64);if(mode==='clock')bad.profileEvidence!.clockAuthority=null;if(mode==='closed')bad.profileEvidence!.finality='forming';if(mode==='contradictory')bad.profileEvidence=profileCandleEvidence({isFinal:true,isComplete:false,isForming:false});if(mode==='price')bad.high=0;if(mode==='duplicate')bad.time=60;
 expect(calculateVolumeProfile(bars,{...range(bars),fromTime:60,toTime:180},8,70).status).toBe('held');
});
it('normalizes actual provider forming shape and excludes exactly one declared tail; advisory outlier retained',()=>{
 const closed=profileCandleEvidence({isFinal:true,isComplete:true,isForming:false,timeBasisEvidence:{kind:'original_utc',basis:'UTC',reason:null,authority:TRADE_VOLUME_AUTHORITY},qualityFlags:['OUTLIER_SPIKE']});expect(closed.finality).toBe('closed');
 const forming=profileCandleEvidence({isFinal:false,isComplete:false,isForming:false,qualityFlags:['FORMING_BAR']});expect(forming.finality).toBe('forming');
 const bars=[profileBar(60),{...profileBar(120),profileEvidence:forming}],p=prepareVolumeProfileStudy(config,bars);if(!p.study)throw Error(p.reason);expect(p.study.profileRange?.toTime).toBe(60);expect(calculateVolumeProfile(bars,p.study.profileRange,8,70)).toMatchObject({status:'ready',omittedFormingTail:1});bars.push({...profileBar(180),profileEvidence:forming});expect(prepareVolumeProfileStudy(config,bars)).toHaveProperty('reason');
});
it.each(['OHLC_INVALID','TIMESTAMP_INVALID','DUPLICATE_BUCKET'])('withdraws original corruption flag %s before canonical sanitization',flag=>{expect(profileCandleEvidence({isFinal:true,isComplete:true,isForming:false,qualityFlags:[flag]}).finality).toBe('unqualified');});
it('keeps original closed observations across an advisory session gap without claiming complete coverage',()=>{
 const evidence=profileCandleEvidence({isFinal:true,isComplete:true,isForming:false,timeBasisEvidence:{kind:'original_utc',basis:'UTC',reason:null,authority:TRADE_VOLUME_AUTHORITY},qualityFlags:['STALE_FROM_PREV_TF']});
 // The normalizer attaches this advisory whenever steps > 2, including known
 // closed-market slots. It does not establish a wrong symbol or timeframe.
 const bars=[profileBar(1792698300),{...profileBar(1792762200),profileEvidence:evidence}];
 const result=calculateVolumeProfile(bars,range(bars),8,70);
 expect(result).toMatchObject({status:'ready',barCount:2});
 if(result.status==='ready')expect(result.limitations.join(' ')).toContain('time gaps are not zero-volume proof');
 expect(calculateVolumeProfile([{...bars[0]!,profileEvidence:{...evidence,clockAuthority:null}},bars[1]!],range(bars),8,70).status).toBe('held');
});
it('holds unsafe total, collapsed IEEE price bins and overlarge range',()=>{
 let bars=[profileBar(60,1,9,Number.MAX_SAFE_INTEGER),profileBar(120)];expect(calculateVolumeProfile(bars,range(bars),8,70).status).toBe('held');bars=[profileBar(60,1e16,1e16+2)];expect(calculateVolumeProfile(bars,range(bars),128,70).status).toBe('held');bars=Array.from({length:5001},(_,i)=>profileBar(60+i*60));expect(calculateVolumeProfile(bars,range(bars),8,70).status).toBe('held');
});
it('requires future frozen endpoint to arrive, preserves source-bound range and exposes immutable aggregate',()=>{
 const bars=[profileBar(60),profileBar(120)],prepared=prepareVolumeProfileStudy(config,bars);if(!prepared.study)throw Error(prepared.reason);const calculator=new StudyCalculator(prepared.study);calculator.calculate(bars.slice(0,1));expect(calculator.profileResult?.status).toBe('held');calculator.calculate(bars);const r=calculator.profileResult!;if(r.status!=='ready')throw Error(r.reason);expect(Object.isFrozen(r)).toBe(true);expect(()=>{(r.rows[0] as any).estimatedTradeUnits=1;}).toThrow();expect(()=>{(r.range as any).fromTime=500;}).toThrow();expect(r.rows[0]!.estimatedTradeUnits).toBe(20);expect(calculator.points).toEqual([]);expect(prepareVolumeProfileStudy(prepared.study,[profileBar(999)])).toEqual({study:prepared.study});
});
it('rejects invalid saved rows/range and retains exact valid preferences',()=>{
 const bars=[profileBar(60)],prepared=prepareVolumeProfileStudy(config,bars);if(!prepared.study)throw Error(prepared.reason);expect(validatePreferences({studies:[prepared.study]}).studies[0]).toEqual(prepared.study);for(const patch of [{profileRows:7},{profileRows:129},{profileValueAreaPercent:0},{profileValueAreaPercent:70.5},{profileRange:{...prepared.study.profileRange,clockAuthority:'guessed'}}])expect(validatePreferences({studies:[{...prepared.study,...patch}]}).studies).toEqual([]);
});

it('holds contradictory FORMING_BAR declarations without using the flag alone as finality',()=>{for(const fields of [{isFinal:true,isComplete:true,isForming:false},{isFinal:true,isComplete:false,isForming:false},{isFinal:false,isComplete:true,isForming:false},{}])expect(profileCandleEvidence({...fields,qualityFlags:['FORMING_BAR']}).finality).toBe('unqualified');});
