import {useState} from 'react';
import {render,screen,fireEvent,cleanup} from '@testing-library/react';
import {it,expect,afterEach} from 'vitest';
import {ChartStudyIntervalSettings} from './ChartStudyIntervalSettings';
import {CHART_INTERVALS,chartIntervalSeconds} from '@/lib/chart-engine/chartIntervals';
import {type ChartStudy} from '@/lib/chart-engine/chartStudies';
import {validatePreferences} from '@/lib/chart-engine/chartWorkspace';
const original:ChartStudy={kind:'rsi',id:'r',period:14,color:'#ffffff',lineStyles:[{visible:false}]};
function Workspace({timeframe='15m'}:{timeframe?:string}){
 const [config,setConfig]=useState(original);
 return <><ChartStudyIntervalSettings config={config} label="RSI 1" timeframe={timeframe} onChange={patch=>setConfig(prev=>validatePreferences({studies:[{...prev,...patch}]}).studies[0]!)}/><output data-testid="saved">{JSON.stringify(config)}</output></>;
}
const saved=()=>JSON.parse(screen.getByTestId('saved').textContent!);
afterEach(cleanup);
it('saves exact visibility choices without touching study mathematics or channel settings',()=>{
 render(<Workspace/>);
 fireEvent.click(screen.getByRole('button',{name:'RSI 1 Only current'}));
 expect(saved()).toEqual({...original,visibleIntervals:['M15']});
 expect((screen.getByLabelText('RSI 1 Visible on M15') as HTMLInputElement).checked).toBe(true);
 fireEvent.click(screen.getByLabelText('RSI 1 Visible on H1'));expect(saved().visibleIntervals).toEqual(['M15','H1']);
 fireEvent.click(screen.getByLabelText('RSI 1 Visible on M15'));expect(saved().visibleIntervals).toEqual(['H1']);
 expect(screen.getByText(/Hidden on M15/)).toBeTruthy();
 fireEvent.click(screen.getByRole('button',{name:'RSI 1 Hide on all'}));expect(saved().visibleIntervals).toEqual([]);
 fireEvent.click(screen.getByRole('button',{name:'RSI 1 All intervals'}));expect(saved()).toEqual(original);
});
it.each(['above','below'] as const)('selects current and %s using duration order',direction=>{
 render(<Workspace/>);fireEvent.click(screen.getByRole('button',{name:`RSI 1 Current and ${direction}`}));
 expect(saved().visibleIntervals).toEqual(CHART_INTERVALS.filter(i=>direction==='above'?chartIntervalSeconds(i)!>=900:chartIntervalSeconds(i)!<=900));
});
it.each(['invented','W1','MN1'])('does not invent current-interval restrictions for %s',timeframe=>{
 render(<Workspace timeframe={timeframe}/>);
 for(const name of ['Only current','Current and above','Current and below'])expect(screen.getByRole('button',{name:`RSI 1 ${name}`}).hasAttribute('disabled')).toBe(true);
 fireEvent.click(screen.getByRole('button',{name:'RSI 1 Hide on all'}));expect(saved().visibleIntervals).toEqual([]);
});
