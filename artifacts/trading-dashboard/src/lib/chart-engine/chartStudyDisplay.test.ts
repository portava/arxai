import {describe,it,expect} from 'vitest';
import {formatSavedVwapAnchor,formatObservedBarChoice,studyDisplayLabel} from './chartStudyDisplay';
import {vwapAnchorEvidence} from './chartVwapAnchor';
import {studyDefinition,studyLabel,type ChartStudy} from './chartStudies';
import {TRADE_VOLUME_AUTHORITY} from './chartVolume';
import type {ChartEngineCandle} from './types';
import {executeStudyRequest,parseStudyRequest} from './chartStudyAssistant';
const anchor={kind:'observed_bar' as const,time:1700000000,seriesIdentity:'a'.repeat(64)};
const bar:ChartEngineCandle={time:anchor.time,open:10,high:11,low:9,close:10,volumeEvidence:{kind:'real_volume',unit:'provider_trade_units',quantity:10,reason:null,authority:TRADE_VOLUME_AUTHORITY,seriesIdentity:anchor.seriesIdentity},profileEvidence:{finality:'closed',clockAuthority:TRADE_VOLUME_AUTHORITY}};
describe('saved VWAP anchor clock wording uses exact original row',()=>{
 it('formats verified original anchor separately from canonical lookup identity',()=>{
  const adapter={getVwapAnchorEvidence:(value:typeof anchor)=>vwapAnchorEvidence(value,[bar])};
  const study={...studyDefinition('vwap').defaults,vwapAnchor:anchor};
  expect(formatSavedVwapAnchor(anchor,adapter)).toBe('2023-11-14 22:13:20 UTC');
  expect(studyDisplayLabel(study,adapter)).not.toContain('unverified');expect(studyLabel(study)).toContain('unverified');
  expect(formatObservedBarChoice(bar,adapter)).toBe('2023-11-14 22:13:20 UTC');
 });
 it.each(['absent','wrong-series','forming','withdrawn-clock'])('withdraws saved anchor label when current exact evidence is %s',reason=>{
  const bars=reason==='absent'?[]:[{...bar,...(reason==='wrong-series'?{volumeEvidence:{...bar.volumeEvidence!,seriesIdentity:'b'.repeat(64)}}:{}),profileEvidence:{finality:reason==='forming'?'forming' as const:'closed' as const,clockAuthority:reason==='withdrawn-clock'?null:TRADE_VOLUME_AUTHORITY}}] as ChartEngineCandle[];
  const adapter={getVwapAnchorEvidence:(value:typeof anchor)=>vwapAnchorEvidence(value,bars)};
  expect(formatSavedVwapAnchor(anchor,adapter)).toContain('source clock (UTC unverified)');
 });
 it('never borrows global current-chart UTC qualification in assistant receipt or guesses a number',()=>{
  let studies:ChartStudy[]=[{...studyDefinition('vwap').defaults,vwapAnchor:anchor}];
  const wrong={...bar,volumeEvidence:{...bar.volumeEvidence!,seriesIdentity:'b'.repeat(64)}} as ChartEngineCandle;
  const adapter={getVisibleCandles:()=>[wrong],getVwapAnchorEvidence:(value:typeof anchor)=>vwapAnchorEvidence(value,[wrong]),setStudies:(next:ChartStudy[])=>{studies=next;},getStudyValues:()=>[{label:studyLabel(studies[0]),color:'#ffffff',reason:'Frozen source does not match',values:[{name:'VWAP',value:null}]}]};
  const result=executeStudyRequest(parseStudyRequest('show VWAP')!,{adapter,studies,symbol:'AAPL',timeframe:'M15',feedLabel:'Delayed',utcClockQualified:true,save:()=>{}});
  expect(result).toContain('Frozen observed-bar anchor: 2023-11-14 22:13:20 source clock (UTC unverified)');expect(result).toContain('Frozen source does not match');
 });
});
