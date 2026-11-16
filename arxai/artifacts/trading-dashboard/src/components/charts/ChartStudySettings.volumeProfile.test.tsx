import {useState} from 'react';
import {cleanup,fireEvent,render,screen,within} from '@testing-library/react';
import {afterEach,it,expect} from 'vitest';
import {ChartStudySettings} from './ChartStudySettings';
import {DEFAULT_PREFERENCES,type ChartPreferences} from '@/lib/chart-engine/chartWorkspace';
import {TRADE_VOLUME_AUTHORITY} from '@/lib/chart-engine/chartVolume';
import {vwapAnchorEvidence} from '@/lib/chart-engine/chartVwapAnchor';
import {studyDefinition} from '@/lib/chart-engine/chartStudies';
import type {ChartEngineCandle} from '@/lib/chart-engine/types';
const initialBars=():ChartEngineCandle[]=>Array.from({length:6},(_,i)=>({time:1700000000+i*60,open:10+i,high:12+i,low:9+i,close:11+i,volumeEvidence:{kind:'real_volume',unit:'provider_trade_units',quantity:(i+1)*10,reason:null,authority:TRADE_VOLUME_AUTHORITY,seriesIdentity:'a'.repeat(64)},profileEvidence:{finality:'closed',clockAuthority:TRADE_VOLUME_AUTHORITY}}));
const settings=()=>JSON.parse(screen.getByTestId('preferences').textContent!);
afterEach(cleanup);
function fixture(){
 let bars=initialBars(),reads=0;
 const adapter={getVisibleCandles:()=>{reads++;return bars;},getVwapAnchorEvidence:(anchor:any)=>vwapAnchorEvidence(anchor,bars)};
 function Workspace(){const [preferences,setPreferences]=useState<ChartPreferences>(DEFAULT_PREFERENCES);return <><ChartStudySettings adapter={adapter} preferences={preferences} onPreferences={setPreferences}/><output data-testid="preferences">{JSON.stringify(preferences)}</output></>;}
 render(<Workspace/>);
 return {bars:()=>bars,setBars:(value:ChartEngineCandle[])=>{bars=value;},reads:()=>reads};
}
it('manual profile controls freeze actual endpoints, edit rows/value area, hide/show and remove through existing preferences',()=>{
 const f=fixture();fireEvent.click(screen.getByRole('button',{name:'Add Estimated volume profile'}));
 expect(settings().studies[0]).toMatchObject({kind:'volume_profile',profileRows:32,profileValueAreaPercent:70,profileRange:{fromTime:f.bars()[0].time,toTime:f.bars()[5].time}});
 expect(screen.queryByLabelText('VOLUME_PROFILE 1 Period')).toBeNull();
 fireEvent.blur(screen.getByLabelText('VOLUME_PROFILE 1 Rows'),{target:{value:'48'}});
 fireEvent.blur(screen.getByLabelText('VOLUME_PROFILE 1 Value area %'),{target:{value:'80'}});
 fireEvent.focus(screen.getByLabelText('VOLUME_PROFILE 1 Range start'));
 fireEvent.change(screen.getByLabelText('VOLUME_PROFILE 1 Range start'),{target:{value:String(f.bars()[1].time)}});
 fireEvent.change(screen.getByLabelText('VOLUME_PROFILE 1 Range end'),{target:{value:String(f.bars()[4].time)}});
 expect(settings().studies[0]).toMatchObject({profileRows:48,profileValueAreaPercent:80,profileRange:{fromTime:f.bars()[1].time,toTime:f.bars()[4].time}});
 const channel=studyDefinition('volume_profile').channels[0];
 fireEvent.click(screen.getByLabelText(`VOLUME_PROFILE 1 ${channel} visible`));expect(settings().studies[0].lineStyles[0].visible).toBe(false);
 fireEvent.click(screen.getByLabelText(`VOLUME_PROFILE 1 ${channel} visible`));expect(settings().studies[0].lineStyles[0].visible).toBe(true);
 fireEvent.click(screen.getByRole('button',{name:'Remove study 1'}));expect(settings().studies).toEqual([]);
});
it('rejects malformed row counts and stale endpoint choices without partly rewriting saved range',()=>{
 const f=fixture();fireEvent.click(screen.getByRole('button',{name:'Add Estimated volume profile'}));
 const before=settings();
 fireEvent.blur(screen.getByLabelText('VOLUME_PROFILE 1 Rows'),{target:{value:'129'}});expect(settings()).toEqual(before);
 fireEvent.blur(screen.getByLabelText('VOLUME_PROFILE 1 Value area %'),{target:{value:'0'}});expect(settings()).toEqual(before);
 fireEvent.focus(screen.getByLabelText('VOLUME_PROFILE 1 Range start'));const chosen=f.bars()[2].time;
 f.setBars(f.bars().map(b=>({...b,profileEvidence:{finality:'closed',clockAuthority:null}})));
 fireEvent.change(screen.getByLabelText('VOLUME_PROFILE 1 Range start'),{target:{value:String(chosen)}});expect(settings()).toEqual(before);
 fireEvent.click(screen.getByRole('button',{name:'VOLUME_PROFILE 1 Freeze visible range'}));expect(settings()).toEqual(before);expect(screen.getAllByRole('status').some(node=>/UTC|qualified/.test(node.textContent??''))).toBe(true);
});
it('does not silently reanchor on unrelated edits; refreeze is explicit and copies are independent',()=>{
 const f=fixture();fireEvent.click(screen.getByRole('button',{name:'Add Estimated volume profile'}));const frozen=settings().studies[0].profileRange;
 f.setBars(f.bars().slice(2));fireEvent.change(screen.getByLabelText('VOLUME_PROFILE 1 Color'),{target:{value:'#123456'}});expect(settings().studies[0].profileRange).toEqual(frozen);
 fireEvent.click(screen.getByRole('button',{name:'Duplicate study 1'}));fireEvent.click(screen.getByRole('button',{name:'VOLUME_PROFILE 2 Freeze visible range'}));
 expect(settings().studies[0].profileRange).toEqual(frozen);expect(settings().studies[1].profileRange.fromTime).toBe(f.bars()[0].time);
});
it('keeps endpoint choices bounded and only reads visible history on deliberate controls',()=>{
 const f=fixture();expect(f.reads()).toBe(0);fireEvent.click(screen.getByRole('button',{name:'Add Estimated volume profile'}));expect(f.reads()).toBe(1);
 fireEvent.change(screen.getByLabelText('VOLUME_PROFILE 1 Color'),{target:{value:'#123456'}});expect(f.reads()).toBe(1);
 fireEvent.focus(screen.getByLabelText('VOLUME_PROFILE 1 Range start'));expect(f.reads()).toBe(2);
 expect(within(screen.getByLabelText('VOLUME_PROFILE 1 Range start')).getAllByRole('option')).toHaveLength(6);
});

it.each(['series','clock'] as const)('withdraws selected saved VWAP and profile endpoint clock labels when same-time %s authority changes',reason=>{
 const f=fixture();fireEvent.click(screen.getByRole('button',{name:'Add Anchored VWAP'}));fireEvent.click(screen.getByRole('button',{name:'Add Estimated volume profile'}));
 fireEvent.focus(screen.getByLabelText('VWAP 1 Observed-bar anchor'));
 const text=(name:string)=>{const select=screen.getByLabelText(name) as HTMLSelectElement;return select.selectedOptions[0].textContent;};
 expect(text('VWAP 1 Observed-bar anchor')).toMatch(/ UTC$/);
 expect(text('VOLUME_PROFILE 2 Range start')).toMatch(/ UTC$/);
 const before=settings();
 f.setBars(f.bars().map(bar=>({...bar,...(reason==='series'?{volumeEvidence:{...bar.volumeEvidence!,seriesIdentity:'b'.repeat(64)}}:{}),profileEvidence:{finality:'closed',clockAuthority:reason==='clock'?null:TRADE_VOLUME_AUTHORITY}})));
 fireEvent.focus(screen.getByLabelText('VOLUME_PROFILE 2 Range start'));
 expect(text('VWAP 1 Observed-bar anchor')).toContain('source clock (UTC unverified)');
 expect(text('VOLUME_PROFILE 2 Range start')).toContain('source clock (UTC unverified)');
 expect(text('VOLUME_PROFILE 2 Range end')).toContain('source clock (UTC unverified)');
 expect(settings()).toEqual(before);
});
