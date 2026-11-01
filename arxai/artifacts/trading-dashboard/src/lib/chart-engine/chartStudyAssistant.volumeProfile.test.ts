import {describe,it,expect} from 'vitest';
import {parseStudyRequest} from './chartStudyAssistant';

describe('existing assistant estimated Volume Profile grammar',()=>{
 it.each(['show volume profile','What does volume profile tell me about this chart?','explain volume profile on this chart'])('recognizes a complete bounded request: %s',request=>{
  expect(parseStudyRequest(request)).toMatchObject({kind:'volume_profile',action:'show'});
 });
 it('supports explicit rows, value area and visible range without inferring session rules',()=>{
  expect(parseStudyRequest('set volume profile rows to 48')).toMatchObject({kind:'volume_profile',action:'show',profileRows:48,preserveVisibility:true});
  expect(parseStudyRequest('set volume profile value area to 68 percent')).toMatchObject({kind:'volume_profile',action:'show',profileValueAreaPercent:68,preserveVisibility:true});
  expect(parseStudyRequest('freeze volume profile to visible range')).toMatchObject({kind:'volume_profile',action:'show',refreezeProfile:true});
 });
 it.each(['show volume profile on EURUSD','show volume profile on M5','show volume profile and RSI','set volume profile rows to 0','set volume profile rows to 129','set volume profile rows to 12.5','set volume profile value area to 101 percent','show session volume profile','do not show volume profile','show volume profile between yesterday and today','show volume profile using tick volume'])('refuses unsupported whole instruction: %s',request=>{
  expect(parseStudyRequest(request)).toHaveProperty('error');
 });
});

import {vi} from 'vitest';
import {executeStudyRequest} from './chartStudyAssistant';
import {calculateVolumeProfile,prepareVolumeProfileStudy} from './chartVolumeProfile';
import {studyDefinition,studyId,studyLabel,type ChartStudy} from './chartStudies';
import {TRADE_VOLUME_AUTHORITY} from './chartVolume';
import {vwapAnchorEvidence} from './chartVwapAnchor';
import type {ChartEngineCandle} from './types';
import {readMatchingVolumeProfile,describeVolumeProfile} from './chartVolumeProfileDescription';

function profileFixture(){
 let bars:ChartEngineCandle[]=Array.from({length:6},(_,i)=>({time:1700000000+i*60,open:10+i,high:12+i,low:9+i,close:11+i,volumeEvidence:{kind:'real_volume',unit:'provider_trade_units',quantity:(i+1)*10,reason:null,authority:TRADE_VOLUME_AUTHORITY,seriesIdentity:'a'.repeat(64)},profileEvidence:{finality:'closed',clockAuthority:TRADE_VOLUME_AUTHORITY}}));
 let visible=bars.slice(),studies:ChartStudy[]=[];
 const adapter={setStudies:vi.fn((next:ChartStudy[])=>{studies=next;}),getVisibleCandles:()=>visible,getStudyValues:()=>[],getVwapAnchorEvidence:(anchor:NonNullable<ChartStudy['vwapAnchor']>)=>vwapAnchorEvidence(anchor,bars),getVolumeProfiles:()=>studies.filter(s=>s.kind==='volume_profile').map(s=>({id:studyId(s),label:studyLabel(s),visible:s.lineStyles?.[0]?.visible!==false,result:calculateVolumeProfile(bars,s.profileRange,s.profileRows??32,s.profileValueAreaPercent??70)}))};
 const save=vi.fn((next:ChartStudy[])=>{studies=next;});
 const context=()=>({adapter,studies,symbol:'AAPL',timeframe:'M15',feedLabel:'assistant_real:twelve_data · Delayed',utcClockQualified:true,save});
 return {adapter,context,save,bars:()=>bars,studies:()=>studies,setBars:(value:ChartEngineCandle[])=>{bars=value;visible=value;},setVisible:(value:ChartEngineCandle[])=>{visible=value;},setStudies:(value:ChartStudy[])=>{studies=value;},run:(text:string)=>executeStudyRequest(parseStudyRequest(text)!,context())};
}

describe('one installed profile authority for manual and local assistant actions',()=>{
 it('curiosity applies the same exact frozen range and aggregate as manual settings',()=>{
  const f=profileFixture(),manual=prepareVolumeProfileStudy(studyDefinition('volume_profile').defaults,f.bars()).study!;
  const reply=f.run('What does volume profile tell me about this chart?');
  expect(f.studies()).toHaveLength(1);expect(f.studies()[0].profileRange).toEqual(manual.profileRange);
  const actual=f.adapter.getVolumeProfiles()[0]!.result;
  expect(actual).toEqual(calculateVolumeProfile(f.bars(),manual.profileRange,32,70));
  expect(reply).toContain('210 provider-reported trade units');expect(reply).toContain('Estimated POC row');expect(reply).toContain('Value-area target 70%');
  expect(reply).toContain('not measured transactions-at-price');expect(reply).toContain('AAPL · M15');expect(reply).toContain('Delayed');expect(reply).toContain('No order was sent');
  f.run('show volume profile');expect(f.studies()).toHaveLength(1);
 });
 it('edits rows and value area without replacing frozen range or hidden manual preferences',()=>{
  const f=profileFixture();f.run('show volume profile');const range=f.studies()[0].profileRange;
  f.setStudies([{...f.studies()[0],color:'#abcdef'}]);f.run('hide volume profile');
  const reply=f.run('set volume profile rows to 48');f.run('set volume profile value area to 80 percent');
  expect(f.studies()[0]).toMatchObject({profileRows:48,profileValueAreaPercent:80,profileRange:range,color:'#abcdef',lineStyles:[{visible:false}]});
  expect(reply).toContain('profile is hidden');expect(reply).toContain('visibility retained');
  f.run('show volume profile');expect(f.studies()[0].lineStyles?.[0]?.visible).toBe(true);
  f.run('remove volume profile');expect(f.studies()).toEqual([]);
 });
 it('freezes exact visible endpoints only on explicit refresh; a forming tail is excluded',()=>{
  const f=profileFixture();const original=f.bars();f.setBars([...original,{...original[5]!,time:original[5]!.time+60,profileEvidence:{finality:'forming',clockAuthority:TRADE_VOLUME_AUTHORITY}}]);
  f.run('show volume profile');expect(f.studies()[0].profileRange?.toTime).toBe(original[5]!.time);
  f.setVisible(original.slice(2,5));f.run('explain volume profile');expect(f.studies()[0].profileRange?.fromTime).toBe(original[0]!.time);
  f.run('freeze volume profile to visible range');expect(f.studies()[0].profileRange).toMatchObject({fromTime:original[2]!.time,toTime:original[4]!.time});
 });
 it('refuses unqualified first selection without partial changes or tick fallback',()=>{
  const f=profileFixture();f.setBars(f.bars().map(b=>({...b,volumeEvidence:undefined})));
  expect(f.run('show volume profile')).toMatch(/not changed|qualified/i);expect(f.save).not.toHaveBeenCalled();expect(f.adapter.setStudies).not.toHaveBeenCalled();
 });
 it('withdraws aggregate explanation after same-price metadata or source evidence withdrawal',()=>{
  const f=profileFixture();f.run('show volume profile');const kept=f.studies()[0].profileRange;
  f.setBars(f.bars().map(b=>({...b,profileEvidence:{finality:'closed',clockAuthority:null}})));
  const reply=f.run('explain volume profile');expect(reply).toContain('Profile withheld');expect(reply).not.toContain('Estimated POC row');expect(f.studies()[0].profileRange).toEqual(kept);
 });
 it('does not print stale or guessed aggregate values when renderer owner/config differs',()=>{
  const f=profileFixture();f.run('show volume profile');const study=f.studies()[0],actual=f.adapter.getVolumeProfiles()[0]!;
  const stale={getVolumeProfiles:()=>[{...actual,id:'another-pane'}]};expect(readMatchingVolumeProfile(stale,study)).toBeNull();
  expect(describeVolumeProfile(null,study)).toContain('not verified');
  if(actual.result.status==='ready'){
   const result=actual.result;
   expect(readMatchingVolumeProfile({getVolumeProfiles:()=>[{...actual,result:{...result,rowCount:31,requestedRowCount:31}}]},study)).toBeNull();
  }
 });
 it('refuses duplicate instance ambiguity, capacity and extra instructions atomically',()=>{
  const f=profileFixture();f.run('show volume profile');const first=f.studies()[0];f.setStudies([first,{...first,id:'second'}]);f.adapter.setStudies.mockClear();
  expect(f.run('hide volume profile')).toContain('multiple');expect(f.adapter.setStudies).not.toHaveBeenCalled();
  f.setStudies(Array.from({length:12},(_,i)=>({...studyDefinition('sma').defaults,id:String(i)})));
  expect(f.run('show volume profile')).toContain('limit');expect(f.adapter.setStudies).not.toHaveBeenCalled();
  expect(f.run('show volume profile and RSI')).toContain('not changed');expect(f.adapter.setStudies).not.toHaveBeenCalled();
 });
});
