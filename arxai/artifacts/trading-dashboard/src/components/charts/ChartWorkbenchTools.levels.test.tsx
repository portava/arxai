import {act,cleanup,fireEvent,render,screen} from '@testing-library/react';
import {afterEach,beforeEach,expect,it,vi} from 'vitest';
import {ChartWorkbenchTools} from './ChartWorkbenchTools';
import {DEFAULT_PREFERENCES,drawingStorageKey,validateDrawings,type ChartDrawing} from '@/lib/chart-engine/chartWorkspace';
import {proposeChartSupportResistance,levelProposalDrawings,type ChartSupportResistanceRead} from '@/lib/chart-engine/chartSupportResistance';
import {requestChartLevels} from '@/lib/chart-engine/chartLevelAssistant';
import type {ChartEngineAdapter} from '@/lib/chart-engine';
const start=1_800_000_000,prices=[10,11,15,12,11,7,10,11,16,12,11];
const bars=prices.map((p,i)=>({time:start+i*60,closeTime:start+(i+1)*60,open:p,high:p+1,low:p-1,close:p,isFinal:true,isComplete:true,isForming:false}));
const ready=()=>proposeChartSupportResistance({symbol:'EURUSD',timeframe:'M1',source:'mt5_broker',sourceIdentity:'a'.repeat(64),asOfMs:(start+660)*1000,bars},bars);
let read:ChartSupportResistanceRead,viewport:()=>void;
const draw=vi.fn(),interaction=vi.fn(),exportImage=vi.fn();
const engine={setDrawings:draw,setDrawingInteraction:interaction,exportImage,subscribeViewport:vi.fn(fn=>{viewport=fn;return()=>{};})} as unknown as ChartEngineAdapter;
const props={adapter:engine,epoch:1,symbol:'EURUSD',timeframe:'M1',preferences:DEFAULT_PREFERENCES,onPreferences:vi.fn(),hasCandles:true,feedLabel:'Offline',getSupportResistanceProposal:()=>read,assistantActive:true};
const key=drawingStorageKey('EURUSD','M1'),saved=()=>JSON.parse(localStorage.getItem(key)??'[]') as ChartDrawing[];
const ask=(text:string)=>{let result:string|null=null;act(()=>{result=requestChartLevels(text);});return result!;};
const manual:ChartDrawing={id:'mine',kind:'horizontal',start:{time:start,price:9},color:'#ffffff'};
beforeEach(()=>{localStorage.clear();vi.clearAllMocks();draw.mockImplementation(()=>{});read=ready();});afterEach(cleanup);
it('manual and assistant preview use the same real horizontal geometry without saving',()=>{
 render(<ChartWorkbenchTools {...props}/>);fireEvent.change(screen.getByLabelText('Drawing tool'),{target:{value:'auto_levels'}});const rows=draw.mock.calls.at(-1)![0];expect(rows.map((d:ChartDrawing)=>d.start.price)).toEqual([6,17]);
 fireEvent.click(screen.getByText('Dismiss level preview'));expect(ask('Show me support and resistance')).toContain('prepared');expect(draw.mock.calls.at(-1)![0]).toEqual(rows);expect(saved()).toEqual([]);
 expect(ask('explain support and resistance')).toContain('are applied');expect(ask('explain support and resistance')).toContain('source clock (UTC unverified)');
});
it('keeps one atomic editable pair, preserves prior drawings and undo, and repeated keeps do not duplicate',()=>{
 localStorage.setItem(key,JSON.stringify([manual]));render(<ChartWorkbenchTools {...props}/>);ask('show support and resistance');
 act(()=>{requestChartLevels('keep support and resistance');requestChartLevels('keep support and resistance');});expect(saved()).toHaveLength(3);expect(saved()[0]).toEqual(manual);expect(saved()[1].locked).toBe(false);
 fireEvent.change(screen.getByLabelText('Drawing 2 start price'),{target:{value:'8'}});fireEvent.blur(screen.getByLabelText('Drawing 2 start price'));expect(saved()[1].start.price).toBe(8);expect(saved()[1].pivotLevelOrigin!.level.price).toBe(6);
 ask('show support and resistance');expect(ask('keep support and resistance')).toContain('already kept');expect(saved()).toHaveLength(3);expect(saved()[1].start.price).toBe(8);
 expect(ask('explain selected resistance level')).toContain('Select the requested resistance object');expect(ask('explain selected support level')).toContain('current price 8');expect(ask('hide selected support level')).toContain('hidden');expect(saved()[1].hidden).toBe(true);expect(ask('show selected support level')).toContain('shown');expect(ask('remove selected support level')).toContain('removed');expect(saved()).toHaveLength(2);
 fireEvent.click(screen.getByRole('button',{name:'Undo',exact:true}));expect(saved()).toHaveLength(3);
});
it('does not save previews through drawing interactions or silently reveal hidden manual choices',()=>{
 localStorage.setItem(key,JSON.stringify([manual]));render(<ChartWorkbenchTools {...props}/>);ask('show support and resistance');const rows=draw.mock.calls.at(-1)![0];act(()=>interaction.mock.calls.at(-1)![0].onCommit(rows));expect(saved()).toEqual([manual]);
 ask('dismiss support and resistance preview');fireEvent.click(screen.getByText('Objects (1)'));fireEvent.click(screen.getByRole('button',{name:'Hide drawings',exact:true}));expect(ask('show support and resistance')).toContain('visibility is off');expect(draw.mock.calls.at(-1)![0]).toEqual([]);expect(saved()).toEqual([manual]);
});
it('withdraws on viewport/evidence changes and refuses stale keep/export without changing saved drawings',()=>{
 localStorage.setItem(key,JSON.stringify([manual]));render(<ChartWorkbenchTools {...props}/>);ask('show support and resistance');read={status:'unavailable',proposal:null,reason:'Source revoked'};act(()=>viewport());expect(draw.mock.calls.at(-1)![0]).toEqual([manual]);expect(screen.queryByLabelText('Support and resistance preview')).toBeNull();
 read=ready();ask('show support and resistance');if(read.status!=='ready')throw Error('fixture');read={...read,proposal:{...read.proposal,comparisonKey:'revised'}};expect(ask('keep support and resistance')).toContain('no longer matches');expect(saved()).toEqual([manual]);
 read=ready();ask('show support and resistance');read={status:'unavailable',proposal:null,reason:'Window changed'};fireEvent.click(screen.getByRole('button',{name:'Export PNG',exact:true}));expect(exportImage).not.toHaveBeenCalled();expect(saved()).toEqual([manual]);
});
it('refuses incomplete capacity and renderer failure instead of saving unseen or partial levels',()=>{
 localStorage.setItem(key,JSON.stringify(Array.from({length:39},(_,i)=>({...manual,id:'x'+i}))));const view=render(<ChartWorkbenchTools {...props}/>);expect(ask('show support and resistance')).toContain('Two drawing slots');expect(saved()).toHaveLength(39);view.unmount();localStorage.clear();
 draw.mockImplementation(rows=>{if(rows.length)throw Error('renderer failed');});render(<ChartWorkbenchTools {...props}/>);ask('show support and resistance');expect(ask('explain support and resistance')).toContain('visibility is not confirmed');expect(ask('keep support and resistance')).toContain('not visibly installed');expect(saved()).toEqual([]);
});
it('selected-pane authority is checked at invocation and unmount releases the owner',()=>{
 let current=true;const view=render(<ChartWorkbenchTools {...props} assistantIsCurrent={()=>current}/>);current=false;expect(ask('show support and resistance')).toContain('source changed');expect(saved()).toEqual([]);view.unmount();expect(requestChartLevels('show support and resistance')).toContain('No other pane');
});
it('strips impossible archived provenance while retaining the user annotation',()=>{
 const r=ready();if(r.status!=='ready')throw Error('fixture');const d=levelProposalDrawings(r.proposal,'kept',false)[0];expect(validateDrawings([d])[0]).toEqual(d);
 const bad={...d,pivotLevelOrigin:{...d.pivotLevelOrigin!,level:{...d.pivotLevelOrigin!.level,confirmedAt:start}}};expect(validateDrawings([bad])[0].pivotLevelOrigin).toBeUndefined();expect(validateDrawings([bad])[0].start).toEqual(d.start);
});
