import {registerChartLevelAssistant,requestChartLevels} from "@/lib/chart-engine/chartLevelAssistant";
import {StrictMode,useLayoutEffect} from 'react';
import {render,screen,fireEvent,cleanup} from '@testing-library/react';
import {afterEach,describe,it,expect,vi} from 'vitest';
import {AssistantDockProvider,AssistantDockSlot,useAssistantChartPane,useAssistantChartSelection,useChartActionDockTarget,useLocalChartAssistantReceiver} from './AssistantDock';
import {registerChartStudyAssistant,requestChartStudy} from '@/lib/chart-engine/chartStudyAssistant';
import {registerChartResearchAssistant,requestChartResearch} from '@/lib/chart-research/chartResearchAssistant';
import {registerChartFibonacciAssistant,requestChartFibonacci} from '@/lib/chart-engine/chartFibonacciAssistant';
const called=vi.fn(),retained:Array<()=>string>=[];
afterEach(()=>{cleanup();called.mockClear();retained.length=0;});
function Pane({symbol,keyValue,ready=true,primary=false}:{symbol:string;keyValue:string;ready?:boolean;primary?:boolean}){
 const pane=useAssistantChartPane({symbol,timeframe:'M15',source:'served-source',contextKey:keyValue,analysisOnly:!primary,ready});
 useLayoutEffect(()=>{if(!pane.active)return;const handle=()=>{if(!pane.isCurrent())return 'held';called(symbol);return symbol;};retained.push(handle);const a=registerChartStudyAssistant(handle),b=registerChartResearchAssistant(handle),c=registerChartFibonacciAssistant(handle),d=registerChartLevelAssistant(handle);return()=>{a();b();c();d();};},[pane.active,pane.isCurrent,symbol]);
 return <section data-testid={symbol}><button onClick={pane.activate} aria-pressed={pane.active}>Select {symbol}</button>{primary?<AssistantDockSlot assistantEnabled={pane.active}/>:pane.active?<AssistantDockSlot assistantOnly/>:null}</section>;
}
function Status(){const state=useAssistantChartSelection(),a=useChartActionDockTarget('assistant'),q=useChartActionDockTarget('quickActions'),s=useChartActionDockTarget('search');return <output data-testid="status">{state.selected?.symbol??'none'}|{String(state.remoteBlocked)}|{a?.closest('section')?.getAttribute('data-testid')}|{q?.closest('section')?.getAttribute('data-testid')}|{s?.closest('section')?.getAttribute('data-testid')}</output>;}
function App({keyValue='stock-a',stock=true,ready=true}:{keyValue?:string;stock?:boolean;ready?:boolean}){return <AssistantDockProvider><Pane symbol="EURUSD" keyValue="primary" primary/>{stock&&<Pane symbol="AAPL" keyValue={keyValue} ready={ready}/>}<Status/></AssistantDockProvider>;}
describe('explicit existing assistant pane ownership',()=>{
 it('delivers manual finding evidence only from its exact mounted pane and never falls back when receiver is absent',()=>{
  const delivered=vi.fn(()=>true),reads=vi.fn((key:string)=>`finding from ${key}`),senders:Array<()=>boolean>=[];
  function Receiver(){useLocalChartAssistantReceiver(delivered);return null;}
  function Manual({keyValue}:{keyValue:string}){const pane=useAssistantChartPane({symbol:'AAPL',timeframe:'M30',source:'fixture',contextKey:keyValue,analysisOnly:true,ready:true});const send=()=>pane.explainFinding(()=>reads(keyValue));senders.push(send);return <button onClick={send}>Explain manual finding</button>;}
  const app=(key:string,receiver=true)=><AssistantDockProvider><Manual keyValue={key}/>{receiver&&<Receiver/>}</AssistantDockProvider>;
  const view=render(app('source-a'));fireEvent.click(screen.getByText('Explain manual finding'));expect(delivered).toHaveBeenLastCalledWith('Explain this finding','finding from source-a');const old=senders.at(-1)!;
  view.rerender(app('source-b'));delivered.mockClear();reads.mockClear();expect(old()).toBe(false);expect(delivered).not.toHaveBeenCalled();expect(reads).not.toHaveBeenCalled();fireEvent.click(screen.getByText('Explain manual finding'));expect(delivered).toHaveBeenLastCalledWith('Explain this finding','finding from source-b');
  view.rerender(app('source-b',false));delivered.mockClear();reads.mockClear();fireEvent.click(screen.getByText('Explain manual finding'));expect(delivered).not.toHaveBeenCalled();expect(reads).not.toHaveBeenCalled();const removed=senders.at(-1)!;view.unmount();expect(removed()).toBe(false);
 });
 it('defaults only the initial primary and routes all local owners to explicit comparison with separated docks',()=>{
  render(<StrictMode><App/></StrictMode>);expect(screen.getByTestId('status').textContent).toBe('EURUSD|false|EURUSD|EURUSD|EURUSD');
  expect(requestChartStudy('show RSI')).toBe('EURUSD');called.mockClear();const old=retained.at(-1)!;
  fireEvent.click(screen.getByText('Select AAPL'));
  expect(screen.getByTestId('status').textContent).toBe('AAPL|true|AAPL|EURUSD|EURUSD');
  expect(old()).toBe('held');expect(requestChartStudy('show RSI')).toBe('AAPL');expect(requestChartResearch('Backtest EMA cross')).toBe('AAPL');expect(requestChartFibonacci('preview Fibonacci')).toBe('AAPL');expect(requestChartLevels('show support and resistance')).toBe('AAPL');expect(called.mock.calls).toEqual([['AAPL'],['AAPL'],['AAPL'],['AAPL']]);
 });
 it.each(['context','missing','removed'] as const)('withdraws selection on %s without silently substituting primary',change=>{
  const view=render(<App/>);fireEvent.click(screen.getByText('Select AAPL'));const old=retained.at(-1)!;
  view.rerender(<App keyValue={change==='context'?'stock-b':'stock-a'} ready={change!=='missing'} stock={change!=='removed'}/>);
  expect(screen.getByTestId('status').textContent).toBe('none|true||EURUSD|EURUSD');expect(old()).toBe('held');called.mockClear();expect(requestChartStudy('show RSI')).toMatch(/Select a ready/);expect(requestChartResearch('Backtest EMA cross')).toMatch(/Select a ready/);expect(requestChartFibonacci('preview Fibonacci')).toMatch(/Select a ready/);expect(requestChartLevels('show support and resistance')).toMatch(/Select a ready/);expect(called).not.toHaveBeenCalled();
  fireEvent.click(screen.getByText('Select EURUSD'));expect(requestChartStudy('show RSI')).toBe('EURUSD');expect(screen.getByTestId('status').textContent).toContain('EURUSD|false');
 });
 it('routes profile requests only to the explicitly selected pane and holds after its source changes',()=>{
  const view=render(<App/>);fireEvent.click(screen.getByText('Select AAPL'));const old=retained.at(-1)!;
  expect(requestChartStudy('show volume profile')).toBe('AAPL');expect(called.mock.calls).toEqual([['AAPL']]);
  view.rerender(<App keyValue="another-listing"/>);called.mockClear();expect(old()).toBe('held');expect(requestChartStudy('set volume profile rows to 48')).toContain('Select a ready');expect(called).not.toHaveBeenCalled();
 });
 it('holds loss followups after selected-pane source withdrawal instead of choosing primary',()=>{
  const view=render(<App/>);fireEvent.click(screen.getByText('Select AAPL'));
  expect(requestChartResearch('Why did this trade lose?')).toBe('AAPL');
  view.rerender(<App keyValue="another-listing"/>);called.mockClear();
  expect(requestChartResearch('Why did this trade lose?')).toContain('No other pane was substituted');expect(called).not.toHaveBeenCalled();
 });
 it('does not automatically reselect the initially selected primary after readiness is withdrawn and restored',()=>{
  const app=(ready:boolean)=><AssistantDockProvider><Pane symbol="EURUSD" keyValue="primary" primary ready={ready}/><Status/></AssistantDockProvider>;
  const view=render(app(true));expect(requestChartStudy('show RSI')).toBe('EURUSD');view.rerender(app(false));view.rerender(app(true));expect(requestChartStudy('show RSI')).toContain('Select a ready');fireEvent.click(screen.getByText('Select EURUSD'));expect(requestChartStudy('show RSI')).toBe('EURUSD');
 });

});
